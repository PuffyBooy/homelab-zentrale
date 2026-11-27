import { lstat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CleanupKind, CleanupPreviewData, RpcParams } from '@hz/shared';
import { hostPath, type HostContext } from '../host.js';
import { withHostLock } from './host-lock.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * system.cleanupPreview / system.cleanup.
 *
 * Measured (read-only, through the host root) and cleaned (host commands via nsenter):
 * - apt-cache:   *.deb in /var/cache/apt/archives + *.bin  -> `apt-get clean`
 * - old-kernels: kernels `apt-get -s autoremove` would remove (never the running
 *                one), size of /lib/modules, /boot and /usr/src for them
 *                -> `apt-get -y purge -- <those packages>`
 * - journal:     `journalctl --disk-usage` above 200 MB -> `journalctl --vacuum-size=200M`
 * - docker-images / docker-build-cache: Docker API (`df`, prune unused images, prune build cache)
 *
 * The package list for the purge is computed again on the agent at cleanup
 * time; nothing from the core ends up in a command line.
 *
 * M16: `items` picks the kinds to clean (default: all of them). Containers and
 * volumes are never removed (sleeping game servers are stopped containers).
 */

export const JOURNAL_KEEP_BYTES = 200 * 1024 * 1024;
const KERNEL_PKG_RE = /^linux-(image|modules|modules-extra|headers)-(\d[a-z0-9.+-]*)$/;
const MAX_WALK_ENTRIES = 200_000;

type Item = CleanupPreviewData['items'][number];

/** Total size of regular files below `dir` (no symlinks followed). */
export async function dirSize(dir: string, filter?: (name: string) => boolean): Promise<number> {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  for (let d = stack.pop(); d !== undefined && seen < MAX_WALK_ENTRIES; d = stack.pop()) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen += 1;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && (!filter || filter(e.name))) {
        try {
          total += (await lstat(p)).size;
        } catch {
          // vanished
        }
      }
    }
  }
  return total;
}

/** journalctl --disk-usage: "Archived and active journals take up 1.2G in the file system." */
export function parseJournalUsage(text: string): number | null {
  const m = /take up ([\d.]+)\s*([BKMGTP])/i.exec(text);
  if (!m?.[1] || !m[2]) return null;
  const units: Record<string, number> = { B: 0, K: 1, M: 2, G: 3, T: 4, P: 5 };
  const exp = units[m[2].toUpperCase()] ?? 0;
  return Math.round(Number(m[1]) * 1024 ** exp);
}

/** Kernel packages from `apt-get -s autoremove` output, excluding the running kernel. */
export function parseOldKernelPackages(
  simulation: string,
  runningKernel: string,
): { packages: string[]; versions: string[] } {
  const packages = new Set<string>();
  const versions = new Set<string>();
  for (const line of simulation.split('\n')) {
    const m = /^(?:Remv|Purg) (\S+)/.exec(line);
    const pkg = m?.[1];
    if (!pkg) continue;
    const k = KERNEL_PKG_RE.exec(pkg);
    if (!k?.[2]) continue;
    const ver = k[2].replace(/-unsigned$/, '');
    // Never the running kernel, also not its headers (5.15.0-88 vs 5.15.0-88-generic).
    if (runningKernel === ver || runningKernel.startsWith(`${ver}-`)) continue;
    packages.add(pkg);
    versions.add(ver);
  }
  return { packages: [...packages], versions: [...versions] };
}

async function aptCacheBytes(ctx: HostContext): Promise<number | null> {
  const dir = hostPath(ctx, '/var/cache/apt');
  try {
    await lstat(dir);
  } catch {
    return null;
  }
  const debs = await dirSize(path.join(dir, 'archives'), (n) => n.endsWith('.deb'));
  const bins = await dirSize(dir, (n) => n.endsWith('.bin'));
  return debs + bins;
}

async function oldKernels(ctx: HostContext) {
  const r = await ctx.exec('apt-get', ['-s', '-q', 'autoremove', '--purge'], { timeoutMs: 60_000 });
  if (r.code !== 0) return null;
  const found = parseOldKernelPackages(r.stdout, os.release());
  let bytes = 0;
  for (const ver of found.versions) {
    bytes += await dirSize(hostPath(ctx, `/lib/modules/${ver}`));
    bytes += await dirSize(hostPath(ctx, '/boot'), (n) => n.endsWith(`-${ver}`));
    bytes += await dirSize(hostPath(ctx, `/usr/src/linux-headers-${ver}`));
  }
  return { ...found, bytes };
}

async function journalBytes(ctx: HostContext): Promise<number | null> {
  const r = await ctx.exec('journalctl', ['--disk-usage'], { timeoutMs: 30_000 });
  if (r.code !== 0) return null;
  return parseJournalUsage(r.stdout);
}

interface DockerDf {
  Images?: { Containers?: number; Size?: number; SharedSize?: number }[];
  BuildCache?: { InUse?: boolean; Size?: number }[];
}

async function dockerBytes(ctx: HostContext): Promise<{ images: number; build: number } | null> {
  if (!ctx.docker) return null;
  try {
    const df = (await ctx.docker.df()) as DockerDf;
    let images = 0;
    for (const img of df.Images ?? []) {
      if (img.Containers !== 0) continue;
      const shared = img.SharedSize && img.SharedSize > 0 ? img.SharedSize : 0;
      images += Math.max(0, (img.Size ?? 0) - shared);
    }
    let build = 0;
    for (const b of df.BuildCache ?? []) if (!b.InUse) build += Math.max(0, b.Size ?? 0);
    return { images, build };
  } catch {
    return null;
  }
}

const GB = (n: number) => `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;

export async function cleanupPreview(
  _p: unknown,
  actx: ActionContext,
): Promise<CleanupPreviewData> {
  const ctx = actx.host;
  const [apt, kernels, journal, docker] = await Promise.all([
    aptCacheBytes(ctx),
    oldKernels(ctx),
    journalBytes(ctx),
    dockerBytes(ctx),
  ]);
  const items: Item[] = [];
  if (apt !== null) items.push({ kind: 'apt-cache', bytes: apt });
  if (kernels !== null) {
    items.push({
      kind: 'old-kernels',
      bytes: kernels.bytes,
      detail: (kernels.versions.join(', ') || 'keine').slice(0, 200),
    });
  }
  if (journal !== null) {
    items.push({
      kind: 'journal',
      bytes: Math.max(0, journal - JOURNAL_KEEP_BYTES),
      detail: `${GB(journal)} belegt, 200 MB bleiben`,
    });
  }
  if (docker !== null) {
    items.push({ kind: 'docker-images', bytes: docker.images });
    items.push({ kind: 'docker-build-cache', bytes: docker.build });
  }
  return { items, totalBytes: items.reduce((s, i) => s + i.bytes, 0) };
}

export const ALL_CLEANUP_KINDS: readonly CleanupKind[] = [
  'apt-cache',
  'old-kernels',
  'journal',
  'docker-images',
  'docker-build-cache',
];

export function cleanup(
  p: RpcParams<'system.cleanup'>,
  actx: ActionContext,
): Promise<{ freedBytes: number }> {
  const kinds = new Set<CleanupKind>(p.items ?? ALL_CLEANUP_KINDS);
  return withHostLock('cleanup', () => runCleanup(actx, kinds));
}

async function runCleanup(
  actx: ActionContext,
  kinds: ReadonlySet<CleanupKind>,
): Promise<{ freedBytes: number }> {
  const ctx = actx.host;
  let freed = 0;
  let anything = false;

  const aptBefore = kinds.has('apt-cache') ? await aptCacheBytes(ctx) : null;
  if (aptBefore !== null) {
    const r = await ctx.exec('apt-get', ['clean'], { timeoutMs: 120_000 });
    if (r.code === 0) {
      anything = true;
      freed += Math.max(0, aptBefore - ((await aptCacheBytes(ctx)) ?? 0));
    } else actx.log.warn('apt-get clean failed', { code: r.code, error: r.error });
  }

  const kernels = kinds.has('old-kernels') ? await oldKernels(ctx) : null;
  // Measurable but nothing to do still counts as "cleaned" (0 bytes).
  if (kernels && kernels.packages.length === 0) anything = true;
  if (kernels && kernels.packages.length > 0) {
    const r = await ctx.exec('apt-get', ['-y', '-q', 'purge', '--', ...kernels.packages], {
      timeoutMs: 15 * 60_000,
    });
    if (r.code === 0) {
      anything = true;
      freed += kernels.bytes;
    } else actx.log.warn('kernel purge failed', { code: r.code, error: r.error });
  }

  const journalBefore = kinds.has('journal') ? await journalBytes(ctx) : null;
  if (journalBefore !== null && journalBefore <= JOURNAL_KEEP_BYTES) anything = true;
  if (journalBefore !== null && journalBefore > JOURNAL_KEEP_BYTES) {
    const r = await ctx.exec('journalctl', ['--vacuum-size=200M'], { timeoutMs: 120_000 });
    if (r.code === 0) {
      anything = true;
      freed += Math.max(0, journalBefore - ((await journalBytes(ctx)) ?? journalBefore));
    }
  }

  // Only images and the build cache; never containers or volumes.
  if (ctx.docker && kinds.has('docker-images')) {
    try {
      const r = await ctx.docker.pruneImages({ filters: { dangling: ['false'] } });
      freed += Math.max(0, r.SpaceReclaimed ?? 0);
      anything = true;
    } catch {
      actx.log.warn('docker image prune failed');
    }
  }
  if (ctx.docker && kinds.has('docker-build-cache')) {
    try {
      const b = await ctx.docker.pruneBuilder();
      freed += Math.max(0, b.SpaceReclaimed ?? 0);
      anything = true;
    } catch {
      actx.log.warn('docker build cache prune failed');
    }
  }

  if (!anything) throw new ActionError('failed', 'nothing could be cleaned on this host');
  return { freedBytes: freed };
}

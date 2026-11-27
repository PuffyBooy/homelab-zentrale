import { lstat, readlink, statfs } from 'node:fs/promises';
import path from 'node:path';
import { DU_DENIED_ROOTS } from '@hz/shared';
import { hostPath, type HostContext } from './host.js';

/**
 * Resolves symlinks of a host path *inside the host's root file system*.
 *
 * In the container the host root is /host/proc/1/root. Node's realpath() cannot
 * be used there: realpath(3) reads the magic link /proc/1/root itself and would
 * then resolve an absolute symlink target (/var/x -> /proc) against the agent's
 * own root, not the host's. So every component is walked here with lstat and
 * readlink below the host root; absolute targets restart at the host's `/`,
 * `..` never climbs above it. The result is the canonical host path (as the
 * host sees it, without the host-root prefix).
 */

const MAX_LINKS = 40;

export type HostResolve = { ok: true; path: string } | { ok: false; reason: string };

export async function resolveHostPath(
  ctx: Pick<HostContext, 'hostRoot'>,
  input: string,
): Promise<HostResolve> {
  if (!input.startsWith('/') || input.includes('\0')) return { ok: false, reason: 'invalid path' };
  let pending = input.split('/').filter((s) => s !== '');
  const resolved: string[] = [];
  let links = 0;
  while (pending.length > 0) {
    const seg = pending.shift() as string;
    if (seg === '.') continue;
    if (seg === '..') {
      resolved.pop();
      continue;
    }
    const candidate = `/${[...resolved, seg].join('/')}`;
    let st;
    try {
      st = await lstat(hostPath(ctx, candidate));
    } catch {
      return { ok: false, reason: 'path not found' };
    }
    if (!st.isSymbolicLink()) {
      resolved.push(seg);
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) return { ok: false, reason: 'too many symlinks' };
    let target: string;
    try {
      target = await readlink(hostPath(ctx, candidate));
    } catch {
      return { ok: false, reason: 'path not accessible' };
    }
    if (target.includes('\0')) return { ok: false, reason: 'invalid symlink' };
    if (target.startsWith('/')) resolved.length = 0;
    pending = [...target.split('/').filter((s) => s !== ''), ...pending];
  }
  return { ok: true, path: `/${resolved.join('/')}` };
}

/** True when `p` is one of DU_DENIED_ROOTS or below one. */
export function isDeniedDuPath(p: string): boolean {
  return DU_DENIED_ROOTS.some((r) => p === r || p.startsWith(`${r}/`));
}

/**
 * Pseudo file systems du never reads, whatever path they are mounted at
 * (statfs f_type, linux/magic.h): proc, sysfs, devpts, cgroup, cgroup2, debugfs,
 * tracefs, securityfs, bpf, pstore, efivarfs, configfs, fusectl.
 */
export const DENIED_FS_TYPES = new Set([
  0x9fa0, 0x62656572, 0x1cd1, 0x27e0eb, 0x63677270, 0x64626720, 0x74726163, 0x73636673, 0xcafe4a11,
  0x6165676c, 0xde5e81e4, 0x62656570, 0x65735543,
]);

/**
 * The full check for system.du: resolve inside the host root, refuse the
 * denied roots after resolving, require a directory on a real file system.
 */
export async function resolveDuPath(
  ctx: Pick<HostContext, 'hostRoot'>,
  input: string,
): Promise<HostResolve> {
  if (isDeniedDuPath(input)) return { ok: false, reason: 'path not allowed' };
  const r = await resolveHostPath(ctx, input);
  if (!r.ok) return r;
  if (isDeniedDuPath(r.path)) return { ok: false, reason: 'path not allowed (after symlinks)' };
  const real = hostPath(ctx, r.path);
  try {
    const st = await lstat(real);
    if (!st.isDirectory()) return { ok: false, reason: 'not a directory' };
    const fs = await statfs(real);
    if (DENIED_FS_TYPES.has(Number(fs.type))) {
      return { ok: false, reason: 'path not allowed (pseudo file system)' };
    }
  } catch {
    return { ok: false, reason: 'path not accessible' };
  }
  return { ok: true, path: path.posix.normalize(r.path) };
}

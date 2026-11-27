import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { duDataSchema, type DuData, type RpcParams } from '@hz/shared';
import { isMissingProgram } from '../exec.js';
import { hostPath } from '../host.js';
import { resolveDuPath } from '../host-resolve.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * system.du ("größte Ordner"): sizes of the direct children of one host directory.
 *
 * - The path passed hostDirPathSchema in the dispatcher; here it is resolved again
 *   inside the host root (host-resolve.ts) and re-checked against DU_DENIED_ROOTS
 *   and pseudo file systems, so a symlink /var/x -> /proc is refused (bad_path).
 * - `du -x -a -B1 -d1 -0 -- <path>` on the host: stays on the file system of the
 *   path (-x), lists files too (-a, a 20 GB file at depth 1 is a "largest entry"),
 *   bytes (-B1), NUL-terminated lines (-0, names may contain newlines). Read-only.
 * - 60 s timeout (then `timeout`), 8 MiB output cap.
 */

export const DU_TIMEOUT_MS = 60_000;
export const DU_MAX_OUTPUT = 8 * 1024 * 1024;
export const DU_MAX_ENTRIES = 30;

export interface DuLine {
  bytes: number;
  path: string;
}

/** Parses NUL-terminated `du -B1 -0` records ("<bytes>\t<path>"). Bad records are skipped. */
export function parseDuOutput(out: string): DuLine[] {
  const lines: DuLine[] = [];
  for (const rec of out.split('\0')) {
    const r = rec.replace(/^\n+/, '');
    const tab = r.indexOf('\t');
    if (tab <= 0) continue;
    const num = r.slice(0, tab);
    if (!/^\d+$/.test(num)) continue;
    const bytes = Number(num);
    const p = r.slice(tab + 1);
    if (!Number.isSafeInteger(bytes) || p === '') continue;
    lines.push({ bytes, path: p });
  }
  return lines;
}

/**
 * Builds the result: the record for `dir` itself is the total, every other
 * record directly below `dir` is a child (basename only). Largest first.
 */
export function summarizeDu(
  dir: string,
  lines: DuLine[],
): { totalBytes: number; children: { name: string; bytes: number }[] } {
  let totalBytes = 0;
  const children: { name: string; bytes: number }[] = [];
  for (const l of lines) {
    const p = l.path.length > 1 ? l.path.replace(/\/+$/, '') : l.path;
    if (p === dir) {
      totalBytes = l.bytes;
      continue;
    }
    if (path.posix.dirname(p) !== dir) continue;
    const name = path.posix.basename(p);
    if (name === '' || name.length > 255) continue;
    children.push({ name, bytes: l.bytes });
  }
  children.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  if (totalBytes === 0) totalBytes = children.reduce((s, c) => s + c.bytes, 0);
  return { totalBytes, children };
}

export async function systemDu(
  params: RpcParams<'system.du'>,
  ctx: ActionContext,
): Promise<DuData> {
  const check = await resolveDuPath(ctx.host, params.path);
  if (!check.ok) throw new ActionError('bad_path', `path: ${check.reason}`);
  const dir = check.path;
  const r = await ctx.host.exec('du', ['-x', '-a', '-B1', '-d1', '-0', '--', dir], {
    timeoutMs: DU_TIMEOUT_MS,
    maxBuffer: DU_MAX_OUTPUT,
  });
  if (r.error === 'timeout') throw new ActionError('timeout', 'du took longer than 60 s', false);
  if (r.error === 'output_too_large') {
    throw new ActionError('failed', 'directory has too many entries', false);
  }
  if (isMissingProgram(r)) throw new ActionError('failed', 'du not available on the host', false);
  // du exits 1 when single entries were unreadable but still prints the rest.
  const lines = parseDuOutput(r.stdout);
  if (lines.length === 0 || (r.code !== 0 && r.code !== 1)) {
    throw new ActionError('failed', 'du failed', false);
  }
  const { totalBytes, children } = summarizeDu(dir, lines);
  const top = children.slice(0, DU_MAX_ENTRIES);
  const entries = await Promise.all(
    top.map(async (c) => {
      let isDir = false;
      try {
        isDir = (await lstat(hostPath(ctx.host, path.posix.join(dir, c.name)))).isDirectory();
      } catch {
        // vanished meanwhile
      }
      return { name: c.name, bytes: c.bytes, dir: isDir };
    }),
  );
  return duDataSchema.parse({
    path: dir,
    totalBytes,
    entries,
    truncated: children.length > DU_MAX_ENTRIES,
  });
}

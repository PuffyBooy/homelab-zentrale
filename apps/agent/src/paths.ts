import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { HOMELAB_ROOT } from '@hz/shared';

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

function withSlash(p: string): string {
  return p.endsWith('/') ? p : `${p}/`;
}

/**
 * Resolves a path that must live strictly below the homelab root (/opt/homelab/).
 *
 * - The path must be absolute, normalized and start with the root.
 * - Symlinks are resolved with realpath. For paths that do not exist yet, the
 *   nearest existing parent is resolved and the missing rest is appended.
 * - A dangling symlink anywhere in the path is rejected (writing through it
 *   could create a file outside the root).
 * - The root itself is resolved too, so /opt/homelab may be a symlink.
 *
 * Returns the resolved real path. Callers must use that path, not the input.
 * `root` is only overridden by tests.
 */
export async function resolveHomelabPath(input: unknown, root = HOMELAB_ROOT): Promise<PathCheck> {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512) {
    return { ok: false, reason: 'invalid path' };
  }
  if (input.includes('\0')) return { ok: false, reason: 'NUL in path' };
  if (!path.isAbsolute(input)) return { ok: false, reason: 'path must be absolute' };
  const rootSlash = withSlash(path.resolve(root));
  const normalized = path.resolve(input);
  if (!withSlash(normalized).startsWith(rootSlash) || withSlash(normalized) === rootSlash) {
    return { ok: false, reason: 'path must be below the homelab root' };
  }

  let realRoot: string;
  try {
    realRoot = withSlash(await realpath(rootSlash));
  } catch {
    return { ok: false, reason: 'homelab root missing' };
  }

  // Walk up until an existing entry is found.
  const missing: string[] = [];
  let current = normalized;
  for (;;) {
    let exists = false;
    try {
      await lstat(current);
      exists = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, reason: 'path not accessible' };
      }
    }
    if (exists) break;
    const parent = path.dirname(current);
    if (parent === current) return { ok: false, reason: 'path not accessible' };
    missing.unshift(path.basename(current));
    current = parent;
  }

  let real: string;
  try {
    real = await realpath(current);
  } catch {
    // lstat saw an entry but realpath failed: dangling or looping symlink.
    return { ok: false, reason: 'dangling symlink in path' };
  }
  const resolved = missing.length > 0 ? path.join(real, ...missing) : real;
  if (!withSlash(resolved).startsWith(realRoot) || withSlash(resolved) === realRoot) {
    return { ok: false, reason: 'path escapes the homelab root' };
  }
  return { ok: true, path: resolved };
}

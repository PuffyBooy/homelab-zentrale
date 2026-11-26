import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { RpcParams } from '@hz/shared';
import { acquireDirLock } from './dir-lock.js';
import { backupFilePattern } from './game-backup.js';
import { GAME_NAME } from './game-common.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * game.backups.purge: deletes the backups of one game that are older than N days.
 *
 * Scope: only /opt/homelab/backups/<gameId>/ (the folder game.backup writes into).
 * - gameId must match GAME_NAME (no `/`, no `..`), checked here again on top of the schema.
 * - The homelab root is resolved with realpath; backups/ and backups/<gameId>/ must be
 *   real directories at exactly that place (lstat + realpath, no symlinks).
 * - Only entries named like the agent's own archives (`<gameId>-YYYYMMDD-HHMMSS.tar.zst`)
 *   that are regular files (lstat: no symlinks, directories, FIFOs, sockets, devices)
 *   with an mtime older than `olderThanDays` days are unlinked. unlink never follows a
 *   symlink, so a swap between lstat and unlink cannot reach outside.
 * - Temp files of a running backup (`.<name>-….partial`) are never touched; the per-game
 *   lock (the same key game.backup takes) keeps a backup from running at the same time.
 * - If the folder is empty afterwards it is removed (rmdir, never recursive).
 *
 * No program is started. A game without a backup folder yields { removed: 0 }.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Real directory at exactly `p` (no symlink anywhere in its last component or above). */
async function realDirAt(p: string): Promise<'missing' | 'ok'> {
  const st = await lstat(p).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw new ActionError('failed', 'backup folder not accessible', false);
  });
  if (!st) return 'missing';
  const real = await realpath(p).catch(() => null);
  if (!st.isDirectory() || real !== p) {
    throw new ActionError('bad_path', 'backup folder must be a real directory');
  }
  return 'ok';
}

export async function gameBackupsPurge(
  params: RpcParams<'game.backups.purge'>,
  ctx: ActionContext,
  now: () => number = () => Date.now(),
): Promise<{ removed: number }> {
  const { gameId, olderThanDays } = params;
  if (typeof gameId !== 'string' || !GAME_NAME.test(gameId)) {
    throw new ActionError('bad_path', 'invalid game id');
  }
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650) {
    throw new ActionError('invalid_params', 'olderThanDays out of range');
  }

  let root: string;
  try {
    root = await realpath(ctx.homelabRoot);
  } catch {
    throw new ActionError('bad_path', 'homelab root missing');
  }
  const base = path.join(root, 'backups');
  const dir = path.join(base, gameId);
  // Defense in depth: the joined path must be exactly one level below backups/.
  if (path.dirname(dir) !== base || path.basename(dir) !== gameId) {
    throw new ActionError('bad_path', 'invalid game id');
  }

  // Same key as game.backup (resolveGameDir returns <realRoot>/games/<name>).
  const release = acquireDirLock(path.join(root, 'games', gameId));
  try {
    if ((await realDirAt(base)) === 'missing') return { removed: 0 };
    if ((await realDirAt(dir)) === 'missing') return { removed: 0 };

    const cutoff = now() - olderThanDays * DAY_MS;
    const re = backupFilePattern(gameId);
    let removed = 0;
    const entries = await readdir(dir).catch(() => {
      throw new ActionError('failed', 'reading the backup folder failed', false);
    });
    for (const f of entries) {
      if (!re.test(f)) continue;
      const p = path.join(dir, f);
      const st = await lstat(p).catch(() => null);
      if (!st?.isFile()) continue;
      if (st.mtimeMs >= cutoff) continue;
      try {
        await unlink(p);
        removed++;
      } catch {
        // Gone already or not deletable; the next purge tries again.
      }
    }

    const left = await readdir(dir).catch(() => null);
    if (left && left.length === 0) {
      // Not recursive: fails harmlessly if something appeared in between.
      await rmdir(dir).catch(() => undefined);
    }
    if (removed > 0) ctx.log.info('purged old backups', { game: gameId, removed });
    return { removed };
  } finally {
    release();
  }
}

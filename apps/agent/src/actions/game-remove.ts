import { randomBytes } from 'node:crypto';
import { lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { RpcParams } from '@hz/shared';
import {
  COMPOSE_FILE_NAMES,
  composeArgs,
  composeEnv,
  COMPOSE_TIMEOUTS,
  composeTarget,
  tail,
} from './compose.js';
import { withDirLock } from './dir-lock.js';
import { resolveGameDir } from './game-common.js';
import { assertNotProtected, assertProjectNotProtected, type ProtectDocker } from './protected.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * game.remove: `docker compose down --remove-orphans --volumes`, then delete the folder.
 *
 * - Only /opt/homelab/games/<name>/ (exactly one level, after realpath).
 * - Refused if the project contains the agent or the core container.
 * - If compose down fails, nothing is deleted (the server may still run).
 * - The folder is first renamed to games/.<name>.removing-<hex> (so a half-deleted
 *   folder never looks like a game), then deleted bottom-up: symlinks are unlinked,
 *   never followed, and every entry must be on the same file system as the folder
 *   (a mount point inside aborts the removal).
 * - /opt/homelab/backups/<name>/ is not touched.
 */

/** Deletes `p` recursively without following symlinks and without leaving device `dev`. */
export async function removeTree(p: string, dev: number): Promise<void> {
  const st = await lstat(p);
  if (st.dev !== dev) throw new ActionError('failed', 'another file system is mounted inside');
  if (st.isDirectory()) {
    for (const entry of await readdir(p)) await removeTree(path.join(p, entry), dev);
    await rmdir(p);
  } else {
    await unlink(p);
  }
}

async function hasComposeFile(dir: string): Promise<boolean> {
  for (const n of COMPOSE_FILE_NAMES) {
    if (await lstat(path.join(dir, n)).catch(() => null)) return true;
  }
  return false;
}

export async function gameRemove(
  params: RpcParams<'game.remove'>,
  ctx: ActionContext,
): Promise<{ removed: true }> {
  const game = await resolveGameDir(params.gameDir, ctx.homelabRoot);
  const docker = ctx.host.docker as unknown as ProtectDocker | null;
  if (docker) {
    await assertProjectNotProtected(docker, game.dir);
    await assertNotProtected(docker, `game-${game.name}`);
  }
  return withDirLock(game.dir, async () => {
    if (await hasComposeFile(game.dir)) {
      const target = await composeTarget(
        game.dir,
        ctx.homelabRoot,
        docker as Parameters<typeof composeTarget>[2],
      );
      const r = await ctx.run(
        'docker',
        composeArgs('remove', game.dir, target.files, target.project),
        {
          timeoutMs: COMPOSE_TIMEOUTS.remove,
          env: composeEnv(ctx.dockerSocket),
        },
      );
      if (r.error === 'not_found') throw new ActionError('failed', 'docker cli not available');
      if (r.error === 'timeout') throw new ActionError('timeout', 'compose down timed out');
      if (r.code !== 0) {
        const last = tail(r.stderr || r.stdout, 300);
        throw new ActionError('failed', `compose down failed${last ? `: ${last}` : ''}`);
      }
    }

    // Check again right before deleting: nothing may have been swapped in meanwhile.
    const again = await resolveGameDir(game.dir, ctx.homelabRoot);
    if (again.dir !== game.dir) throw new ActionError('bad_path', 'gameDir changed meanwhile');
    const st = await lstat(game.dir);
    const trash = path.join(
      path.dirname(game.dir),
      `.${game.name}.removing-${randomBytes(4).toString('hex')}`,
    );
    try {
      await rename(game.dir, trash);
    } catch {
      throw new ActionError('failed', 'removing the game folder failed');
    }
    try {
      await removeTree(trash, st.dev);
    } catch (err) {
      if (err instanceof ActionError) throw err;
      throw new ActionError('failed', 'removing the game folder failed');
    }
    return { removed: true as const };
  });
}

import { randomBytes } from 'node:crypto';
import { lstat, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { appIdSchema, type RpcParams } from '@hz/shared';
import { resolveHomelabPath } from '../paths.js';
import {
  COMPOSE_FILE_NAMES,
  composeArgs,
  composeEnv,
  COMPOSE_TIMEOUTS,
  composeTarget,
  tail,
} from './compose.js';
import { withDirLock } from './dir-lock.js';
import { removeTree } from './game-remove.js';
import { assertProjectNotProtected, type ProtectDocker } from './protected.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * app.remove (M21): `docker compose down --remove-orphans` (never `-v`) in
 * /opt/homelab/apps/<appId>/ and, with deleteData, deletion of that folder.
 *
 * - The folder is built from the validated appId; apps/ and apps/<appId>/ must be real
 *   directories (a symlink -> bad_path), exactly one level below apps/ after realpath.
 * - Refused if the compose project contains a container with the label hz.role
 *   (agent, core); those are never touched.
 * - If compose down fails, nothing is deleted.
 * - Deletion: rename to apps/.<appId>.removing-<hex>, then bottom-up without following
 *   symlinks and without crossing into another file system (removeTree, as game.remove).
 * - Missing folder = success ({removed: false}). `removed` is true when the folder
 *   was deleted.
 */

export const APPS_DIR = 'apps';

async function hasComposeFile(dir: string): Promise<boolean> {
  for (const n of COMPOSE_FILE_NAMES) {
    if (await lstat(path.join(dir, n)).catch(() => null)) return true;
  }
  return false;
}

async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ActionError('bad_path', 'path not accessible');
  }
}

/** Real path of apps/<appId>, or null when it does not exist. */
async function resolveAppDir(appId: string, homelabRoot: string): Promise<string | null> {
  if (!appIdSchema.safeParse(appId).success) throw new ActionError('bad_path', 'invalid appId');
  let root: string;
  try {
    root = await realpath(homelabRoot);
  } catch {
    throw new ActionError('bad_path', 'homelab root missing');
  }
  const appsRoot = path.join(root, APPS_DIR);
  const ast = await lstatOrNull(appsRoot);
  if (!ast) return null;
  if (ast.isSymbolicLink() || !ast.isDirectory()) {
    throw new ActionError('bad_path', 'apps folder is not a directory');
  }
  const dir = path.join(appsRoot, appId);
  const st = await lstatOrNull(dir);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new ActionError('bad_path', 'app folder is not a directory');
  }
  const check = await resolveHomelabPath(dir, homelabRoot);
  if (!check.ok || check.path !== dir || path.dirname(check.path) !== appsRoot) {
    throw new ActionError('bad_path', 'app folder must be /opt/homelab/apps/<appId>');
  }
  return dir;
}

export async function appRemove(
  p: RpcParams<'app.remove'>,
  ctx: ActionContext,
): Promise<{ removed: boolean }> {
  const dir = await resolveAppDir(p.appId, ctx.homelabRoot);
  if (dir === null) return { removed: false };
  const docker = ctx.host.docker as unknown as ProtectDocker | null;
  if (docker) await assertProjectNotProtected(docker, dir);

  return withDirLock(dir, async () => {
    if (await hasComposeFile(dir)) {
      const target = await composeTarget(
        dir,
        ctx.homelabRoot,
        docker as Parameters<typeof composeTarget>[2],
      );
      // `down` = down --remove-orphans; named volumes stay (never -v).
      const r = await ctx.run('docker', composeArgs('down', dir, target.files, target.project), {
        timeoutMs: COMPOSE_TIMEOUTS.down,
        env: composeEnv(ctx.dockerSocket),
      });
      if (r.error === 'not_found') throw new ActionError('failed', 'docker cli not available');
      if (r.error === 'timeout') throw new ActionError('timeout', 'compose down timed out');
      if (r.code !== 0) {
        const last = tail(r.stderr || r.stdout, 300);
        throw new ActionError('failed', `compose down failed${last ? `: ${last}` : ''}`);
      }
    }
    if (!p.deleteData) {
      ctx.log.info('app stopped for removal', { appId: p.appId });
      return { removed: false };
    }

    // Check again right before deleting: nothing may have been swapped in meanwhile.
    const again = await resolveAppDir(p.appId, ctx.homelabRoot);
    if (again !== dir) throw new ActionError('bad_path', 'app folder changed meanwhile');
    const st = await lstat(dir);
    const trash = path.join(
      path.dirname(dir),
      `.${p.appId}.removing-${randomBytes(4).toString('hex')}`,
    );
    try {
      await rename(dir, trash);
    } catch {
      throw new ActionError('failed', 'removing the app folder failed');
    }
    try {
      await removeTree(trash, st.dev);
    } catch (err) {
      if (err instanceof ActionError) throw err;
      throw new ActionError('failed', 'removing the app folder failed');
    }
    ctx.log.info('app removed', { appId: p.appId });
    return { removed: true };
  });
}

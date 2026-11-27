import type { RpcParams } from '@hz/shared';
import { dockerOf, statusOf } from './docker-common.js';
import { assertNotProtected, type ProtectDocker } from './protected.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * container.remove: `docker rm [-v] <id>` of a stopped container, never forced.
 *
 * - The agent, the core and the updater helper are refused (`not_allowed`).
 * - running / restarting / paused: `busy` (the admin stops it first).
 * - removeVolumes deletes the container's anonymous volumes only (Docker's `v`);
 *   named volumes are never touched by this action.
 */

interface RemoveDocker extends ProtectDocker {
  getContainer(id: string): {
    inspect(): Promise<unknown>;
    remove(opts: { v: boolean; force: boolean }): Promise<unknown>;
  };
}

interface StateInspect {
  State?: { Running?: boolean; Restarting?: boolean; Paused?: boolean; Status?: string } | null;
}

export async function containerRemove(
  params: RpcParams<'container.remove'>,
  ctx: ActionContext,
): Promise<null> {
  const docker = dockerOf<RemoveDocker>(ctx);
  await assertNotProtected(docker, params.id);
  const c = docker.getContainer(params.id);
  let info: StateInspect;
  try {
    info = (await c.inspect()) as StateInspect;
  } catch (err) {
    if (statusOf(err) === 404) throw new ActionError('not_found', 'container not found', false);
    throw new ActionError('failed', 'container inspect failed', false);
  }
  const st = info.State;
  if (st?.Running || st?.Restarting || st?.Paused) {
    throw new ActionError('busy', 'container is running, stop it first', false);
  }
  try {
    await c.remove({ v: params.removeVolumes, force: false });
  } catch (err) {
    const status = statusOf(err);
    if (status === 404) throw new ActionError('not_found', 'container not found', false);
    if (status === 409) throw new ActionError('busy', 'container is in use', false);
    throw new ActionError('failed', 'container remove failed', false);
  }
  ctx.log.info('container removed', {
    container: params.id.slice(0, 64),
    removeVolumes: params.removeVolumes,
  });
  return null;
}

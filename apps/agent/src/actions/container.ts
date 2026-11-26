import type { RpcParams } from '@hz/shared';
import { ActionError, type ActionContext } from './types.js';

type Op = 'start' | 'stop' | 'restart';

async function containerOp(op: Op, params: RpcParams<'container.start'>, ctx: ActionContext) {
  const docker = ctx.host.docker;
  if (!docker) throw new ActionError('failed', 'docker not available');
  const c = docker.getContainer(params.id);
  try {
    if (op === 'start') await c.start();
    else if (op === 'stop') await c.stop({ t: 30 });
    else await c.restart({ t: 30 });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    // 304: already started / already stopped.
    if (status === 304) return { changed: false };
    if (status === 404) throw new ActionError('not_found', 'container not found');
    throw new ActionError('failed', `container ${op} failed`);
  }
  return { changed: true };
}

export const containerStart = (p: RpcParams<'container.start'>, ctx: ActionContext) =>
  containerOp('start', p, ctx);
export const containerStop = (p: RpcParams<'container.stop'>, ctx: ActionContext) =>
  containerOp('stop', p, ctx);
export const containerRestart = (p: RpcParams<'container.restart'>, ctx: ActionContext) =>
  containerOp('restart', p, ctx);

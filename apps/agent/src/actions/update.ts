import type { RpcParams } from '@hz/shared';
import { ActionError, type ActionContext } from './types.js';

/** M17 update.check / update.apply; the work happens in src/update/service.ts. */

function service(ctx: ActionContext) {
  if (!ctx.updates) throw new ActionError('failed', 'docker not available', false);
  return ctx.updates;
}

export async function updateCheck(params: RpcParams<'update.check'>, ctx: ActionContext) {
  return service(ctx).check(params.target);
}

export async function updateApply(params: RpcParams<'update.apply'>, ctx: ActionContext) {
  return service(ctx).apply(params.target, params.runId);
}

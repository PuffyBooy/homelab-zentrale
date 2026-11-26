import type { FastifyPluginAsync } from 'fastify';
import {
  serverIdParamsSchema,
  updateCheckRequestSchema,
  updateComponentStateSchema,
  updateNowRequestSchema,
  updateNowResponseSchema,
  updatePolicyRequestSchema,
  updateServerStateSchema,
  updatesResponseSchema,
} from '@hz/shared';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { rpcHttpError } from '../servers/routes.js';
import type { UpdateService } from './service.js';

export interface UpdateRoutesOptions {
  db: Db;
  now: Clock;
  updates: UpdateService;
}

/** M17 routes (contract: @hz/shared api/updates.ts). Admin session via the global guard. */
export const updateRoutes: FastifyPluginAsync<UpdateRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const audit = (action: string, target: string, details: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, details });

  function serverState(id: string) {
    const st = o.updates.serverState(id);
    if (!st) throw new HttpError(404, 'not_found');
    return st;
  }

  app.get('/updates', async () => updatesResponseSchema.parse(o.updates.response()));

  app.put('/servers/:id/update-policy', async (request, reply) => {
    const { id } = serverIdParamsSchema.parse(request.params);
    const before = serverState(id);
    const policy = updatePolicyRequestSchema.parse(request.body);
    if (policy.reboot && !before.policy.reboot) {
      // Automatic reboots need a fresh TOTP (ROADMAP M17).
      // FastifyReply is thenable, so check `sent` instead of the return value.
      await stepUp(request, reply);
      if (reply.sent) return reply;
    }
    o.updates.setPolicy(id, policy);
    audit('server.update_policy', id, { name: before.name, policy });
    return updateServerStateSchema.parse(serverState(id));
  });

  app.post('/servers/:id/update-check', async (request) => {
    const { id } = serverIdParamsSchema.parse(request.params);
    const st = serverState(id);
    const { target } = updateCheckRequestSchema.parse(request.body);
    audit('server.update_check', id, { name: st.name, target });
    try {
      return updateComponentStateSchema.parse(await o.updates.check(id, target));
    } catch (err) {
      throw err instanceof HttpError ? err : rpcHttpError(err);
    }
  });

  app.post('/servers/:id/update', async (request) => {
    const { id } = serverIdParamsSchema.parse(request.params);
    const st = serverState(id);
    const { target } = updateNowRequestSchema.parse(request.body);
    const { runId } = o.updates.startRun(id, target, 'manual');
    audit('server.update', id, { name: st.name, target, runId });
    return updateNowResponseSchema.parse({ runId });
  });
};

import type { FastifyPluginAsync } from 'fastify';
import {
  serverIdParamsSchema,
  wolConfigRequestSchema,
  wolConfigSchema,
  wolWakeResponseSchema,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import type { WolService } from './service.js';

export interface WolRoutesOptions {
  db: Db;
  now: Clock;
  wol: WolService;
}

/**
 * /api/servers/:id/wol and /api/servers/:id/wake (SPEC 16). Admin session
 * (global guard); no step-up: waking a server is harmless, and the rate limit
 * (6 per minute and server) bounds what a stolen session can do.
 */
export const wolRoutes: FastifyPluginAsync<WolRoutesOptions> = async (app, o) => {
  const audit = (action: string, target: string, details?: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, ...(details ? { details } : {}) });

  app.get('/servers/:id/wol', async (request) => {
    const { id } = serverIdParamsSchema.parse(request.params);
    return wolConfigSchema.parse(o.wol.get(id));
  });

  app.put('/servers/:id/wol', async (request) => {
    const { id } = serverIdParamsSchema.parse(request.params);
    const body = wolConfigRequestSchema.parse(request.body);
    const saved = o.wol.set(id, body);
    audit(body.mac === null ? 'server.wol_removed' : 'server.wol_updated', id, {
      ...(body.mac === null ? {} : { port: body.port, via: body.via }),
    });
    return wolConfigSchema.parse(saved);
  });

  app.post('/servers/:id/wake', async (request) => {
    const { id } = serverIdParamsSchema.parse(request.params);
    const r = await o.wol.wake(id);
    audit('server.wake', id, { via: r.via });
    return wolWakeResponseSchema.parse({ ok: true, via: r.via });
  });
};

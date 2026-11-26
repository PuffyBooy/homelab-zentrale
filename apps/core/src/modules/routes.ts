import type { FastifyPluginAsync } from 'fastify';
import {
  MODULES,
  MODULES_ENABLE_STEP_UP,
  modulesResponseSchema,
  modulesUpdateRequestSchema,
} from '@hz/shared';
import { requireStepUp } from '../auth/guard.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import type { ModuleService } from './service.js';

export interface ModuleRoutesOptions {
  db: Db;
  now: Clock;
  modules: ModuleService;
}

/**
 * GET/PUT /api/settings/modules (admin session). Switching GitHub or Home
 * Assistant on needs step-up; switching anything off does not.
 */
export const moduleRoutes: FastifyPluginAsync<ModuleRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);

  app.get('/settings/modules', async () => modulesResponseSchema.parse(o.modules.get()));

  app.put('/settings/modules', async (request, reply) => {
    const body = modulesUpdateRequestSchema.parse(request.body);
    const current = o.modules.get();
    const enabling = MODULES.filter((m) => body[m] === true && !current[m]);
    if (enabling.some((m) => MODULES_ENABLE_STEP_UP.includes(m))) {
      // FastifyReply is thenable, so check `sent` instead of the return value.
      await stepUp(request, reply);
      if (reply.sent) return reply;
    }
    const refusal = o.modules.offRefusal(body);
    if (refusal !== null) throw new HttpError(409, 'conflict', undefined, refusal);
    const changed = o.modules.set(body);
    if (changed.length > 0) {
      const next = o.modules.get();
      writeAudit(o.db, o.now(), {
        actor: 'admin',
        action: 'settings.modules',
        target: null,
        details: Object.fromEntries(changed.map((m) => [m, next[m]])),
      });
    }
    return modulesResponseSchema.parse(o.modules.get());
  });
};

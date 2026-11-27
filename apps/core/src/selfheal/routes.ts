import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  selfhealResponseSchema,
  selfhealRuleParamsSchema,
  selfhealRuleRequestSchema,
  selfhealRuleSchema,
  selfhealSettingsSchema,
} from '@hz/shared';
import { containers } from '../db/schema.js';
import type { FeatureContext } from '../features.js';
import { HttpError } from '../http/errors.js';
import { isProtected } from '../throttle/service.js';
import type { SelfhealService } from './service.js';

export const MSG_PROTECTED = 'Geschützter Container (hz.role): keine Selbstheilung';
export const MSG_NO_CHECK = 'Website-Check nicht gefunden';

/** Routes of api/selfheal.ts. Responses are read back from the database. */
export function selfhealRoutes(ctx: FeatureContext, svc: SelfhealService): FastifyPluginAsync {
  return async (app) => {
    const target = (request: FastifyRequest): { serverId: string; container: string } => {
      const p = selfhealRuleParamsSchema.parse(request.params);
      if (!ctx.servers.row(p.serverId)) throw new HttpError(404, 'not_found');
      return p;
    };

    app.get('/selfheal', async () =>
      selfhealResponseSchema.parse({
        settings: svc.settings(),
        rules: svc.rules(),
        state: svc.state(),
        events: svc.events(),
      }),
    );

    app.put('/selfheal/settings', async (request) => {
      const s = selfhealSettingsSchema.parse(request.body);
      svc.saveSettings(s);
      return selfhealSettingsSchema.parse(svc.settings());
    });

    app.put('/selfheal/rules/:serverId/:container', async (request) => {
      const body = selfhealRuleRequestSchema.parse(request.body);
      const { serverId, container } = target(request);
      const row = ctx.db
        .select()
        .from(containers)
        .where(and(eq(containers.serverId, serverId), eq(containers.name, container)))
        .get();
      if (row && isProtected(row)) throw new HttpError(403, 'forbidden', undefined, MSG_PROTECTED);
      if (body.checkId !== null && !svc.checkExists(body.checkId)) {
        throw new HttpError(404, 'not_found', undefined, MSG_NO_CHECK);
      }
      svc.setRule(serverId, container, body.mode, body.checkId);
      const rule = svc.rule(serverId, container);
      if (!rule) throw new HttpError(404, 'not_found');
      return selfhealRuleSchema.parse(rule);
    });

    app.delete('/selfheal/rules/:serverId/:container', async (request, reply) => {
      const { serverId, container } = target(request);
      svc.deleteRule(serverId, container);
      return reply.code(204).send();
    });

    app.post('/selfheal/reset/:serverId/:container', async (request, reply) => {
      const { serverId, container } = target(request);
      svc.reset(serverId, container);
      return reply.code(204).send();
    });
  };
}

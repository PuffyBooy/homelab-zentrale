import type { FastifyPluginAsync } from 'fastify';
import {
  speedtestQuerySchema,
  speedtestResponseSchema,
  speedtestSettingsRequestSchema,
  speedtestSettingsSchema,
} from '@hz/shared';
import type { SpeedtestService } from './service.js';

/** Routes of api/speedtest.ts. Responses are read back from the database. */
export function speedtestRoutes(svc: SpeedtestService): FastifyPluginAsync {
  return async (app) => {
    app.get('/speedtest', async (request) => {
      const { days } = speedtestQuerySchema.parse(request.query ?? {});
      return speedtestResponseSchema.parse(svc.response(days));
    });

    app.put('/speedtest/settings', async (request) => {
      const patch = speedtestSettingsRequestSchema.parse(request.body);
      svc.update(patch);
      return speedtestSettingsSchema.parse(svc.settings());
    });

    app.post('/speedtest/run', async (_request, reply) => {
      const startedAt = svc.runNow();
      return reply.code(202).send({ startedAt });
    });
  };
}

import type { FastifyPluginAsync } from 'fastify';
import {
  azurePricesQuerySchema,
  azurePricesResponseSchema,
  azureSettingsRequestSchema,
  azureSettingsSchema,
  azureUpdateNeedsStepUp,
  cloudMachineCreateRequestSchema,
  cloudMachineDeleteRequestSchema,
  cloudMachineIdParamsSchema,
  cloudMachineResponseSchema,
  cloudMachineStartRequestSchema,
  cloudMachineUpdateRequestSchema,
  cloudOverviewSchema,
} from '@hz/shared';
import { hasStepUp, requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { WindowLimiter } from '../share/limits.js';
import type { CloudService } from './service.js';

/** POST /api/cloud/azure/test per minute. */
export const CLOUD_TESTS_PER_MIN = 5;
/** POST /api/cloud/machines per hour (orders cost money). */
export const CLOUD_ORDERS_PER_HOUR = 10;

export interface CloudRoutesOptions {
  db: Db;
  now: Clock;
  cloud: CloudService;
}

/**
 * /api/cloud (M22, packages/shared/src/api/cloud.ts). Admin session (global guard),
 * module gate `cloud` (404 module_disabled). Step-up: changing account fields other
 * than region and budget, deleting the account, deleting a machine. Every response
 * goes through its shared schema, so no secret can slip out.
 */
export const cloudRoutes: FastifyPluginAsync<CloudRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const c = o.cloud;
  const testLimiter = new WindowLimiter(CLOUD_TESTS_PER_MIN, 60_000, o.now);
  const orderLimiter = new WindowLimiter(CLOUD_ORDERS_PER_HOUR, 60 * 60_000, o.now);
  const limit = (limiter: WindowLimiter): void => {
    const wait = limiter.hit('admin');
    if (wait !== null) throw new HttpError(429, 'rate_limited', wait);
  };
  const refused = (action: string, target: string | null, err: unknown): void => {
    if (!(err instanceof HttpError)) return;
    writeAudit(o.db, o.now(), {
      actor: 'admin',
      action,
      target,
      details: { error: err.code },
    });
  };

  app.get('/cloud', async () => cloudOverviewSchema.parse(c.overview()));

  app.get('/cloud/azure', async () => azureSettingsSchema.parse(c.settings()));

  app.put('/cloud/azure', async (request) => {
    const body = azureSettingsRequestSchema.parse(request.body);
    if (azureUpdateNeedsStepUp(body) && !hasStepUp(request, o.now)) {
      throw new HttpError(403, 'step_up_required');
    }
    return azureSettingsSchema.parse(c.updateSettings(body));
  });

  app.post('/cloud/azure/test', async () => {
    limit(testLimiter);
    return azureSettingsSchema.parse(await c.test());
  });

  app.delete('/cloud/azure', { preHandler: stepUp }, async (_request, reply) => {
    c.clearSettings();
    return reply.code(204).send();
  });

  app.get('/cloud/azure/prices', async (request) => {
    const q = azurePricesQuerySchema.parse(request.query ?? {});
    return azurePricesResponseSchema.parse(await c.priceList(q));
  });

  app.post('/cloud/machines', async (request, reply) => {
    const body = cloudMachineCreateRequestSchema.parse(request.body);
    limit(orderLimiter);
    try {
      const machine = await c.create(body);
      return reply.code(202).send(cloudMachineResponseSchema.parse({ machine }));
    } catch (err) {
      refused('cloud.machine_order_refused', null, err);
      throw err;
    }
  });

  app.put('/cloud/machines/:id', async (request) => {
    const { id } = cloudMachineIdParamsSchema.parse(request.params);
    const body = cloudMachineUpdateRequestSchema.parse(request.body);
    return cloudMachineResponseSchema.parse({ machine: c.update(id, body.idleMinutes) });
  });

  app.post('/cloud/machines/:id/start', async (request, reply) => {
    const { id } = cloudMachineIdParamsSchema.parse(request.params);
    const body = cloudMachineStartRequestSchema.parse(request.body ?? {});
    try {
      const machine = c.start(id, body.overBudget);
      return reply.code(202).send(cloudMachineResponseSchema.parse({ machine }));
    } catch (err) {
      refused('cloud.machine_start_refused', id, err);
      throw err;
    }
  });

  app.post('/cloud/machines/:id/stop', async (request, reply) => {
    const { id } = cloudMachineIdParamsSchema.parse(request.params);
    const machine = c.stop(id);
    return reply.code(202).send(cloudMachineResponseSchema.parse({ machine }));
  });

  app.delete('/cloud/machines/:id', { preHandler: stepUp }, async (request, reply) => {
    const { id } = cloudMachineIdParamsSchema.parse(request.params);
    const { confirmName } = cloudMachineDeleteRequestSchema.parse(request.body);
    try {
      const machine = c.remove(id, confirmName);
      return reply.code(202).send(cloudMachineResponseSchema.parse({ machine }));
    } catch (err) {
      refused('cloud.machine_delete_refused', id, err);
      throw err;
    }
  });
};

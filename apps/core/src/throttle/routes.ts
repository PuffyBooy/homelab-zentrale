import type { FastifyPluginAsync } from 'fastify';
import {
  containerActionResponseSchema,
  containerIdParamsSchema,
  containerPriorityRequestSchema,
  containerPriorityResponseSchema,
  containerThrottleRequestSchema,
  containerUnthrottleRequestSchema,
  gameIdParamsSchema,
  gamePriorityRequestSchema,
  gamePriorityResponseSchema,
  serverIdParamsSchema,
  serverThrottleResponseSchema,
  serverThrottleUpdateRequestSchema,
  topConsumersQuerySchema,
  topConsumersResponseSchema,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import type { ContainerService } from '../containers/service.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { rpcHttpError } from '../servers/routes.js';
import type { ServerService } from '../servers/service.js';
import type { ThrottleService } from './service.js';

export interface ThrottleRoutesOptions {
  db: Db;
  now: Clock;
  throttle: ThrottleService;
  containers: ContainerService;
  servers: ServerService;
}

const asHttp = (err: unknown): HttpError => (err instanceof HttpError ? err : rpcHttpError(err));

/**
 * M10 routes (api/throttle.ts). All behind the admin session (global /api guard,
 * plus Origin check on changes). No step-up: throttling is reversible and never
 * touches hz.role containers.
 */
export const throttleRoutes: FastifyPluginAsync<ThrottleRoutesOptions> = async (app, o) => {
  const t = o.throttle;
  const serverOf = (params: unknown): string => {
    const { id } = serverIdParamsSchema.parse(params);
    if (!o.servers.row(id)) throw new HttpError(404, 'not_found');
    return id;
  };

  app.get('/containers/:id/priority', async (request) => {
    const { id } = containerIdParamsSchema.parse(request.params);
    return containerPriorityResponseSchema.parse(t.containerPriority(id));
  });

  app.put('/containers/:id/priority', async (request) => {
    const { id } = containerIdParamsSchema.parse(request.params);
    const body = containerPriorityRequestSchema.parse(request.body);
    return containerPriorityResponseSchema.parse(await t.setContainerPriority(id, body));
  });

  app.post('/containers/:id/throttle', async (request) => {
    const { id } = containerIdParamsSchema.parse(request.params);
    const { cpus } = containerThrottleRequestSchema.parse(request.body);
    try {
      await t.adminThrottle(id, cpus);
    } catch (err) {
      const e = asHttp(err);
      if (e.status !== 404) {
        writeAudit(o.db, o.now(), {
          actor: 'admin',
          action: 'throttle.apply_failed',
          target: id,
          details: { cpus, error: e.code },
        });
      }
      throw e;
    }
    return containerActionResponseSchema.parse({ ok: true, container: o.containers.summary(id) });
  });

  app.post('/containers/:id/unthrottle', async (request) => {
    const { id } = containerIdParamsSchema.parse(request.params);
    containerUnthrottleRequestSchema.parse(request.body ?? {});
    try {
      await t.adminUnthrottle(id);
    } catch (err) {
      const e = asHttp(err);
      if (e.status !== 404) {
        writeAudit(o.db, o.now(), {
          actor: 'admin',
          action: 'throttle.remove_failed',
          target: id,
          details: { error: e.code },
        });
      }
      throw e;
    }
    return containerActionResponseSchema.parse({ ok: true, container: o.containers.summary(id) });
  });

  app.get('/games/:id/priority', async (request) => {
    const { id } = gameIdParamsSchema.parse(request.params);
    return gamePriorityResponseSchema.parse(t.gamePriority(id));
  });

  app.put('/games/:id/priority', async (request) => {
    const { id } = gameIdParamsSchema.parse(request.params);
    const body = gamePriorityRequestSchema.parse(request.body);
    return gamePriorityResponseSchema.parse(await t.setGamePriority(id, body));
  });

  app.get('/servers/:id/throttle', async (request) => {
    const id = serverOf(request.params);
    return serverThrottleResponseSchema.parse(t.serverThrottle(id));
  });

  app.put('/servers/:id/throttle', async (request) => {
    const id = serverOf(request.params);
    const body = serverThrottleUpdateRequestSchema.parse(request.body);
    return serverThrottleResponseSchema.parse(await t.updateServerThrottle(id, body));
  });

  app.get('/overview/top-consumers', async (request) => {
    const { serverId } = topConsumersQuerySchema.parse(request.query);
    return topConsumersResponseSchema.parse(t.topConsumers(serverId));
  });
};

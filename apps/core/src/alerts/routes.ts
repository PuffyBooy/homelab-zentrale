import type { FastifyPluginAsync } from 'fastify';
import {
  alertIdParamsSchema,
  alertListQuerySchema,
  alertListResponseSchema,
  alertResponseSchema,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import type { AlertService } from './service.js';

export interface AlertRoutesOptions {
  db: Db;
  now: Clock;
  alerts: AlertService;
}

export const alertRoutes: FastifyPluginAsync<AlertRoutesOptions> = async (app, o) => {
  app.get('/alerts', async (request) => {
    const q = alertListQuerySchema.parse(request.query ?? {});
    return alertListResponseSchema.parse({ alerts: o.alerts.list(q) });
  });

  for (const op of ['ack', 'resolve'] as const) {
    app.post(`/alerts/:id/${op}`, async (request) => {
      const { id } = alertIdParamsSchema.parse(request.params);
      const r = op === 'ack' ? o.alerts.ack(id) : o.alerts.resolveById(id);
      if (r === null) throw new HttpError(404, 'not_found');
      if (r === 'conflict') throw new HttpError(409, 'conflict');
      writeAudit(o.db, o.now(), {
        actor: 'admin',
        action: op === 'ack' ? 'alert.acked' : 'alert.resolved',
        target: id,
        details: { key: r.key },
      });
      return alertResponseSchema.parse({ alert: r });
    });
  }
};

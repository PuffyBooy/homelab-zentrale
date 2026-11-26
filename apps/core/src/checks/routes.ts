import type { FastifyPluginAsync } from 'fastify';
import {
  checkDefSchema,
  checkHistoryQuerySchema,
  checkHistoryResponseSchema,
  checkIdParamsSchema,
  checkListResponseSchema,
  checkResponseSchema,
  okResponseSchema,
  type CheckDef,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import type { CheckService } from './service.js';

export interface CheckRoutesOptions {
  db: Db;
  now: Clock;
  checks: CheckService;
}

/** Audit details: kind and name only, never the URL (it may carry a token). */
const auditDetails = (def: CheckDef): Record<string, unknown> => ({
  kind: def.kind,
  name: def.name,
  runFrom: def.runFrom,
});

export const checkRoutes: FastifyPluginAsync<CheckRoutesOptions> = async (app, o) => {
  const audit = (action: string, target: string, details?: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, ...(details ? { details } : {}) });

  function parseDef(body: unknown): CheckDef {
    const def = checkDefSchema.parse(body);
    if (!o.checks.validate(def)) throw new HttpError(400, 'invalid_input');
    return def;
  }

  function idOf(params: unknown): string {
    return checkIdParamsSchema.parse(params).id;
  }

  app.get('/checks', async () => checkListResponseSchema.parse({ checks: o.checks.list() }));

  app.post('/checks', async (request) => {
    const def = parseDef(request.body);
    const check = o.checks.create(def);
    audit('check.created', check.id, auditDetails(def));
    return checkResponseSchema.parse({ check });
  });

  app.put('/checks/:id', async (request) => {
    const id = idOf(request.params);
    if (!o.checks.row(id)) throw new HttpError(404, 'not_found');
    const def = parseDef(request.body);
    const check = o.checks.update(id, def);
    if (!check) throw new HttpError(404, 'not_found');
    audit('check.updated', id, auditDetails(def));
    return checkResponseSchema.parse({ check });
  });

  app.delete('/checks/:id', async (request) => {
    const id = idOf(request.params);
    if (!o.checks.remove(id)) throw new HttpError(404, 'not_found');
    audit('check.deleted', id);
    return okResponseSchema.parse({ ok: true });
  });

  app.post('/checks/:id/run', async (request) => {
    const id = idOf(request.params);
    if (!o.checks.row(id)) throw new HttpError(404, 'not_found');
    audit('check.run', id);
    await o.checks.run(id);
    const check = o.checks.summary(id);
    if (!check) throw new HttpError(404, 'not_found');
    return checkResponseSchema.parse({ check });
  });

  app.get('/checks/:id/history', async (request) => {
    const id = idOf(request.params);
    const { range } = checkHistoryQuerySchema.parse(request.query ?? {});
    if (!o.checks.row(id)) throw new HttpError(404, 'not_found');
    return checkHistoryResponseSchema.parse({ points: o.checks.history(id, range) });
  });
};

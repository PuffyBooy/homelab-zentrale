import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  dockerDfResponseSchema,
  duQuerySchema,
  duResponseSchema,
  isDeniedServiceUnit,
  okResponseSchema,
  PROCESS_LIST_LIMIT,
  processesQuerySchema,
  processesResponseSchema,
  serverIdParamsSchema,
  serviceActionRequestSchema,
  servicesResponseSchema,
  shutdownRequestSchema,
} from '@hz/shared';
import type { z } from 'zod';
import type { AgentHub } from '../agents/hub.js';
import { RpcError } from '../agents/hub.js';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { rpcHttpError } from './routes.js';
import type { ServerService } from './service.js';

/**
 * M16 Server-Verwaltung (contract: @hz/shared api/server-admin.ts). Admin session
 * for all routes (global guard); the agent must be connected (409 agent_offline).
 * Every agent answer is validated with the shared data schema (502 otherwise).
 */

/** system.du walks a whole tree (`du -x -d1`); the agent stops after ~60 s. */
export const DU_TIMEOUT_MS = 70_000;
export const DOCKER_DF_TIMEOUT_MS = 60_000;
export const SERVICES_TIMEOUT_MS = 30_000;
/** systemctl start/restart waits for the unit to come up. */
export const SERVICE_ACTION_TIMEOUT_MS = 90_000;
export const PROCESSES_TIMEOUT_MS = 30_000;
export const SHUTDOWN_TIMEOUT_MS = 30_000;

/** du: one call per 5 s per server, with a burst of 3 (clicking into a folder). */
export const DU_BURST = 3;
export const DU_REFILL_MS = 5_000;

/** Token bucket per key (in memory; a restart refills it). */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
    private readonly now: Clock,
  ) {}

  /** Takes one token. Returns null on success, else the seconds until the next token. */
  take(key: string): number | null {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    const refilled = Math.min(this.capacity, b.tokens + (now - b.at) / this.refillMs);
    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, at: now });
      return Math.max(1, Math.ceil(((1 - refilled) * this.refillMs) / 1000));
    }
    this.buckets.set(key, { tokens: refilled - 1, at: now });
    return null;
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }
}

/**
 * Agent refusals of a service action are passed on as codes (never the agent's
 * text): not on the allowlist 403, bad unit 400, unknown unit 404.
 */
function serviceHttpError(err: unknown): HttpError {
  if (err instanceof RpcError) {
    switch (err.code) {
      case 'invalid_params':
      case 'bad_path':
        return new HttpError(400, 'invalid_input');
      case 'not_found':
        return new HttpError(404, 'not_found');
      case 'busy':
        return new HttpError(409, 'busy');
      default:
        break;
    }
  }
  return rpcHttpError(err);
}

export interface ServerAdminRoutesOptions {
  db: Db;
  now: Clock;
  servers: ServerService;
  hub: AgentHub;
}

export const serverAdminRoutes: FastifyPluginAsync<ServerAdminRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const duLimit = new TokenBucket(DU_BURST, DU_REFILL_MS, o.now);
  o.servers.onChange((id, deleted) => {
    if (deleted) duLimit.forget(id);
  });
  const audit = (action: string, target: string, details: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, details });

  /** The server (404) with a connected agent (409). */
  function connectedServer(request: FastifyRequest) {
    const { id } = serverIdParamsSchema.parse(request.params);
    const row = o.servers.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    if (!o.hub.isConnected(row.id)) throw new HttpError(409, 'agent_offline');
    return row;
  }

  async function call<S extends z.ZodType>(
    fn: () => Promise<unknown>,
    schema: S,
    mapError: (err: unknown) => HttpError = rpcHttpError,
  ): Promise<z.infer<S>> {
    let data: unknown;
    try {
      data = await fn();
    } catch (err) {
      throw mapError(err);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new HttpError(502, 'agent_error');
    return parsed.data;
  }

  app.get('/servers/:id/du', async (request) => {
    const row = connectedServer(request);
    const { path } = duQuerySchema.parse(request.query ?? {});
    const wait = duLimit.take(row.id);
    if (wait !== null) throw new HttpError(429, 'rate_limited', wait);
    return call(
      () => o.hub.call(row.id, 'system.du', { path }, { timeoutMs: DU_TIMEOUT_MS }),
      duResponseSchema,
    );
  });

  app.get('/servers/:id/docker-df', async (request) => {
    const row = connectedServer(request);
    return call(
      () => o.hub.call(row.id, 'system.dockerDf', {}, { timeoutMs: DOCKER_DF_TIMEOUT_MS }),
      dockerDfResponseSchema,
    );
  });

  app.get('/servers/:id/services', async (request) => {
    const row = connectedServer(request);
    return call(
      () => o.hub.call(row.id, 'system.services', {}, { timeoutMs: SERVICES_TIMEOUT_MS }),
      servicesResponseSchema,
    );
  });

  app.post('/servers/:id/services', async (request) => {
    const row = connectedServer(request);
    const body = serviceActionRequestSchema.parse(request.body);
    // The agent refuses these too; the core does not even ask.
    if (isDeniedServiceUnit(body.unit)) {
      audit('server.service_refused', row.id, { name: row.name, unit: body.unit, op: body.op });
      throw new HttpError(403, 'forbidden');
    }
    audit('server.service', row.id, { name: row.name, unit: body.unit, op: body.op });
    try {
      await o.hub.call(
        row.id,
        'system.service',
        { unit: body.unit, op: body.op },
        { timeoutMs: SERVICE_ACTION_TIMEOUT_MS },
      );
    } catch (err) {
      const e = serviceHttpError(err);
      audit('server.service_failed', row.id, {
        name: row.name,
        unit: body.unit,
        op: body.op,
        error: e.code,
      });
      throw e;
    }
    return okResponseSchema.parse({ ok: true });
  });

  app.get('/servers/:id/processes', async (request) => {
    const row = connectedServer(request);
    const { sort } = processesQuerySchema.parse(request.query ?? {});
    const data = await call(
      () =>
        o.hub.call(
          row.id,
          'system.processes',
          { sort, limit: PROCESS_LIST_LIMIT },
          { timeoutMs: PROCESSES_TIMEOUT_MS },
        ),
      processesResponseSchema,
    );
    return { total: data.total, list: data.list.slice(0, PROCESS_LIST_LIMIT) };
  });

  // Same checks as the reboot (servers/routes.ts): step-up, server name typed in, audit.
  app.post('/servers/:id/shutdown', { preHandler: stepUp }, async (request) => {
    const { id } = serverIdParamsSchema.parse(request.params);
    const row = o.servers.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    const body = shutdownRequestSchema.parse(request.body);
    if (body.confirmName !== row.name) throw new HttpError(400, 'confirm_mismatch');
    audit('server.shutdown', row.id, { name: row.name });
    try {
      await o.hub.call(
        row.id,
        'system.shutdown',
        { confirmName: row.name },
        { timeoutMs: SHUTDOWN_TIMEOUT_MS },
      );
    } catch (err) {
      throw rpcHttpError(err);
    }
    return okResponseSchema.parse({ ok: true });
  });
};

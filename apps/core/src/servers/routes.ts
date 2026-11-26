import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  cleanupPreviewResponseSchema,
  cleanupResponseSchema,
  enrollRequestSchema,
  enrollResponseSchema,
  historyQuerySchema,
  historyResponseSchema,
  okResponseSchema,
  rebootRequestSchema,
  serverDetailSchema,
  serverIdParamsSchema,
  serverListResponseSchema,
  serverUpdateRequestSchema,
  serverUpdateResponseSchema,
} from '@hz/shared';
import type { AgentHub } from '../agents/hub.js';
import { RpcError } from '../agents/hub.js';
import { NameTakenError, type AgentTokens } from '../agents/tokens.js';
import type { AlertService } from '../alerts/service.js';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import type { MetricsStore } from '../metrics/store.js';
import { enrollSnippets } from './enroll-snippet.js';
import {
  mergeThresholds,
  thresholdsConsistent,
  thresholdsOf,
  type ServerService,
} from './service.js';

export interface ServerRoutesOptions {
  db: Db;
  now: Clock;
  config: Config;
  servers: ServerService;
  hub: AgentHub;
  tokens: AgentTokens;
  metrics: MetricsStore;
  alerts: AlertService;
}

/** Maps RPC failures to HTTP. Agent messages are not passed through. */
export function rpcHttpError(err: unknown): HttpError {
  if (!(err instanceof RpcError)) return new HttpError(500, 'internal');
  switch (err.code) {
    case 'offline':
    case 'disconnected':
      return new HttpError(409, 'agent_offline');
    case 'timeout':
      return new HttpError(504, 'agent_timeout');
    case 'confirm_mismatch':
      return new HttpError(400, 'confirm_mismatch');
    case 'terminal_disabled':
    case 'not_allowed':
      return new HttpError(403, 'forbidden');
    default:
      return new HttpError(502, 'agent_error');
  }
}

const CLEANUP_PREVIEW_TIMEOUT = 60_000;
const CLEANUP_TIMEOUT = 15 * 60_000;
const REBOOT_TIMEOUT = 30_000;

export const serverRoutes: FastifyPluginAsync<ServerRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const audit = (action: string, target: string, details?: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, ...(details ? { details } : {}) });

  function serverOf(request: FastifyRequest) {
    const { id } = serverIdParamsSchema.parse(request.params);
    const row = o.servers.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  }

  async function rpc<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw rpcHttpError(err);
    }
  }

  app.get('/servers', async () => serverListResponseSchema.parse({ servers: o.servers.list() }));

  app.get('/servers/:id', async (request) => {
    const row = serverOf(request);
    return serverDetailSchema.parse(o.servers.detail(row.id));
  });

  app.get('/servers/:id/history', async (request) => {
    const row = serverOf(request);
    const { range } = historyQuerySchema.parse(request.query ?? {});
    return historyResponseSchema.parse(o.metrics.history(row.id, range));
  });

  app.post('/servers/enroll', async (request) => {
    const body = enrollRequestSchema.parse(request.body);
    let created: { token: string; expiresAt: number };
    try {
      created = o.tokens.createEnrollment(body.name, body.location);
    } catch (err) {
      if (err instanceof NameTakenError) throw new HttpError(409, 'conflict');
      throw err;
    }
    audit('server.enroll_token_created', body.name, { location: body.location });
    const { dockerRun, compose } = enrollSnippets(o.config, body.name, created.token);
    return enrollResponseSchema.parse({
      token: created.token,
      expiresAt: new Date(created.expiresAt).toISOString(),
      dockerRun,
      compose,
    });
  });

  app.patch('/servers/:id', async (request, reply) => {
    const row = serverOf(request);
    const body = serverUpdateRequestSchema.parse(request.body);
    if (
      body.thresholds &&
      !thresholdsConsistent(mergeThresholds(thresholdsOf(row), body.thresholds))
    ) {
      throw new HttpError(400, 'invalid_input');
    }
    if (body.allowTerminal !== undefined) {
      // Enabling (or disabling) the console needs a fresh TOTP.
      // FastifyReply is thenable, so check `sent` instead of the return value.
      await stepUp(request, reply);
      if (reply.sent) return reply;
    }
    o.servers.update(row.id, {
      ...(body.location !== undefined ? { location: body.location } : {}),
      ...(body.thresholds !== undefined ? { thresholds: body.thresholds } : {}),
      ...(body.allowTerminal !== undefined ? { allowTerminal: body.allowTerminal } : {}),
    });
    audit('server.updated', row.id, {
      name: row.name,
      fields: Object.keys(body),
      ...(body.allowTerminal !== undefined ? { allowTerminal: body.allowTerminal } : {}),
      ...(body.thresholds !== undefined ? { thresholds: body.thresholds } : {}),
    });
    return serverUpdateResponseSchema.parse(o.servers.detail(row.id));
  });

  app.post('/servers/:id/cleanup-preview', async (request) => {
    const row = serverOf(request);
    const data = await rpc(() =>
      o.hub.call(row.id, 'system.cleanupPreview', {}, { timeoutMs: CLEANUP_PREVIEW_TIMEOUT }),
    );
    const parsed = cleanupPreviewResponseSchema.safeParse(data);
    if (!parsed.success) throw new HttpError(502, 'agent_error');
    return parsed.data;
  });

  app.post('/servers/:id/cleanup', async (request) => {
    const row = serverOf(request);
    audit('server.cleanup', row.id, { name: row.name });
    const data = await rpc(() =>
      o.hub.call(row.id, 'system.cleanup', {}, { timeoutMs: CLEANUP_TIMEOUT }),
    );
    const parsed = cleanupResponseSchema.safeParse(data);
    if (!parsed.success) throw new HttpError(502, 'agent_error');
    audit('server.cleanup_done', row.id, { name: row.name, freedBytes: parsed.data.freedBytes });
    return parsed.data;
  });

  app.post('/servers/:id/reboot', { preHandler: stepUp }, async (request) => {
    const row = serverOf(request);
    const body = rebootRequestSchema.parse(request.body);
    if (body.confirmName !== row.name) throw new HttpError(400, 'confirm_mismatch');
    audit('server.reboot', row.id, { name: row.name });
    await rpc(() =>
      o.hub.call(row.id, 'system.reboot', { confirmName: row.name }, { timeoutMs: REBOOT_TIMEOUT }),
    );
    return okResponseSchema.parse({ ok: true });
  });

  app.post('/servers/:id/revoke-agent', { preHandler: stepUp }, async (request) => {
    const row = serverOf(request);
    const revoked = o.tokens.revoke(row.id);
    o.hub.disconnect(row.id, 'revoked');
    audit('server.agent_revoked', row.id, { name: row.name, tokens: revoked });
    return okResponseSchema.parse({ ok: true });
  });

  app.delete('/servers/:id', { preHandler: stepUp }, async (request) => {
    const row = serverOf(request);
    o.tokens.revoke(row.id);
    o.hub.disconnect(row.id, 'deleted');
    o.hub.forget(row.id);
    o.alerts.resolveAllForServer(row.id);
    o.servers.delete(row.id);
    audit('server.deleted', row.id, { name: row.name });
    return okResponseSchema.parse({ ok: true });
  });
};

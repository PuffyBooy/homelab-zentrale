import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  gameIdParamsSchema,
  okResponseSchema,
  shareAuditQuerySchema,
  shareAuditResponseSchema,
  shareCreateRequestSchema,
  shareCreateResponseSchema,
  shareGatewaySettingsRequestSchema,
  shareGatewaySettingsSchema,
  shareGatewayTokenResponseSchema,
  shareIdParamsSchema,
  shareListResponseSchema,
  shareResponseSchema,
} from '@hz/shared';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import type { GameService } from '../games/service.js';
import { HttpError } from '../http/errors.js';
import type { ShareService } from './service.js';

export interface ShareRoutesOptions {
  db: Db;
  now: Clock;
  games: GameService;
  shares: ShareService;
  baseUrl: string | undefined;
}

/** Base of tailnet links: HZ_BASE_URL, else the Host of this (tailnet) request. */
function tailnetBase(request: FastifyRequest, baseUrl: string | undefined): string {
  if (baseUrl) return baseUrl.replace(/\/+$/, '');
  const host = typeof request.headers.host === 'string' ? request.headers.host : '127.0.0.1';
  return `https://${host}`;
}

/**
 * Admin side of share links (session + Origin from the global guard). Changing
 * the gateway settings and its token needs step-up (SECURITY.md: tokens), and so
 * do creating and revoking a link. Deleting a link is only possible once it is
 * revoked or expired (409 otherwise), so it needs no step-up.
 */
export const shareRoutes: FastifyPluginAsync<ShareRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const s = o.shares;
  const audit = (action: string, target: string | null, details?: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, ...(details ? { details } : {}) });
  const gameOf = (params: unknown) => {
    const { id } = gameIdParamsSchema.parse(params);
    const row = o.games.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  };
  const shareOf = (params: unknown) => {
    const { id } = shareIdParamsSchema.parse(params);
    const row = s.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  };

  app.get('/games/:id/shares', async (request) => {
    const game = gameOf(request.params);
    return shareListResponseSchema.parse({ shares: s.list(game.id) });
  });

  // Creating and revoking a link needs step-up (decision 2026-11-26); this also
  // covers console_write (full RCON for the friend, SPEC 6.4).
  app.post('/games/:id/shares', { preHandler: stepUp }, async (request, reply) => {
    const game = gameOf(request.params);
    const body = shareCreateRequestSchema.parse(request.body);
    const { share, token } = await s.create(game.id, body);
    audit('share.created', share.id, {
      gameId: game.id,
      name: game.name,
      person: share.person,
      perms: share.perms,
      expires: body.expires,
      hasPin: share.hasPin,
    });
    const publicBase = s.publicBase();
    return reply.code(201).send(
      shareCreateResponseSchema.parse({
        share,
        urls: {
          tailnet: `${tailnetBase(request, o.baseUrl)}/s/${token}`,
          public: publicBase === null ? null : `${publicBase}/s/${token}`,
        },
      }),
    );
  });

  app.post('/shares/:id/revoke', { preHandler: stepUp }, async (request) => {
    const row = shareOf(request.params);
    const share = s.revoke(row.id);
    audit('share.revoked', row.id, { gameId: row.gameId, person: row.person });
    return shareResponseSchema.parse({ share });
  });

  app.delete('/shares/:id', async (request) => {
    const row = shareOf(request.params);
    const result = s.remove(row.id);
    if (result === 'not_found') throw new HttpError(404, 'not_found');
    if (result === 'active') throw new HttpError(409, 'conflict');
    audit('share.deleted', row.id, { gameId: row.gameId, person: row.person });
    return okResponseSchema.parse({ ok: true });
  });

  app.get('/games/:id/share-audit', async (request) => {
    const game = gameOf(request.params);
    const { limit } = shareAuditQuerySchema.parse(request.query ?? {});
    return shareAuditResponseSchema.parse({ entries: s.auditEntries(game.id, limit) });
  });

  app.get('/settings/share-gateway', async () =>
    shareGatewaySettingsSchema.parse(s.gatewaySettings()),
  );

  app.put('/settings/share-gateway', { preHandler: stepUp }, async (request) => {
    const body = shareGatewaySettingsRequestSchema.parse(request.body);
    if (body.enabled && body.publicUrl === null) {
      throw new HttpError(400, 'invalid_input', undefined, 'Öffentliche Adresse fehlt');
    }
    s.setGateway(body.enabled, body.publicUrl);
    audit('share_gateway.updated', null, { enabled: body.enabled, publicUrl: body.publicUrl });
    return shareGatewaySettingsSchema.parse(s.gatewaySettings());
  });

  app.post('/settings/share-gateway/token', { preHandler: stepUp }, async () => {
    const token = s.newGatewayToken();
    audit('share_gateway.token_created', null);
    return shareGatewayTokenResponseSchema.parse({ token });
  });
};

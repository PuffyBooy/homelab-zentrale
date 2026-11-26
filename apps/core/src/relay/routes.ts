import type { FastifyPluginAsync } from 'fastify';
import {
  dnsSettingsRequestSchema,
  dnsSettingsSchema,
  gameIdParamsSchema,
  gameRelayRequestSchema,
  gameRelayResponseSchema,
  ingressListResponseSchema,
  ingressResponseSchema,
  ingressUpdateRequestSchema,
  serverIdParamsSchema,
} from '@hz/shared';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import type { GameService } from '../games/service.js';
import type { RelayService } from './service.js';

export interface RelayRoutesOptions {
  db: Db;
  now: Clock;
  games: GameService;
  relay: RelayService;
}

/**
 * M15 game relay (packages/shared/src/api/relay.ts). Admin session everywhere
 * (global guard), module games (module gate: /api/relay, /api/settings/dns and
 * /api/servers/:id/ingress). Every change needs step-up. Answers are read back
 * from the database, never echoed from the request; the DNS token never leaves
 * the service.
 */
export const relayRoutes: FastifyPluginAsync<RelayRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const refused = (action: string, target: string | null, err: unknown): void => {
    if (err instanceof HttpError && err.status < 500) {
      writeAudit(o.db, o.now(), {
        actor: 'admin',
        action,
        target,
        details: { error: err.code },
      });
    }
  };

  app.get('/relay/ingresses', async () =>
    ingressListResponseSchema.parse({ ingresses: o.relay.ingresses() }),
  );

  app.put('/servers/:id/ingress', { preHandler: stepUp }, async (request) => {
    const { id } = serverIdParamsSchema.parse(request.params);
    const body = ingressUpdateRequestSchema.parse(request.body);
    try {
      const ingress = await o.relay.updateIngress(id, body);
      return ingressResponseSchema.parse({ ingress });
    } catch (err) {
      refused('server.ingress_refused', id, err);
      throw err;
    }
  });

  app.get('/games/:id/relay', async (request) => {
    const { id } = gameIdParamsSchema.parse(request.params);
    if (!o.games.row(id)) throw new HttpError(404, 'not_found');
    return gameRelayResponseSchema.parse({ relay: o.relay.relayOf(id) });
  });

  app.put('/games/:id/relay', { preHandler: stepUp }, async (request) => {
    const { id } = gameIdParamsSchema.parse(request.params);
    if (!o.games.row(id)) throw new HttpError(404, 'not_found');
    const body = gameRelayRequestSchema.parse(request.body);
    try {
      const relay = await o.relay.setRelay(id, body);
      return gameRelayResponseSchema.parse({ relay });
    } catch (err) {
      refused('game.relay_refused', id, err);
      throw err;
    }
  });

  app.get('/settings/dns', async () => dnsSettingsSchema.parse(o.relay.dnsSettings()));

  app.put('/settings/dns', { preHandler: stepUp }, async (request) => {
    const body = dnsSettingsRequestSchema.parse(request.body);
    try {
      return dnsSettingsSchema.parse(await o.relay.updateDns(body));
    } catch (err) {
      refused('settings.dns_refused', null, err);
      throw err;
    }
  });
};

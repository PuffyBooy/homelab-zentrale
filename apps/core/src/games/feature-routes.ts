import type { FastifyPluginAsync } from 'fastify';
import {
  gameIdParamsSchema,
  gameModFileParamsSchema,
  gameModInstallRequestSchema,
  gameModSearchQuerySchema,
  gameModSearchResponseSchema,
  gameModsResponseSchema,
  gameNotifyRequestSchema,
  gameNotifySchema,
  gameNotifyTestResponseSchema,
  gameResponseSchema,
  gameRestoreParamsSchema,
  gameRestoreRequestSchema,
  gameSchedulesResponseSchema,
  gameSchedulesSchema,
  gameStatsQuerySchema,
  gameStatsResponseSchema,
  whitelistDecisionParamsSchema,
  whitelistRequestListResponseSchema,
  whitelistRequestResponseSchema,
} from '@hz/shared';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { rpcHttpError } from '../servers/routes.js';
import type { GameModsService } from './mods.js';
import type { GameNotifier } from './notify.js';
import type { GameScheduleService } from './schedules.js';
import type { GameService } from './service.js';
import type { GameStatsService } from './stats.js';
import type { WhitelistRequests } from './whitelist-requests.js';

export interface GameFeatureRoutesOptions {
  db: Db;
  now: Clock;
  games: GameService;
  schedules: GameScheduleService;
  notifier: GameNotifier;
  stats: GameStatsService;
  mods: GameModsService;
  whitelist: WhitelistRequests;
}

function asHttp(err: unknown): HttpError {
  return err instanceof HttpError ? err : rpcHttpError(err);
}

/**
 * M12 routes (packages/shared/src/api/game-features.ts): schedules, Discord,
 * statistics, Modrinth mods, whitelist requests, restoring a backup. Admin
 * session everywhere (global guard), module games (gate). Step-up: setting or
 * removing the Discord URL (a token) and restoring a backup. Answers are built
 * from the database, never from the request body.
 */
export const gameFeatureRoutes: FastifyPluginAsync<GameFeatureRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const g = o.games;
  const audit = (action: string, target: string | null, details?: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, ...(details ? { details } : {}) });
  const rowOf = (params: unknown) => {
    const { id } = gameIdParamsSchema.parse(params);
    const row = g.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  };

  // ---- schedules -------------------------------------------------------------------

  app.get('/games/:id/schedules', async (request) => {
    const row = rowOf(request.params);
    return gameSchedulesResponseSchema.parse(o.schedules.list(row.id));
  });

  app.put('/games/:id/schedules', async (request) => {
    const row = rowOf(request.params);
    const body = gameSchedulesSchema.parse(request.body);
    o.schedules.replace(row.id, body.schedules);
    const saved = o.schedules.list(row.id);
    audit('game.schedules_updated', row.id, {
      name: row.name,
      schedules: saved.schedules.map((s) => ({ kind: s.kind, days: s.days, time: s.time })),
    });
    return gameSchedulesResponseSchema.parse(saved);
  });

  // ---- Discord ------------------------------------------------------------------------

  app.get('/games/:id/notify', async (request) => {
    const row = rowOf(request.params);
    return gameNotifySchema.parse(o.notifier.get(row.id));
  });

  app.put('/games/:id/notify', async (request, reply) => {
    const row = rowOf(request.params);
    const body = gameNotifyRequestSchema.parse(request.body);
    if (body.discordWebhookUrl !== undefined) {
      // The webhook URL is a token: setting, changing or removing it needs a fresh TOTP.
      // FastifyReply is thenable, so check `sent` instead of the return value.
      await stepUp(request, reply);
      if (reply.sent) return reply;
    }
    o.notifier.set(row.id, body.discordWebhookUrl, body.events);
    audit('game.notify_updated', row.id, {
      name: row.name,
      events: body.events,
      ...(body.discordWebhookUrl === undefined
        ? {}
        : { discord: body.discordWebhookUrl === null ? 'removed' : 'set' }),
    });
    return gameNotifySchema.parse(o.notifier.get(row.id));
  });

  app.post('/games/:id/notify/test', async (request) => {
    const row = rowOf(request.params);
    if (!o.notifier.get(row.id).discordSet) throw new HttpError(409, 'conflict');
    const ok = await o.notifier.send(row.id, 'test');
    audit('game.notify_test', row.id, { name: row.name, ok });
    return gameNotifyTestResponseSchema.parse({ ok });
  });

  // ---- statistics ---------------------------------------------------------------------

  app.get('/games/:id/stats', async (request) => {
    const row = rowOf(request.params);
    const { days } = gameStatsQuerySchema.parse(request.query ?? {});
    return gameStatsResponseSchema.parse(o.stats.stats(row.id, days));
  });

  // ---- mods / plugins -----------------------------------------------------------------

  app.get('/games/:id/mods', async (request) => {
    const row = rowOf(request.params);
    try {
      return gameModsResponseSchema.parse(await o.mods.list(row.id));
    } catch (err) {
      throw asHttp(err);
    }
  });

  app.get('/games/:id/mods/search', async (request) => {
    const row = rowOf(request.params);
    const { q } = gameModSearchQuerySchema.parse(request.query ?? {});
    return gameModSearchResponseSchema.parse(await o.mods.search(row.id, q));
  });

  app.post('/games/:id/mods', async (request) => {
    const row = rowOf(request.params);
    const { projectId } = gameModInstallRequestSchema.parse(request.body);
    try {
      return gameModsResponseSchema.parse(await o.mods.install(row.id, projectId));
    } catch (err) {
      const e = asHttp(err);
      audit('game.mod_install_failed', row.id, { name: row.name, projectId, error: e.code });
      throw e;
    }
  });

  app.delete('/games/:id/mods/:fileName', async (request) => {
    const { id, fileName } = gameModFileParamsSchema.parse(request.params);
    const row = rowOf({ id });
    try {
      return gameModsResponseSchema.parse(await o.mods.remove(row.id, fileName));
    } catch (err) {
      throw asHttp(err);
    }
  });

  // ---- whitelist requests ---------------------------------------------------------------

  app.get('/games/:id/whitelist-requests', async (request) => {
    const row = rowOf(request.params);
    return whitelistRequestListResponseSchema.parse({ requests: o.whitelist.list(row.id) });
  });

  app.post('/whitelist-requests/:id/:decision', async (request) => {
    const { id, decision } = whitelistDecisionParamsSchema.parse(request.params);
    try {
      const req = await o.whitelist.decide(id, decision);
      return whitelistRequestResponseSchema.parse({ request: req });
    } catch (err) {
      const e = asHttp(err);
      const r = o.whitelist.row(id);
      if (r) {
        audit('game.whitelist_request_failed', r.gameId, {
          decision,
          player: r.player,
          error: e.code,
        });
      }
      throw e;
    }
  });

  // ---- restore --------------------------------------------------------------------------

  app.post(
    '/games/:id/backups/:backupId/restore',
    { preHandler: stepUp },
    async (request, reply) => {
      const { id, backupId } = gameRestoreParamsSchema.parse(request.params);
      const row = rowOf({ id });
      const { confirmName } = gameRestoreRequestSchema.parse(request.body);
      let game;
      try {
        game = g.restore(row.id, backupId, confirmName);
      } catch (err) {
        const e = asHttp(err);
        audit('game.restore_refused', row.id, { name: row.name, backupId, error: e.code });
        throw e;
      }
      audit('game.restore', row.id, { name: row.name, backupId });
      return reply.code(202).send(gameResponseSchema.parse({ game }));
    },
  );
};

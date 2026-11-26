import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import {
  gameIdParamsSchema,
  gameMigrateRequestSchema,
  gameMigrateResponseSchema,
  gameMigrationResponseSchema,
  migrationSuggestQuerySchema,
  migrationSuggestResponseSchema,
} from '@hz/shared';
import type { AgentHub } from '../agents/hub.js';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import type { Scheduler } from '../scheduler.js';
import { rpcHttpError } from '../servers/routes.js';
import { MigrationService } from './migrate.js';
import type { GameService } from './service.js';

export interface MigrateRoutesOptions {
  db: Db;
  now: Clock;
  hub: AgentHub;
  games: GameService;
  scheduler: Scheduler;
  log: FastifyBaseLogger;
  /** After a game moved to another server (throttle state of the old server is dropped). */
  onMoved?: (gameId: string) => void;
}

/**
 * M11 /api/games/:id/migrate, /migration, /migration/suggest, /migration/cancel.
 * Admin session everywhere (global guard), module games (module gate on
 * /api/games), starting a migration needs step-up. The service lives with the
 * routes; it is started here and stopped when the app closes.
 */
export const migrateRoutes: FastifyPluginAsync<MigrateRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const service = new MigrationService({
    db: o.db,
    now: o.now,
    hub: o.hub,
    games: o.games,
    scheduler: o.scheduler,
    log: o.log,
    ...(o.onMoved ? { onMoved: o.onMoved } : {}),
  });
  service.start();
  // Before the hub and the database close: running migrations end as `failed` with
  // their rollback steps marked pending (agents are gone); the next start retries them.
  app.addHook('preClose', async () => {
    service.shutdown();
    await Promise.race([service.idle(), new Promise((r) => setTimeout(r, 3_000).unref())]);
  });

  const idOf = (params: unknown): string => {
    const { id } = gameIdParamsSchema.parse(params);
    if (!o.games.row(id)) throw new HttpError(404, 'not_found');
    return id;
  };

  app.post('/games/:id/migrate', { preHandler: stepUp }, async (request, reply) => {
    const id = idOf(request.params);
    const body = gameMigrateRequestSchema.parse(request.body);
    try {
      const migrationId = service.begin(id, body);
      return await reply.code(202).send(gameMigrateResponseSchema.parse({ migrationId }));
    } catch (err) {
      const e = err instanceof HttpError ? err : rpcHttpError(err);
      writeAudit(o.db, o.now(), {
        actor: 'admin',
        action: 'game.migrate_refused',
        target: id,
        details: { target: body.targetServerId, error: e.code },
      });
      throw e;
    }
  });

  app.get('/games/:id/migration', async (request) => {
    const id = idOf(request.params);
    return gameMigrationResponseSchema.parse({ migration: service.latest(id) });
  });

  app.get('/games/:id/migration/suggest', async (request) => {
    const id = idOf(request.params);
    const q = migrationSuggestQuerySchema.parse(request.query ?? {});
    return migrationSuggestResponseSchema.parse(service.suggest(id, q.targetServerId));
  });

  app.post('/games/:id/migration/cancel', async (request) => {
    const id = idOf(request.params);
    const migration = await service.cancel(id);
    writeAudit(o.db, o.now(), {
      actor: 'admin',
      action: 'game.migrate_cancel',
      target: id,
      details: { migrationId: migration?.id ?? null },
    });
    return gameMigrationResponseSchema.parse({ migration });
  });
};

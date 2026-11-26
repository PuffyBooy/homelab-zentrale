import type { FastifyPluginAsync } from 'fastify';
import {
  gameActionParamsSchema,
  gameBackupListResponseSchema,
  gameCreateRequestSchema,
  gameDeleteRequestSchema,
  gameIdParamsSchema,
  gameListResponseSchema,
  gameRconRequestSchema,
  gameRconResponseSchema,
  gameResponseSchema,
  gameSuggestQuerySchema,
  gameSuggestResponseSchema,
  gameTemplateListResponseSchema,
  gameUpdateRequestSchema,
  okResponseSchema,
} from '@hz/shared';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { rpcHttpError } from '../servers/routes.js';
import type { GameService } from './service.js';

export interface GameRoutesOptions {
  db: Db;
  now: Clock;
  games: GameService;
}

function asHttp(err: unknown): HttpError {
  return err instanceof HttpError ? err : rpcHttpError(err);
}

/**
 * /api/games/* (SPEC 6.2/6.3). Admin session everywhere; deleting a game needs
 * step-up. Responses never contain the RCON password or secret field values.
 */
export const gameRoutes: FastifyPluginAsync<GameRoutesOptions> = async (app, o) => {
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

  app.get('/games/templates', async () =>
    gameTemplateListResponseSchema.parse({ templates: g.templateList() }),
  );

  app.get('/games/suggest', async (request) => {
    const q = gameSuggestQuerySchema.parse(request.query ?? {});
    return gameSuggestResponseSchema.parse(g.suggest(q.templateId, q.serverId));
  });

  app.get('/games', async () => gameListResponseSchema.parse({ games: g.list() }));

  app.post('/games', async (request, reply) => {
    const body = gameCreateRequestSchema.parse(request.body);
    const game = g.create(body);
    audit('game.created', game.id, {
      name: game.name,
      templateId: game.templateId,
      serverId: game.serverId,
      ports: game.ports,
      keys: Object.keys(body.values).sort(),
    });
    return reply.code(202).send(gameResponseSchema.parse({ game }));
  });

  app.get('/games/:id', async (request) => {
    const row = rowOf(request.params);
    return gameResponseSchema.parse({ game: g.summary(row.id) });
  });

  app.put('/games/:id', async (request) => {
    const row = rowOf(request.params);
    const body = gameUpdateRequestSchema.parse(request.body);
    try {
      const game = await g.update(row.id, body);
      audit('game.updated', row.id, {
        name: row.name,
        keys: Object.keys(body.values ?? {}).sort(),
        ...(body.autoStopMinutes !== undefined ? { autoStopMinutes: body.autoStopMinutes } : {}),
        ...(body.externalAddress !== undefined ? { externalAddress: body.externalAddress } : {}),
      });
      return gameResponseSchema.parse({ game });
    } catch (err) {
      const e = asHttp(err);
      if (e.status >= 500 || e.code === 'agent_offline') {
        audit('game.update_failed', row.id, { name: row.name, error: e.code });
      }
      throw e;
    }
  });

  app.delete('/games/:id', { preHandler: stepUp }, async (request) => {
    const row = rowOf(request.params);
    const { confirmName } = gameDeleteRequestSchema.parse(request.body);
    try {
      await g.remove(row.id, confirmName);
    } catch (err) {
      const e = asHttp(err);
      audit('game.delete_refused', row.id, { name: row.name, error: e.code });
      throw e;
    }
    audit('game.deleted', row.id, { name: row.name, serverId: row.serverId });
    return okResponseSchema.parse({ ok: true });
  });

  app.post('/games/:id/rcon', async (request) => {
    const row = rowOf(request.params);
    const { command } = gameRconRequestSchema.parse(request.body);
    // The command is audited, never the output. Rate-limited attempts are not
    // audited (they never reach the agent), so a flood cannot fill the log.
    let output: string;
    try {
      output = await g.rcon(row.id, command);
    } catch (err) {
      const e = asHttp(err);
      if (e.status !== 429) audit('game.rcon', row.id, { name: row.name, command, error: e.code });
      throw e;
    }
    audit('game.rcon', row.id, { name: row.name, command });
    return gameRconResponseSchema.parse({ output });
  });

  app.get('/games/:id/backups', async (request) => {
    const row = rowOf(request.params);
    return gameBackupListResponseSchema.parse({ backups: g.backups(row.id) });
  });

  app.post('/games/:id/:action', async (request) => {
    const { id, action } = gameActionParamsSchema.parse(request.params);
    const row = g.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    try {
      const game = await g.action(id, action);
      if (action === 'backup') audit('game.backup', id, { name: row.name });
      return gameResponseSchema.parse({ game });
    } catch (err) {
      const e = asHttp(err);
      audit(`game.${action}_failed`, id, { name: row.name, error: e.code });
      throw e;
    }
  });
};

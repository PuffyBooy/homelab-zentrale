import { afterEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema.js';
import { DELETED_BACKUP_DAYS } from '../src/games/service.js';
import { stepUp, until, type WsClient } from './agent-helpers.js';
import { gameRequest, readyGame, rpcsOf, withGames, type GameSetup } from './games-helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const DAY = 24 * 60 * 60_000;

async function deletedGame(): Promise<GameSetup> {
  const s = await withGames(clients);
  t = s.t;
  const g = await readyGame(s);
  await stepUp(s.t, s.secret, s.cookie);
  const res = await gameRequest(s, 'DELETE', `/api/games/${g.id}`, { confirmName: 'survival' });
  expect(res.statusCode).toBe(200);
  return s;
}

describe('backups of deleted game servers', () => {
  it('records the deletion and purges daily; the record goes after 30 days', async () => {
    const s = await deletedGame();
    const games = s.t.app.hzCore.games;
    const [rec] = games.deletedBackups();
    expect(rec).toMatchObject({ serverId: s.serverId, gameName: 'survival' });

    await games.purgeDeletedBackups();
    const calls = rpcsOf(s, 'game.backups.purge');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({ gameId: 'survival', olderThanDays: DELETED_BACKUP_DAYS });
    // Not 30 days yet: the record stays.
    expect(games.deletedBackups()).toHaveLength(1);
    expect(
      s.t.db.db
        .select()
        .from(auditLog)
        .all()
        .filter((a) => a.action === 'game.backups_purged'),
    ).toHaveLength(1);

    s.t.clock.advance(DELETED_BACKUP_DAYS * DAY);
    await s.keepAlive();
    await games.purgeDeletedBackups();
    expect(rpcsOf(s, 'game.backups.purge')).toHaveLength(2);
    expect(games.deletedBackups()).toEqual([]);
  });

  it('runs as a daily scheduler job at 05:00', async () => {
    const s = await deletedGame();
    const next = s.t.app.hzCore.scheduler.nextRunOf('games.purgeDeletedBackups');
    expect(next).toBeDefined();
    expect(new Date(next ?? 0).toISOString()).toMatch(/T04:00:00\.000Z$/);
  });

  it('agent offline or failing: no call or the record stays for the next day', async () => {
    const s = await deletedGame();
    const games = s.t.app.hzCore.games;
    s.t.clock.advance(DELETED_BACKUP_DAYS * DAY);
    s.behaviour.fail['game.backups.purge'] = { code: 'failed', message: 'disk error' };
    await s.keepAlive();
    await games.purgeDeletedBackups();
    expect(games.deletedBackups()[0]).toMatchObject({ lastError: 'failed' });

    s.agent.close();
    await until(() => !s.t.app.hzCore.hub.isConnected(s.serverId));
    const before = rpcsOf(s, 'game.backups.purge').length;
    await games.purgeDeletedBackups();
    expect(rpcsOf(s, 'game.backups.purge')).toHaveLength(before);
    expect(games.deletedBackups()).toHaveLength(1);
  });

  it('a new game with the same folder name drops the record without purging', async () => {
    const s = await deletedGame();
    await readyGame(s);
    const games = s.t.app.hzCore.games;
    await games.purgeDeletedBackups();
    expect(rpcsOf(s, 'game.backups.purge')).toHaveLength(0);
    expect(games.deletedBackups()).toEqual([]);
  });
});

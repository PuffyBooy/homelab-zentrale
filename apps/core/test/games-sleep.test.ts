import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditLog, gameServers } from '../src/db/schema.js';
import { SLEEP_MOTD, WAKE_RETRY_MS, wakePorts } from '../src/games/service.js';
import { connectAgent, metricsMsg, until, type WsClient } from './agent-helpers.js';
import {
  gameRequest,
  ONLINE,
  readyGame,
  rpcsOf,
  tick,
  withGames,
  type GameSetup,
} from './games-helpers.js';
import type { TestApp } from './helpers.js';
import { createShare, friend } from './share-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(opts: Parameters<typeof withGames>[1] = {}): Promise<GameSetup> {
  const s = await withGames(clients, opts);
  t = s.t;
  return s;
}

const EMPTY = { ...ONLINE, players: { online: 0, max: 20, names: [] } };

/** A ready game with 2 min sleep timer that falls asleep. */
async function asleep(s: GameSetup) {
  s.behaviour.status = EMPTY;
  const g = await readyGame(s, { autoStopMinutes: 2 });
  for (let i = 0; i < 4; i += 1) await tick(s, 30_000);
  await tick(s, 60_000);
  return g;
}

function wakeEvent(s: GameSetup, gameId = 'survival', agent: WsClient = s.agent): void {
  agent.send({
    type: 'event',
    ts: new Date(s.t.clock.t).toISOString(),
    event: { kind: 'game_wake', gameId, port: 25565, protocol: 'tcp' },
  });
}

describe('sleep mode (M12)', () => {
  it('new games default to 15 min and wake-on-connect; old rows keep 0 (migration)', async () => {
    const s = await setup();
    const g = await readyGame(s);
    expect(g).toMatchObject({ autoStopMinutes: 15, wakeOnConnect: true, sleeping: false });
    // Existing rows from before M12: the column default is 0.
    const cols = s.t.db.sqlite.prepare('PRAGMA table_info(game_servers)').all() as {
      name: string;
      dflt_value: string | null;
    }[];
    expect(cols.find((c) => c.name === 'wake_on_connect')?.dflt_value).toBe('0');
  });

  it('falls asleep after the timer: game.wake.arm on its public port, "Schläft"', async () => {
    const s = await setup();
    const g = await asleep(s);
    expect(rpcsOf(s, 'compose.down')).toHaveLength(1);
    const arm = rpcsOf(s, 'game.wake.arm');
    expect(arm).toHaveLength(1);
    expect(arm[0]?.params).toEqual({
      gameId: 'survival',
      mode: 'minecraft',
      ports: [{ port: g.ports[0]?.port, protocol: 'tcp' }],
      motd: SLEEP_MOTD,
    });
    const sum = s.t.app.hzCore.games.summary(g.id);
    expect(sum).toMatchObject({ status: 'off', statusText: 'Schläft', sleeping: true });
    const alerts = s.t.app.hzCore.alerts.list({ state: 'all', limit: 50 });
    expect(alerts.some((a) => a.title === 'Gameserver survival schläft')).toBe(true);
  });

  it('a wake event of its own agent starts it on the normal path (disarm, compose up)', async () => {
    const s = await setup();
    const g = await asleep(s);
    s.behaviour.status = ONLINE;
    const ups = rpcsOf(s, 'compose.up').length;
    wakeEvent(s);
    await until(() => rpcsOf(s, 'compose.up').length === ups + 1);
    await s.t.app.hzCore.games.idle();
    expect(rpcsOf(s, 'game.wake.disarm')).toHaveLength(1);
    expect(s.t.app.hzCore.games.summary(g.id)?.sleeping).toBe(false);
    const audit = s.t.db.db.select().from(auditLog).all();
    expect(audit.some((a) => a.action === 'game.woken' && a.target === g.id)).toBe(true);
  });

  it('ignores wake events for other games, unknown folders and games that do not sleep', async () => {
    const s = await setup();
    s.behaviour.status = ONLINE;
    await readyGame(s);
    const ups = rpcsOf(s, 'compose.up').length;
    wakeEvent(s, 'survival'); // runs, not asleep
    wakeEvent(s, 'other-game');
    await s.keepAlive();
    await s.t.app.hzCore.games.idle();
    expect(rpcsOf(s, 'compose.up')).toHaveLength(ups);
  });

  it('a wake that does not fit into RAM: stays asleep, alert, listens again after a minute', async () => {
    const s = await setup();
    const g = await asleep(s);
    // 98 % RAM used: 6 GiB do not fit.
    await s.t.app.hzCore.games.idle();
    s.agent.send({
      type: 'metrics',
      ts: new Date(s.t.clock.t).toISOString(),
      cpu: 10,
      ram: { usedBytes: 15.7 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
      swap: { usedBytes: 0, totalBytes: 0 },
      disks: [],
      temp: null,
      net: { rxBps: 0, txBps: 0 },
      uptimeS: 100,
    });
    await s.keepAlive();
    const ups = rpcsOf(s, 'compose.up').length;
    wakeEvent(s);
    await s.keepAlive();
    await s.t.app.hzCore.games.idle();
    expect(rpcsOf(s, 'compose.up')).toHaveLength(ups);
    expect(s.t.app.hzCore.games.summary(g.id)?.sleeping).toBe(true);
    expect(s.t.app.hzCore.alerts.active(`game:${g.id}:wake`)?.level).toBe('warn');
    const arms = rpcsOf(s, 'game.wake.arm').length;
    await tick(s, WAKE_RETRY_MS);
    expect(rpcsOf(s, 'game.wake.arm')).toHaveLength(arms + 1);
  });

  it('a manual start and a start through a link disarm first', async () => {
    const s = await setup();
    const g = await asleep(s);
    s.behaviour.status = ONLINE;
    const res = await gameRequest(s, 'POST', `/api/games/${g.id}/start`);
    expect(res.statusCode).toBe(200);
    expect(rpcsOf(s, 'game.wake.disarm')).toHaveLength(1);
    const order = s.rpcs.map((r) => r.action);
    expect(order.lastIndexOf('game.wake.disarm')).toBeLessThan(order.lastIndexOf('compose.up'));

    // Asleep again, then a friend starts it.
    s.behaviour.status = EMPTY;
    for (let i = 0; i < 6; i += 1) await tick(s, 30_000);
    expect(s.t.app.hzCore.games.summary(g.id)?.sleeping).toBe(true);
    const link = await createShare(s, g.id, { perms: ['power'] });
    const st = await friend(s, 'GET', 'status', { token: link.token });
    expect(st.json()).toMatchObject({ game: { sleeping: true, statusText: 'Schläft' } });
    // Friends never bypass the RAM reserve: fresh metrics.
    s.agent.send(metricsMsg({ ramPct: 40 }));
    await s.keepAlive();
    const start = await friend(s, 'POST', 'action', {
      token: link.token,
      payload: { action: 'start' },
    });
    expect(start.statusCode).toBe(200);
    expect(rpcsOf(s, 'game.wake.disarm')).toHaveLength(2);
  });

  it('re-arms sleeping games when the agent says hello again', async () => {
    const s = await setup();
    await asleep(s);
    const again = await connectAgent(s.url, s.agentToken);
    clients.push(again);
    await until(() => again.received.some((m) => m.type === 'rpc' && m.action === 'game.wake.arm'));
  });

  it('switching wake-on-connect off disarms; delete disarms too', async () => {
    const s = await setup();
    const g = await asleep(s);
    const put = await gameRequest(s, 'PUT', `/api/games/${g.id}`, { wakeOnConnect: false });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ game: { wakeOnConnect: false, sleeping: false } });
    expect(rpcsOf(s, 'game.wake.disarm')).toHaveLength(1);
    const row = s.t.db.db.select().from(gameServers).where(eq(gameServers.id, g.id)).get();
    expect(row?.sleeping).toBe(false);
  });

  it('wake ports: public only, mode protocol, at most 4', () => {
    const ports = [
      { name: 'game', port: 2456, protocol: 'udp' as const, count: 3 },
      { name: 'rcon', port: 25575, protocol: 'tcp' as const, count: 1, local: true },
      { name: 'web', port: 8080, protocol: 'tcp+udp' as const, count: 2 },
    ];
    expect(wakePorts('raw', ports)).toHaveLength(4);
    expect(wakePorts('minecraft', ports)).toEqual([
      { port: 8080, protocol: 'tcp' },
      { port: 8081, protocol: 'tcp' },
    ]);
    expect(wakePorts('minecraft-bedrock', ports).every((p) => p.protocol === 'udp')).toBe(true);
    expect(wakePorts('raw', ports).some((p) => p.port === 25575)).toBe(false);
  });

  it('the MOTD fits the agent protocol charset', async () => {
    const { rpcParamsByAction } = await import('@hz/shared');
    const parsed = rpcParamsByAction['game.wake.arm'].safeParse({
      gameId: 'survival',
      mode: 'minecraft',
      ports: [{ port: 25565, protocol: 'tcp' }],
      motd: SLEEP_MOTD,
    });
    expect(parsed.success).toBe(true);
  });
});

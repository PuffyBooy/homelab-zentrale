import { afterEach, describe, expect, it } from 'vitest';
import { shareErrorResponseSchema, type ContainerInfo } from '@hz/shared';
import { containerPriorities } from '../src/db/schema.js';
import { metricsMsg, type Received, type WsClient } from './agent-helpers.js';
import {
  containerByName,
  info,
  inventory,
  withAgent,
  type AgentSetup,
} from './container-helpers.js';
import { gameRequest, readyGame, rpcsOf, withGames, type GameSetup } from './games-helpers.js';
import { authHeaders, completeSetup, makeApp, SAME_ORIGIN, type TestApp } from './helpers.js';
import { createShare, friend } from './share-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const MIN = 60_000;

const protectedOnly = (): ContainerInfo[] => [
  info('hz-core', { cpu: 99, role: 'core' }),
  info('hz-agent', { cpu: 97, role: 'agent' }),
  info('worker', { cpu: 2 }),
];

async function setup(list: ContainerInfo[] = protectedOnly()): Promise<AgentSetup> {
  const s = await withAgent(clients, { containers: list });
  t = s.t;
  return s;
}

const req = (
  s: AgentSetup | GameSetup,
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  payload?: unknown,
) =>
  s.t.app.inject({
    method,
    url,
    headers: authHeaders(s.cookie),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const idOf = (s: AgentSetup, name: string): string => containerByName(s.t, name)?.id ?? '';
const actions = (s: AgentSetup, ...names: string[]): Received[] =>
  s.rpcs.filter((r) => names.includes(String(r.action)));

async function overFor(s: AgentSetup | GameSetup, minutes: number, cpu = 97): Promise<void> {
  for (let i = 0; i <= minutes; i++) {
    if (i > 0) s.t.clock.advance(MIN);
    s.t.app.hzCore.servers.ingestMetrics(s.serverId, metricsMsg({ cpu }));
    if ('behaviour' in s) await s.t.app.hzCore.games.statusTick();
    await s.t.app.hzCore.throttle.tick();
    if ('behaviour' in s) await s.t.app.hzCore.games.idle();
  }
}

describe('M10 security: core and agent are never a target', () => {
  it('refuses priority, throttle and unthrottle for hz.role containers (403, no RPC)', async () => {
    const s = await setup();
    for (const name of ['hz-core', 'hz-agent']) {
      const id = idOf(s, name);
      expect(
        (await req(s, 'PUT', `/api/containers/${id}/priority`, { priority: 'niedrig' })).statusCode,
      ).toBe(403);
      expect((await req(s, 'POST', `/api/containers/${id}/throttle`, { cpus: 1 })).statusCode).toBe(
        403,
      );
      expect((await req(s, 'POST', `/api/containers/${id}/unthrottle`, {})).statusCode).toBe(403);
      const p = await req(s, 'GET', `/api/containers/${id}/priority`);
      expect(p.json()).toMatchObject({ priority: 'wichtig', protected: true, allowStop: false });
      expect(containerByName(s.t, name)).toMatchObject({ priority: 'wichtig', protected: true });
    }
    expect(actions(s, 'container.limit', 'container.stop')).toHaveLength(0);
  });

  it('never throttles or stops them, even with a niedrig row planted in the database', async () => {
    const s = await setup();
    for (const name of ['hz-core', 'hz-agent']) {
      const c = containerByName(s.t, name);
      s.t.db.db
        .insert(containerPriorities)
        .values({
          containerId: c?.id ?? '',
          serverId: s.serverId,
          containerName: name,
          priority: 'niedrig',
          allowStop: true,
          updatedAt: s.t.clock.t,
        })
        .run();
    }
    await overFor(s, 30);
    expect(actions(s, 'container.limit', 'container.stop', 'container.start')).toHaveLength(0);
    // They are not restarted either (the core cannot restart itself or its agent).
    inventory(s.t, s.serverId, [
      info('hz-core', { state: 'exited', exitCode: 1, role: 'core' }),
      info('hz-agent', { state: 'exited', exitCode: 1, role: 'agent' }),
    ]);
    await overFor(s, 3, 10);
    expect(actions(s, 'container.start')).toHaveLength(0);
  });

  it('normal and wichtig containers are never touched by the rule set', async () => {
    const s = await setup([info('web', { cpu: 90 }), info('db', { cpu: 80 })]);
    await req(s, 'PUT', `/api/containers/${idOf(s, 'db')}/priority`, { priority: 'wichtig' });
    await overFor(s, 30);
    expect(actions(s, 'container.limit', 'container.stop')).toHaveLength(0);
  });
});

describe('M10 security: admin session and input bounds', () => {
  it('every new route answers 401 without a session and 403 without Origin', async () => {
    t = await makeApp();
    const admin = await completeSetup(t);
    const id = 'AAAAAAAAAAAAAAAAAAAAAA';
    const routes: ['GET' | 'PUT' | 'POST', string, Record<string, unknown>?][] = [
      ['GET', `/api/containers/${id}/priority`],
      ['PUT', `/api/containers/${id}/priority`, { priority: 'niedrig' }],
      ['POST', `/api/containers/${id}/throttle`, { cpus: 1 }],
      ['POST', `/api/containers/${id}/unthrottle`, {}],
      ['GET', `/api/games/${id}/priority`],
      ['PUT', `/api/games/${id}/priority`, { priority: 'niedrig' }],
      ['GET', `/api/servers/${id}/throttle`],
      ['PUT', `/api/servers/${id}/throttle`, { settings: { enabled: false } }],
      ['GET', '/api/overview/top-consumers'],
    ];
    const registered = t.app.hzRoutes.map((r) => `${r.method} ${r.url}`);
    for (const [method, url, payload] of routes) {
      expect(registered).toContain(`${method} ${url.replace(id, ':id')}`);
      const anon = await t.app.inject({
        method,
        url,
        headers: SAME_ORIGIN,
        ...(payload ? { payload } : {}),
      });
      expect(anon.statusCode, `${method} ${url}`).toBe(401);
      if (method !== 'GET') {
        const noOrigin = await t.app.inject({
          method,
          url,
          headers: { host: SAME_ORIGIN.host, cookie: authHeaders(admin.cookie).cookie ?? '' },
          ...(payload ? { payload } : {}),
        });
        expect(noOrigin.statusCode, `${method} ${url}`).toBe(403);
      }
    }
  });

  it('cpus outside 0.1..64 or not a number is 400 and never reaches the agent', async () => {
    const s = await setup();
    const id = idOf(s, 'worker');
    for (const cpus of [0, 0.05, -1, 65, 1e9, '1', null, true]) {
      const res = await req(s, 'POST', `/api/containers/${id}/throttle`, { cpus });
      expect(res.statusCode, JSON.stringify(cpus)).toBe(400);
    }
    expect((await req(s, 'POST', `/api/containers/${id}/throttle`, {})).statusCode).toBe(400);
    expect(
      (await req(s, 'POST', `/api/containers/${id}/throttle`, { cpus: 1, extra: 1 })).statusCode,
    ).toBe(400);
    for (const settings of [
      { throttleCpus: 0 },
      { throttleCpus: 65 },
      { cpuPct: 100 },
      { forMinutes: 0 },
    ]) {
      expect(
        (await req(s, 'PUT', `/api/servers/${s.serverId}/throttle`, { settings })).statusCode,
      ).toBe(400);
    }
    const badWindow = {
      tier: 'niedrig',
      days: ['mo'],
      from: '18:00',
      to: '23:00',
      mode: 'cpus',
      cpus: 100,
    };
    expect(
      (await req(s, 'PUT', `/api/servers/${s.serverId}/throttle`, { schedules: [badWindow] }))
        .statusCode,
    ).toBe(400);
    expect(actions(s, 'container.limit')).toHaveLength(0);
    // In bounds: rounded to 2 decimals.
    const ok = await req(s, 'POST', `/api/containers/${id}/throttle`, { cpus: 1.234 });
    expect(ok.statusCode).toBe(200);
    expect(actions(s, 'container.limit')[0]?.params).toEqual({
      id: containerByName(s.t, 'worker')?.dockerId,
      cpus: 1.23,
    });
  });

  it('allowStop only with niedrig (400)', async () => {
    const s = await setup();
    const id = idOf(s, 'worker');
    const res = await req(s, 'PUT', `/api/containers/${id}/priority`, {
      priority: 'normal',
      allowStop: true,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('M10 security: game servers', () => {
  it('a share link cannot bypass the RAM reserve (409 without details)', async () => {
    const s = await withGames(clients);
    t = s.t;
    const g = await readyGame(s);
    expect((await gameRequest(s, 'POST', `/api/games/${g.id}/stop`)).statusCode).toBe(200);
    await gameRequest(s, 'PUT', `/api/servers/${s.serverId}/throttle`, {
      settings: { ramReserveMb: 8192 },
    });
    const link = await createShare(s, g.id, { perms: ['power', 'restart'] });
    const ups = rpcsOf(s, 'compose.up').length;
    for (const action of ['start', 'restart']) {
      const res = await friend(s, 'POST', 'action', { token: link.token, payload: { action } });
      expect(res.statusCode, action).toBe(409);
      const body = shareErrorResponseSchema.parse(res.json());
      expect(body).toEqual({ ok: false, error: 'insufficient_ram' });
      expect(res.body).not.toContain('Bytes');
    }
    expect(rpcsOf(s, 'compose.up')).toHaveLength(ups);
  });

  it('does not stop a game with players online unless allowed; saves via RCON first', async () => {
    const s = await withGames(clients);
    t = s.t;
    const g = await readyGame(s);
    const res = await gameRequest(s, 'PUT', `/api/games/${g.id}/priority`, {
      priority: 'niedrig',
      allowStop: true,
    });
    expect(res.statusCode).toBe(200);
    await overFor(s, 15);
    expect(s.t.app.hzCore.games.summary(g.id)?.throttled?.by).toBe('auto');
    expect(rpcsOf(s, 'container.limit')).toHaveLength(1);
    expect(s.t.app.hzCore.games.summary(g.id)?.players?.online).toBe(2);
    expect(rpcsOf(s, 'compose.down')).toHaveLength(0);

    await gameRequest(s, 'PUT', `/api/games/${g.id}/priority`, {
      priority: 'niedrig',
      allowStop: true,
      allowStopWithPlayers: true,
    });
    await overFor(s, 1);
    const downs = rpcsOf(s, 'compose.down');
    expect(downs).toHaveLength(1);
    const save = rpcsOf(s, 'game.rcon').filter(
      (r) => (r.params as { command: string }).command === 'save-all',
    );
    expect(save).toHaveLength(1);
    expect(s.rpcs.indexOf(save[0] as Received)).toBeLessThan(s.rpcs.indexOf(downs[0] as Received));
    const after = s.t.app.hzCore.games.summary(g.id);
    expect(after).toMatchObject({ autoStopped: true, throttled: null, priority: 'niedrig' });
    expect(s.t.app.hzCore.alerts.active(`autostop:${s.serverId}:game-survival`)?.level).toBe(
      'warn',
    );
  });

  it('the priority of a game container is set on the game (409 on the container route)', async () => {
    const s = await withGames(clients);
    t = s.t;
    await readyGame(s);
    const c = s.t.app.hzCore.containers.list().find((x) => x.name === 'game-survival');
    expect(c?.gameId).not.toBeNull();
    const res = await req(s, 'PUT', `/api/containers/${c?.id}/priority`, { priority: 'niedrig' });
    expect(res.statusCode).toBe(409);
  });
});

describe('M10 security: wichtig restart attempts are capped', () => {
  it('3 attempts in 10 min, then crit restart_failed and no further attempt', async () => {
    const s = await setup([info('webapp', { cpu: 1 })]);
    await req(s, 'PUT', `/api/containers/${idOf(s, 'webapp')}/priority`, { priority: 'wichtig' });
    inventory(s.t, s.serverId, [info('webapp', { state: 'exited', exitCode: 1 })]);
    for (let i = 0; i < 9; i++) {
      s.t.clock.advance(61_000);
      s.t.app.hzCore.servers.ingestMetrics(s.serverId, metricsMsg({ cpu: 10 }));
      await s.t.app.hzCore.throttle.tick();
    }
    expect(actions(s, 'container.start')).toHaveLength(3);
    const alert = s.t.app.hzCore.alerts.active(`autorestart:${s.serverId}:webapp`);
    expect(alert).toMatchObject({ level: 'crit', title: 'webapp startet nicht: heimserver' });
  });

  it('a wichtig container stopped by the admin through the API is not restarted', async () => {
    const s = await setup([info('webapp', { cpu: 1 })]);
    const id = idOf(s, 'webapp');
    await req(s, 'PUT', `/api/containers/${id}/priority`, { priority: 'wichtig' });
    expect((await req(s, 'POST', `/api/containers/${id}/stop`, {})).statusCode).toBe(200);
    inventory(s.t, s.serverId, [info('webapp', { state: 'exited', exitCode: 0 })]);
    for (let i = 0; i < 3; i++) {
      s.t.clock.advance(61_000);
      await s.t.app.hzCore.throttle.tick();
    }
    expect(actions(s, 'container.start')).toHaveLength(0);
  });
});

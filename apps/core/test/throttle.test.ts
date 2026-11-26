import { afterEach, describe, expect, it } from 'vitest';
import {
  containerActionResponseSchema,
  containerPriorityResponseSchema,
  defaultThrottleSettings,
  gamePriorityResponseSchema,
  gameSuggestResponseSchema,
  serverThrottleResponseSchema,
  topConsumersResponseSchema,
  type ContainerInfo,
  type ScheduleWindow,
} from '@hz/shared';
import { auditLog } from '../src/db/schema.js';
import { activeWindows, tierRule, windowActive } from '../src/throttle/schedule.js';
import { cores } from '../src/throttle/texts.js';
import { setTimeZone } from '../src/timezone.js';
import { metricsMsg, type Received, type WsClient } from './agent-helpers.js';
import {
  containerByName,
  info,
  inventory,
  withAgent,
  type AgentSetup,
} from './container-helpers.js';
import { gameRequest, readyGame, withGames } from './games-helpers.js';
import { authHeaders, T0, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
  setTimeZone('Europe/Vienna');
});

const MIN = 60_000;
const GB = 1024 ** 3;

const limitReply = (m: Received) =>
  m.action === 'container.limit'
    ? {
        type: 'rpc.result',
        id: m.id,
        ok: true,
        data: { cpus: (m.params as { cpus: number | null }).cpus },
      }
    : null;

async function setup(list: ContainerInfo[]): Promise<AgentSetup> {
  const s = await withAgent(clients, { containers: list, reply: limitReply });
  t = s.t;
  return s;
}

const req = (s: AgentSetup, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  s.t.app.inject({
    method,
    url,
    headers: authHeaders(s.cookie),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const idOf = (s: AgentSetup, name: string): string => containerByName(s.t, name)?.id ?? '';
const limits = (s: AgentSetup) => s.rpcs.filter((r) => r.action === 'container.limit');
const audits = (s: AgentSetup, action: string) =>
  s.t.db.db
    .select()
    .from(auditLog)
    .all()
    .filter((a) => a.action === action);

async function minutes(s: AgentSetup, cpu: number, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    s.t.clock.advance(MIN);
    s.t.app.hzCore.servers.ingestMetrics(s.serverId, metricsMsg({ cpu }));
    await s.t.app.hzCore.throttle.tick();
  }
}

describe('container priority routes', () => {
  it('defaults to normal, PUT stores it per server + name (survives a recreate), audited', async () => {
    const s = await setup([info('worker', { cpu: 10 })]);
    const id = idOf(s, 'worker');
    const get = containerPriorityResponseSchema.parse(
      (await req(s, 'GET', `/api/containers/${id}/priority`)).json(),
    );
    expect(get).toMatchObject({
      priority: 'normal',
      allowStop: false,
      protected: false,
      gameId: null,
    });
    const put = await req(s, 'PUT', `/api/containers/${id}/priority`, {
      priority: 'niedrig',
      allowStop: true,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      containerId: id,
      containerName: 'worker',
      priority: 'niedrig',
      allowStop: true,
    });
    // Recreated (new docker id): same core id, same priority.
    inventory(s.t, s.serverId, [info('worker', { dockerId: 'f'.repeat(64) })]);
    expect(containerByName(s.t, 'worker')).toMatchObject({
      id,
      priority: 'niedrig',
      allowStop: true,
    });
    expect(audits(s, 'priority.changed')).toHaveLength(1);
  });

  it('rejects invalid input and unknown containers', async () => {
    const s = await setup([info('worker')]);
    const id = idOf(s, 'worker');
    for (const body of [{}, { priority: 'hoch' }, { priority: 'niedrig', x: 1 }]) {
      expect((await req(s, 'PUT', `/api/containers/${id}/priority`, body)).statusCode).toBe(400);
    }
    expect(
      (await req(s, 'PUT', '/api/containers/bad!id/priority', { priority: 'normal' })).statusCode,
    ).toBe(400);
    expect(
      (
        await req(s, 'PUT', '/api/containers/AAAAAAAAAAAAAAAAAAAAAA/priority', {
          priority: 'normal',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('manual throttle', () => {
  it('limits a running container, restores the previous limit on unthrottle, audited', async () => {
    const s = await setup([
      info('worker', { cpu: 50, cpuLimit: 4 }),
      info('off', { state: 'exited', exitCode: 0 }),
    ]);
    const id = idOf(s, 'worker');
    const res = await req(s, 'POST', `/api/containers/${id}/throttle`, { cpus: 0.5 });
    expect(res.statusCode).toBe(200);
    const body = containerActionResponseSchema.parse(res.json());
    expect(body.container?.throttled).toMatchObject({
      cpus: 0.5,
      by: 'admin',
      reason: 'Von Hand gedrosselt',
    });
    const un = await req(s, 'POST', `/api/containers/${id}/unthrottle`, {});
    expect(un.statusCode).toBe(200);
    expect(containerActionResponseSchema.parse(un.json()).container?.throttled).toBeNull();
    expect(limits(s).map((r) => (r.params as { cpus: number | null }).cpus)).toEqual([0.5, 4]);
    expect(audits(s, 'throttle.applied')).toHaveLength(1);
    expect(audits(s, 'throttle.removed')[0]?.actor).toBe('admin');
    // Unthrottle of an unthrottled container: nothing to do, no RPC.
    expect((await req(s, 'POST', `/api/containers/${id}/unthrottle`, {})).statusCode).toBe(200);
    expect(limits(s)).toHaveLength(2);
    // Not running: 409.
    expect(
      (await req(s, 'POST', `/api/containers/${idOf(s, 'off')}/throttle`, { cpus: 1 })).statusCode,
    ).toBe(409);
  });

  it('an admin throttle is never lifted by the rule set', async () => {
    const s = await setup([info('worker', { cpu: 50 })]);
    const id = idOf(s, 'worker');
    await req(s, 'PUT', `/api/containers/${id}/priority`, { priority: 'niedrig' });
    await req(s, 'POST', `/api/containers/${id}/throttle`, { cpus: 2 });
    await minutes(s, 10, 30);
    expect(containerByName(s.t, 'worker')?.throttled).toMatchObject({ by: 'admin', cpus: 2 });
    expect(limits(s)).toHaveLength(1);
  });

  it('a recreated container loses its throttle (the limit belonged to the old one)', async () => {
    const s = await setup([info('worker', { cpu: 50 })]);
    const id = idOf(s, 'worker');
    await req(s, 'POST', `/api/containers/${id}/throttle`, { cpus: 2 });
    inventory(s.t, s.serverId, [info('worker', { dockerId: 'e'.repeat(64) })]);
    expect(containerByName(s.t, 'worker')?.throttled).toBeNull();
  });
});

describe('server throttle settings', () => {
  it('GET returns defaults, PUT merges a patch and replaces schedules, audited', async () => {
    const s = await setup([info('worker')]);
    const get = serverThrottleResponseSchema.parse(
      (await req(s, 'GET', `/api/servers/${s.serverId}/throttle`)).json(),
    );
    expect(get.settings).toEqual(defaultThrottleSettings);
    expect(get.schedules).toEqual([]);
    expect(get.status).toMatchObject({ phase: 'idle', since: null, activeWindows: [] });
    const w: ScheduleWindow = {
      tier: 'niedrig',
      days: ['mo', 'di'],
      from: '18:00',
      to: '23:00',
      mode: 'cpus',
      cpus: 2,
    };
    const put = await req(s, 'PUT', `/api/servers/${s.serverId}/throttle`, {
      settings: { cpuPct: 80 },
      schedules: [w],
    });
    expect(put.statusCode).toBe(200);
    const after = serverThrottleResponseSchema.parse(put.json());
    expect(after.settings).toEqual({ ...defaultThrottleSettings, cpuPct: 80 });
    expect(after.schedules).toEqual([w]);
    await req(s, 'PUT', `/api/servers/${s.serverId}/throttle`, { settings: { ramPct: 85 } });
    const again = serverThrottleResponseSchema.parse(
      (await req(s, 'GET', `/api/servers/${s.serverId}/throttle`)).json(),
    );
    expect(again.settings).toMatchObject({ cpuPct: 80, ramPct: 85 });
    expect(again.schedules).toEqual([w]);
    expect(audits(s, 'throttle.settings_changed')).toHaveLength(2);
    expect((await req(s, 'GET', '/api/servers/AAAAAAAAAAAAAAAAAAAA/throttle')).statusCode).toBe(
      404,
    );
    expect(
      (await req(s, 'PUT', `/api/servers/${s.serverId}/throttle`, { other: 1 })).statusCode,
    ).toBe(400);
  });

  it('Automatik off: no action at all, and its throttles are lifted', async () => {
    const s = await setup([info('worker', { cpu: 50 })]);
    await req(s, 'PUT', `/api/containers/${idOf(s, 'worker')}/priority`, {
      priority: 'niedrig',
      allowStop: true,
    });
    await minutes(s, 96, 3);
    expect(containerByName(s.t, 'worker')?.throttled?.by).toBe('auto');
    const off = await req(s, 'PUT', `/api/servers/${s.serverId}/throttle`, {
      settings: { enabled: false },
    });
    expect(serverThrottleResponseSchema.parse(off.json()).status.phase).toBe('disabled');
    expect(containerByName(s.t, 'worker')?.throttled).toBeNull();
    const n = s.rpcs.length;
    await minutes(s, 96, 20);
    expect(s.rpcs.length).toBe(n);
  });

  it('a cpus window limits the tier while active and lifts it at the end', async () => {
    const s = await setup([info('worker', { cpu: 5 }), info('web', { cpu: 5 })]);
    await req(s, 'PUT', `/api/containers/${idOf(s, 'worker')}/priority`, { priority: 'niedrig' });
    // T0 = Wednesday 13:00 Vienna; window 13:00-13:10 for normal and niedrig.
    await req(s, 'PUT', `/api/servers/${s.serverId}/throttle`, {
      schedules: [
        { tier: 'niedrig', days: ['mi'], from: '13:00', to: '13:10', mode: 'cpus', cpus: 3 },
        { tier: 'normal', days: ['mi'], from: '13:00', to: '13:10', mode: 'cpus', cpus: 6 },
      ],
    });
    await minutes(s, 10, 1);
    expect(containerByName(s.t, 'worker')?.throttled).toMatchObject({ by: 'schedule', cpus: 3 });
    expect(containerByName(s.t, 'web')?.throttled).toMatchObject({ by: 'schedule', cpus: 6 });
    // The admin lifts it: not limited again until the window ends.
    await req(s, 'POST', `/api/containers/${idOf(s, 'web')}/unthrottle`, {});
    await minutes(s, 10, 2);
    expect(containerByName(s.t, 'web')?.throttled).toBeNull();
    await minutes(s, 10, 8);
    expect(containerByName(s.t, 'worker')?.throttled).toBeNull();
    expect(
      limits(s).filter((r) => (r.params as { cpus: number | null }).cpus === null),
    ).toHaveLength(2);
  });
});

describe('derived RAM reserve', () => {
  it('counts wichtig containers, stopped ones with their last known memory', async () => {
    const s = await setup([info('db', { memBytes: 2 * GB }), info('web', { memBytes: 1 * GB })]);
    await req(s, 'PUT', `/api/containers/${idOf(s, 'db')}/priority`, { priority: 'wichtig' });
    s.t.app.hzCore.servers.ingestMetrics(s.serverId, metricsMsg({ ramPct: 50 }));
    const reserve = async () =>
      serverThrottleResponseSchema.parse(
        (await req(s, 'GET', `/api/servers/${s.serverId}/throttle`)).json(),
      ).status.ramReserveBytes;
    expect(await reserve()).toBe(2 * GB);
    inventory(s.t, s.serverId, [
      info('db', { state: 'exited', exitCode: 1 }),
      info('web', { memBytes: GB }),
    ]);
    expect(containerByName(s.t, 'db')?.memBytes).toBeNull();
    expect(await reserve()).toBe(2 * GB);
    await req(s, 'PUT', `/api/servers/${s.serverId}/throttle`, { settings: { ramReserveMb: 512 } });
    expect(await reserve()).toBe(512 * 1024 * 1024);
  });
});

describe('top consumers', () => {
  it('top 3 running containers by CPU and by RAM over all servers', async () => {
    const s = await setup([
      info('a', { cpu: 10, memBytes: 4 * GB }),
      info('b', { cpu: 80, memBytes: 1 * GB }),
      info('c', { cpu: 40, memBytes: 2 * GB }),
      info('d', { cpu: 20 }),
      info('hz-agent', { cpu: 1, memBytes: 0.1 * GB, role: 'agent' }),
      info('e', { state: 'exited', exitCode: 0, cpu: 99 }),
    ]);
    const res = await req(s, 'GET', '/api/overview/top-consumers');
    expect(res.statusCode).toBe(200);
    const body = topConsumersResponseSchema.parse(res.json());
    expect(body.byCpu.map((c) => c.containerName)).toEqual(['b', 'c', 'd']);
    expect(body.byRam.map((c) => c.containerName)).toEqual(['a', 'c', 'b']);
    expect(body.byCpu[0]).toMatchObject({
      serverName: 'heimserver',
      priority: 'normal',
      isGame: false,
      gameId: null,
    });
  });
});

describe('game priority and RAM reserve', () => {
  it('GET/PUT game priority; the game summary and its container show it', async () => {
    const s = await withGames(clients);
    t = s.t;
    const g = await readyGame(s);
    expect(
      gamePriorityResponseSchema.parse(
        (await gameRequest(s, 'GET', `/api/games/${g.id}/priority`)).json(),
      ),
    ).toEqual({
      gameId: g.id,
      priority: 'normal',
      allowStop: false,
      allowStopWithPlayers: false,
    });
    const bad = await gameRequest(s, 'PUT', `/api/games/${g.id}/priority`, {
      priority: 'niedrig',
      allowStopWithPlayers: true,
    });
    expect(bad.statusCode).toBe(400);
    const put = await gameRequest(s, 'PUT', `/api/games/${g.id}/priority`, {
      priority: 'niedrig',
      allowStop: true,
    });
    expect(put.statusCode).toBe(200);
    expect(s.t.app.hzCore.games.summary(g.id)).toMatchObject({
      priority: 'niedrig',
      allowStop: true,
    });
    const c = s.t.app.hzCore.containers.list().find((x) => x.name === 'game-survival');
    expect(c).toMatchObject({ priority: 'niedrig', allowStop: true, gameId: g.id });
    expect(
      (await gameRequest(s, 'PUT', '/api/games/AAAAAAAAAAAAAAAA/priority', { priority: 'normal' }))
        .statusCode,
    ).toBe(404);
  });

  it('derives the reserve from wichtig containers and shows it in the suggestion', async () => {
    const s = await withGames(clients);
    t = s.t;
    const g = await readyGame(s);
    // The running game (3 GB) is wichtig: a second game must leave its RAM free.
    await gameRequest(s, 'PUT', `/api/games/${g.id}/priority`, { priority: 'wichtig' });
    const sug = gameSuggestResponseSchema.parse(
      (
        await gameRequest(
          s,
          'GET',
          `/api/games/suggest?templateId=minecraft-java&serverId=${s.serverId}`,
        )
      ).json(),
    );
    expect(sug.ramReserveBytes).toBe(3 * GB);
    // compose down removed the container: nothing left to reserve.
    await gameRequest(s, 'POST', `/api/games/${g.id}/stop`);
    const st = serverThrottleResponseSchema.parse(
      (await gameRequest(s, 'GET', `/api/servers/${s.serverId}/throttle`)).json(),
    );
    expect(st.status.ramReserveBytes).toBe(0);
    expect((await gameRequest(s, 'POST', `/api/games/${g.id}/start`)).statusCode).toBe(200);
  });
});

describe('schedule windows (HZ_TIMEZONE)', () => {
  const w = (over: Partial<ScheduleWindow>): ScheduleWindow => ({
    tier: 'niedrig',
    days: ['mo', 'di', 'mi', 'do', 'fr'],
    from: '18:00',
    to: '23:00',
    mode: 'no_throttle',
    ...over,
  });
  // T0 = 2026-11-25 (Wednesday) 12:00 UTC = 13:00 in Vienna.
  const at = (h: number, m = 0, dayOffset = 0) =>
    T0 + dayOffset * 86_400_000 + ((h - 13) * 60 + m) * MIN;

  it('same-day windows', () => {
    expect(windowActive(w({}), at(18))).toBe(true);
    expect(windowActive(w({}), at(17, 59))).toBe(false);
    expect(windowActive(w({}), at(23))).toBe(false);
    // Saturday
    expect(windowActive(w({}), at(19, 0, 3))).toBe(false);
  });

  it('over midnight belongs to the start day', () => {
    const night = w({ days: ['fr'], from: '22:00', to: '02:00' });
    expect(windowActive(night, at(23, 0, 2))).toBe(true); // Friday 23:00
    expect(windowActive(night, at(1, 0, 3))).toBe(true); // Saturday 01:00
    expect(windowActive(night, at(1, 0, 2))).toBe(false); // Friday 01:00
  });

  it('uses the configured time zone', () => {
    setTimeZone('UTC');
    expect(windowActive(w({ from: '12:00', to: '13:00', days: ['mi'] }), T0)).toBe(true);
    setTimeZone('Europe/Vienna');
    expect(windowActive(w({ from: '12:00', to: '13:00', days: ['mi'] }), T0)).toBe(false);
  });

  it('no_throttle wins, the highest cpus counts', () => {
    const list = [
      w({ mode: 'cpus', cpus: 2, from: '00:00', to: '23:59', days: ['mi'] }),
      w({ mode: 'cpus', cpus: 4, from: '00:00', to: '23:59', days: ['mi'] }),
    ];
    expect(tierRule(list, activeWindows(list, T0), 'niedrig')).toEqual({ kind: 'cpus', cpus: 4 });
    expect(tierRule(list, activeWindows(list, T0), 'normal')).toEqual({ kind: 'none' });
    const withNo = [...list, w({ from: '00:00', to: '23:59', days: ['mi'] })];
    expect(tierRule(withNo, activeWindows(withNo, T0), 'niedrig')).toEqual({ kind: 'no_throttle' });
  });

  it('formats cores in de-AT', () => {
    expect(cores(1)).toBe('1 Kern');
    expect(cores(1.5)).toBe('1,5 Kerne');
  });
});

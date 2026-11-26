import { afterEach, describe, expect, it } from 'vitest';
import {
  containerSummarySchema,
  errorResponseSchema,
  gameResponseSchema,
  type ContainerInfo,
} from '@hz/shared';
import { metricsMsg, type Received, type WsClient } from './agent-helpers.js';
import {
  containerByName,
  info,
  inventory,
  withAgent,
  type AgentSetup,
} from './container-helpers.js';
import { gameRequest, readyGame, rpcsOf, withGames, type GameSetup } from './games-helpers.js';
import { authHeaders, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const MIN = 60_000;

/** Fake agent that answers container.limit like the real one ({ cpus }). */
const limitReply = (m: Received) =>
  m.action === 'container.limit'
    ? {
        type: 'rpc.result',
        id: m.id,
        ok: true,
        data: { cpus: (m.params as { cpus: number | null }).cpus },
      }
    : null;

const baseContainers = (): ContainerInfo[] => [
  info('minecraft', { cpu: 85, memBytes: 4 * 1024 ** 3 }),
  info('backup-job', { cpu: 5 }),
  info('webapp', { cpu: 3, memBytes: 512 * 1024 ** 2 }),
  info('hz-core', { cpu: 99, role: 'core' }),
  info('hz-agent', { cpu: 98, role: 'agent' }),
];

async function setup(list: ContainerInfo[] = baseContainers()): Promise<AgentSetup> {
  const s = await withAgent(clients, { containers: list, reply: limitReply });
  t = s.t;
  return s;
}

function put(s: AgentSetup, url: string, payload: Record<string, unknown>) {
  return s.t.app.inject({ method: 'PUT', url, headers: authHeaders(s.cookie), payload });
}

const idOf = (s: AgentSetup, name: string): string => {
  const c = containerByName(s.t, name);
  if (!c) throw new Error(`no container ${name}`);
  return c.id;
};

async function priority(
  s: AgentSetup,
  name: string,
  p: 'wichtig' | 'normal' | 'niedrig',
  allowStop = false,
) {
  const res = await put(s, `/api/containers/${idOf(s, name)}/priority`, { priority: p, allowStop });
  expect(res.statusCode, res.body).toBe(200);
}

/** One minute later: new metrics, then the rule set. */
async function minute(s: AgentSetup, cpu: number, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    s.t.clock.advance(MIN);
    s.t.app.hzCore.servers.ingestMetrics(s.serverId, metricsMsg({ cpu }));
    await s.t.app.hzCore.throttle.tick();
  }
}

const limits = (s: AgentSetup) => s.rpcs.filter((r) => r.action === 'container.limit');
const ofAction = (s: AgentSetup, action: string) => s.rpcs.filter((r) => r.action === action);

describe('M10 acceptance: throttle, stop, restart, schedule, RAM reserve', () => {
  it('throttles the niedrig container over the threshold and stops it 5 min later', async () => {
    const s = await setup();
    await priority(s, 'minecraft', 'niedrig', true);
    await priority(s, 'backup-job', 'niedrig');
    expect(s.t.app.hzCore.scheduler.has('throttle.tick')).toBe(true);

    // CPU 96 % from now on. After 1 minute nothing yet.
    s.t.app.hzCore.servers.ingestMetrics(s.serverId, metricsMsg({ cpu: 96 }));
    await s.t.app.hzCore.throttle.tick();
    await minute(s, 96);
    expect(limits(s)).toHaveLength(0);

    // After 2 minutes: the niedrig container with the highest CPU, never core/agent.
    await minute(s, 96);
    expect(limits(s)).toHaveLength(1);
    const mc = containerByName(s.t, 'minecraft');
    expect(limits(s)[0]?.params).toEqual({ id: mc?.dockerId, cpus: 1 });
    expect(mc?.throttled).toMatchObject({
      cpus: 1,
      by: 'auto',
      reason: 'heimserver CPU 96 % seit 2 Min',
    });
    expect(containerSummarySchema.parse(mc).priority).toBe('niedrig');
    const alert = s.t.app.hzCore.alerts.active(`throttle:${s.serverId}:minecraft`);
    expect(alert).toMatchObject({
      level: 'warn',
      title: 'minecraft gedrosselt: heimserver CPU 96 % seit 2 Min',
    });

    // Still over: after the next forMinutes step the next niedrig container (one per step).
    await minute(s, 96, 2);
    expect(limits(s).map((r) => (r.params as { id: string }).id)).toEqual([
      mc?.dockerId,
      containerByName(s.t, 'backup-job')?.dockerId,
    ]);

    // 5 minutes after the throttle: minecraft (allowStop) is stopped, backup-job (no allowStop) is not.
    await minute(s, 96, 2);
    expect(ofAction(s, 'container.stop')).toHaveLength(0);
    await minute(s, 96);
    expect(ofAction(s, 'container.stop')).toHaveLength(1);
    expect(ofAction(s, 'container.stop')[0]?.params).toEqual({ id: mc?.dockerId });
    inventory(s.t, s.serverId, [
      ...baseContainers().filter((c) => c.name !== 'minecraft'),
      info('minecraft', { state: 'exited', exitCode: 0 }),
    ]);
    const stopped = containerByName(s.t, 'minecraft');
    expect(stopped).toMatchObject({ autoStopped: true, throttled: null, status: 'off' });
    expect(s.t.app.hzCore.alerts.active(`autostop:${s.serverId}:minecraft`)?.level).toBe('warn');

    // Never a target: core, agent and the normal webapp.
    const targets = new Set(
      [...limits(s), ...ofAction(s, 'container.stop')].map((r) => (r.params as { id: string }).id),
    );
    for (const n of ['hz-core', 'hz-agent', 'webapp']) {
      expect(targets.has(containerByName(s.t, n)?.dockerId ?? '')).toBe(false);
    }

    // Recovery: 10 min below threshold minus 10 points lifts the auto throttle of backup-job.
    await minute(s, 50, 10);
    expect(containerByName(s.t, 'backup-job')?.throttled).not.toBeNull();
    await minute(s, 50);
    expect(containerByName(s.t, 'backup-job')?.throttled).toBeNull();
    expect(limits(s).at(-1)?.params).toEqual({
      id: containerByName(s.t, 'backup-job')?.dockerId,
      cpus: null,
    });
    // The auto-stopped container is not restarted.
    expect(ofAction(s, 'container.start')).toHaveLength(0);
    expect(containerByName(s.t, 'minecraft')?.autoStopped).toBe(true);
    // Admin starts it again ("Wieder starten"): the mark and the alert go.
    inventory(s.t, s.serverId, baseContainers());
    expect(containerByName(s.t, 'minecraft')?.autoStopped).toBe(false);
    expect(s.t.app.hzCore.alerts.active(`autostop:${s.serverId}:minecraft`)).toBeNull();
  });

  it('restarts a stopped wichtig container within 1 min', async () => {
    const s = await setup();
    await priority(s, 'webapp', 'wichtig');
    inventory(s.t, s.serverId, [
      ...baseContainers().filter((c) => c.name !== 'webapp'),
      info('webapp', { state: 'exited', exitCode: 137 }),
    ]);
    s.t.clock.advance(10_000);
    s.t.app.hzCore.servers.ingestMetrics(s.serverId, metricsMsg({ cpu: 20 }));
    await s.t.app.hzCore.scheduler.tick();
    const starts = ofAction(s, 'container.start');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.params).toEqual({ id: containerByName(s.t, 'webapp')?.dockerId });
    expect(s.t.app.hzCore.alerts.active(`autorestart:${s.serverId}:webapp`)?.level).toBe('warn');
  });

  it('does not throttle inside a no_throttle window and lifts auto throttles when it starts', async () => {
    const s = await setup();
    await priority(s, 'minecraft', 'niedrig', true);
    // T0 is Wednesday 13:00 in Europe/Vienna. Window from 13:05.
    const res = await put(s, `/api/servers/${s.serverId}/throttle`, {
      schedules: [
        { tier: 'niedrig', days: ['mi'], from: '13:05', to: '23:00', mode: 'no_throttle' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    s.t.app.hzCore.servers.ingestMetrics(s.serverId, metricsMsg({ cpu: 96 }));
    await s.t.app.hzCore.throttle.tick();
    await minute(s, 96, 2);
    expect(containerByName(s.t, 'minecraft')?.throttled?.by).toBe('auto');
    // 13:05: the window starts, the auto throttle is lifted.
    await minute(s, 96, 3);
    expect(containerByName(s.t, 'minecraft')?.throttled).toBeNull();
    // Inside the window: over the threshold for 20 min, nothing is throttled or stopped.
    const before = limits(s).length;
    await minute(s, 96, 20);
    expect(limits(s)).toHaveLength(before);
    expect(ofAction(s, 'container.stop')).toHaveLength(0);
    const st = await s.t.app.inject({
      method: 'GET',
      url: `/api/servers/${s.serverId}/throttle`,
      headers: authHeaders(s.cookie),
    });
    expect(st.json()).toMatchObject({ status: { activeWindows: [0], phase: 'over' } });
  });

  it('a game without room does not start (admin 409 with details)', async () => {
    const s: GameSetup = await withGames(clients);
    t = s.t;
    const g = await readyGame(s);
    expect((await gameRequest(s, 'POST', `/api/games/${g.id}/stop`)).statusCode).toBe(200);
    // 16 GB, 40 % used: 9,6 GB free. Reserve 4 GB: 5,6 GB left < 6 GB limit.
    const set = await gameRequest(s, 'PUT', `/api/servers/${s.serverId}/throttle`, {
      settings: { ramReserveMb: 4096 },
    });
    expect(set.statusCode).toBe(200);
    const ups = rpcsOf(s, 'compose.up').length;
    const res = await gameRequest(s, 'POST', `/api/games/${g.id}/start`);
    expect(res.statusCode).toBe(409);
    const body = errorResponseSchema.parse(res.json());
    expect(body.error).toBe('insufficient_ram');
    expect(body.message).toBe('Zu wenig RAM, 5,6 GB frei');
    expect(body.details?.freeBytes).toBeCloseTo(0.6 * 16 * 1024 ** 3, 0);
    expect(body.details).toMatchObject({
      reserveBytes: 4096 * 1024 ** 2,
      neededBytes: 6 * 1024 ** 3,
    });
    expect(rpcsOf(s, 'compose.up')).toHaveLength(ups);
    // With a smaller reserve it starts.
    await gameRequest(s, 'PUT', `/api/servers/${s.serverId}/throttle`, {
      settings: { ramReserveMb: 1024 },
    });
    const ok = await gameRequest(s, 'POST', `/api/games/${g.id}/start`);
    expect(ok.statusCode).toBe(200);
    expect(gameResponseSchema.parse(ok.json()).game.id).toBe(g.id);
  });
});

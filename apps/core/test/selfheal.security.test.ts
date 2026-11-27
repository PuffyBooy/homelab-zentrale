import { afterEach, describe, expect, it } from 'vitest';
import { errorResponseSchema, taskSchema, type ContainerInfo } from '@hz/shared';
import type { WsClient } from './agent-helpers.js';
import { containerByName, dockerIdOf, event, info, inventory } from './container-helpers.js';
import { SAME_ORIGIN, type TestApp } from './helpers.js';
import { api, MIN, rpcsOf, settle, withAutomation, type AutoSetup } from './tasks-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const SEC = 1000;

async function setup(
  list: ContainerInfo[],
  opts: Parameters<typeof withAutomation>[1] = {},
): Promise<AutoSetup> {
  const s = await withAutomation(clients, { containers: list, ...opts });
  t = s.t;
  return s;
}

async function healFor(s: AutoSetup, ms: number): Promise<void> {
  const svc = s.t.app.hzCore.features.selfheal.service;
  for (let i = 0; i < ms / (10 * SEC); i++) {
    s.t.clock.advance(10 * SEC);
    svc.tick();
    await svc.idle();
  }
}

const restartsOf = (s: AutoSetup, name: string) =>
  rpcsOf(s, 'container.restart').filter(
    (r) => (r.params as { id: string }).id === dockerIdOf(name),
  );

const idOf = (s: AutoSetup, name: string): string => {
  const c = containerByName(s.t, name);
  if (!c) throw new Error(`no container ${name}`);
  return c.id;
};

/** Every container in mode unhealthy_or_exited. */
async function crashMode(s: AutoSetup): Promise<void> {
  const res = await api(s, 'PUT', '/api/selfheal/settings', {
    defaultMode: 'unhealthy_or_exited',
    maxRestarts: 3,
    windowMinutes: 30,
    minGapSeconds: 120,
    unhealthyGraceSeconds: 30,
    checkDownMinutes: 3,
  });
  expect(res.statusCode, res.body).toBe(200);
}

const die = (s: AutoSetup, name: string, exitCode = 137): void =>
  event(s.t, s.serverId, {
    kind: 'container',
    action: 'die',
    name,
    dockerId: dockerIdOf(name),
    exitCode,
  });

const SID = 'abcdefgh12345678';
const ROUTES: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string }[] = [
  { method: 'GET', url: '/api/selfheal' },
  { method: 'PUT', url: '/api/selfheal/settings' },
  { method: 'PUT', url: `/api/selfheal/rules/${SID}/webapp` },
  { method: 'DELETE', url: `/api/selfheal/rules/${SID}/webapp` },
  { method: 'POST', url: `/api/selfheal/reset/${SID}/webapp` },
];

describe('selfheal security: auth and module switch', () => {
  it('every route answers 401 without a session', async () => {
    const s = await setup([info('webapp')]);
    for (const r of ROUTES) {
      const res = await s.t.app.inject({
        method: r.method,
        url: r.url,
        headers: SAME_ORIGIN,
        payload: {},
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('every route answers 404 module_disabled when the module is off', async () => {
    const s = await setup([info('webapp')], { modules: { selfheal: false } });
    for (const r of ROUTES) {
      const res = await api(
        s,
        r.method,
        r.url,
        r.method === 'GET' || r.method === 'DELETE' ? undefined : {},
      );
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
      expect(errorResponseSchema.parse(res.json()).error).toBe('module_disabled');
    }
  });
});

describe('selfheal security: hands off', () => {
  it('never heals hz.role containers, and refuses a rule for them', async () => {
    const s = await setup([
      info('hz-core', { role: 'core', health: 'unhealthy' }),
      info('hz-agent', { role: 'agent' }),
    ]);
    await crashMode(s);
    await healFor(s, 30 * SEC);
    die(s, 'hz-agent');
    await healFor(s, 10 * MIN);
    expect(rpcsOf(s, 'container.restart')).toHaveLength(0);
    const res = await api(s, 'PUT', `/api/selfheal/rules/${s.serverId}/hz-core`, {
      mode: 'unhealthy',
    });
    expect(res.statusCode).toBe(403);
    const v = await api(s, 'GET', '/api/selfheal');
    expect(v.json<{ state: unknown[]; events: unknown[] }>()).toMatchObject({
      state: [],
      events: [],
    });
  });

  it('never heals a container the admin stopped; watches it again once it was started', async () => {
    const s = await setup([info('webapp')]);
    await crashMode(s);
    await healFor(s, 10 * SEC);
    const stop = await api(s, 'POST', `/api/containers/${idOf(s, 'webapp')}/stop`);
    expect(stop.statusCode, stop.body).toBe(200);
    die(s, 'webapp', 143);
    await healFor(s, 10 * MIN);
    expect(restartsOf(s, 'webapp')).toHaveLength(0);
    // The admin starts it again: the stop intent ends; a later crash is healed.
    await api(s, 'POST', `/api/containers/${idOf(s, 'webapp')}/start`);
    event(s.t, s.serverId, {
      kind: 'container',
      action: 'start',
      name: 'webapp',
      dockerId: dockerIdOf('webapp'),
    });
    await healFor(s, 10 * SEC);
    die(s, 'webapp', 1);
    await healFor(s, 10 * SEC);
    expect(restartsOf(s, 'webapp')).toHaveLength(1);
  });

  it('never heals a container a scheduled task stopped', async () => {
    const s = await setup([info('webapp')]);
    await crashMode(s);
    await healFor(s, 10 * SEC);
    const created = await api(s, 'POST', '/api/tasks', {
      serverId: s.serverId,
      name: 'Nachts aus',
      action: { kind: 'container.stop', container: 'webapp' },
      schedule: { type: 'interval', minutes: 60 },
    });
    const task = taskSchema.parse(created.json());
    await api(s, 'POST', `/api/tasks/${task.id}/run`);
    await settle(s);
    die(s, 'webapp', 143);
    await healFor(s, 5 * MIN);
    expect(restartsOf(s, 'webapp')).toHaveLength(0);
  });

  it('never heals containers M10 stopped or throttles', async () => {
    const s = await setup([info('stopped-by-m10'), info('throttled', { health: 'unhealthy' })]);
    await crashMode(s);
    await healFor(s, 10 * SEC);
    const ins = s.t.db.sqlite.prepare(
      `INSERT INTO container_throttles (container_id, server_id, container_name, docker_id, cpus, by, reason, since, auto_stopped_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = s.t.clock.t;
    ins.run(
      idOf(s, 'stopped-by-m10'),
      s.serverId,
      'stopped-by-m10',
      null,
      null,
      null,
      null,
      null,
      now,
      now,
    );
    ins.run(
      idOf(s, 'throttled'),
      s.serverId,
      'throttled',
      dockerIdOf('throttled'),
      0.5,
      'auto',
      'CPU',
      now,
      null,
      now,
    );
    die(s, 'stopped-by-m10');
    await healFor(s, 10 * MIN);
    expect(rpcsOf(s, 'container.restart')).toHaveLength(0);
  });

  it('an exited wichtig container is left to M10; its unhealthy state is still healed', async () => {
    const s = await setup([info('wichtig-app')]);
    await crashMode(s);
    const p = await api(s, 'PUT', `/api/containers/${idOf(s, 'wichtig-app')}/priority`, {
      priority: 'wichtig',
      allowStop: false,
    });
    expect(p.statusCode, p.body).toBe(200);
    await healFor(s, 10 * SEC);
    die(s, 'wichtig-app');
    await healFor(s, 10 * SEC);
    // Only M10's own restart (throttle tick) may act; selfheal does not.
    const ownEvents = s.t.db.sqlite.prepare('SELECT count(*) AS n FROM selfheal_events').get() as {
      n: number;
    };
    expect(ownEvents.n).toBe(0);
    inventory(s.t, s.serverId, [info('wichtig-app', { health: 'unhealthy' })]);
    await healFor(s, 40 * SEC);
    const ev = s.t.db.sqlite.prepare('SELECT reason FROM selfheal_events').all() as {
      reason: string;
    }[];
    expect(ev).toEqual([{ reason: 'unhealthy' }]);
  });

  it('a restart in progress (restart intent, e.g. a deploy) is not interrupted', async () => {
    const s = await setup([info('webapp', { health: 'unhealthy' })]);
    s.t.app.hzCore.containers.setIntent(idOf(s, 'webapp'), 'restart', 15 * MIN);
    await healFor(s, 10 * MIN);
    expect(restartsOf(s, 'webapp')).toHaveLength(0);
  });
});

describe('selfheal security: schema limits', () => {
  it('rejects invalid settings, rules and params with 400', async () => {
    const s = await setup([info('webapp')]);
    const good = {
      defaultMode: 'unhealthy',
      maxRestarts: 3,
      windowMinutes: 30,
      minGapSeconds: 120,
      unhealthyGraceSeconds: 120,
      checkDownMinutes: 3,
    };
    for (const bad of [
      { ...good, maxRestarts: 0 },
      { ...good, maxRestarts: 11 },
      { ...good, windowMinutes: 9 },
      { ...good, windowMinutes: 1441 },
      { ...good, minGapSeconds: 29 },
      { ...good, unhealthyGraceSeconds: 1801 },
      { ...good, checkDownMinutes: 0 },
      { ...good, defaultMode: 'always' },
      { ...good, extra: 1 },
      { defaultMode: 'off' },
    ]) {
      const res = await api(s, 'PUT', '/api/selfheal/settings', bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    for (const bad of [
      { mode: 'restart' },
      { mode: 'off', checkId: 'x' },
      { mode: 'off', more: 1 },
      {},
    ]) {
      const res = await api(s, 'PUT', `/api/selfheal/rules/${s.serverId}/webapp`, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(
      (await api(s, 'PUT', `/api/selfheal/rules/${s.serverId}/..%2Fx`, { mode: 'off' })).statusCode,
    ).toBe(400);
    expect(
      (await api(s, 'PUT', `/api/selfheal/rules/bad!/webapp`, { mode: 'off' })).statusCode,
    ).toBe(400);
    // Unknown server / check: 404.
    expect(
      (await api(s, 'PUT', `/api/selfheal/rules/${SID}/webapp`, { mode: 'off' })).statusCode,
    ).toBe(404);
    expect((await api(s, 'POST', `/api/selfheal/reset/${SID}/webapp`)).statusCode).toBe(404);
    expect(
      (
        await api(s, 'PUT', `/api/selfheal/rules/${s.serverId}/webapp`, {
          mode: 'unhealthy',
          checkId: 'nocheck12345',
        })
      ).statusCode,
    ).toBe(404);
  });
});

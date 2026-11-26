import { afterEach, describe, expect, it } from 'vitest';
import {
  selfhealAlertKey,
  selfhealResponseSchema,
  selfhealRuleSchema,
  selfhealSettingsSchema,
  SELFHEAL_EVENTS_KEEP_DAYS,
  type ContainerInfo,
  type SelfhealResponse,
} from '@hz/shared';
import type { WsClient } from './agent-helpers.js';
import { containerByName, dockerIdOf, event, info, inventory } from './container-helpers.js';
import type { TestApp } from './helpers.js';
import { api, MIN, ok, rpcsOf, withAutomation, type AutoSetup } from './tasks-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const SEC = 1000;

const baseList = (over: Partial<ContainerInfo> = {}): ContainerInfo[] => [
  info('webapp', { health: 'unhealthy', ...over }),
  info('db', { health: 'healthy' }),
  info('hz-agent', { role: 'agent' }),
];

async function setup(opts: Parameters<typeof withAutomation>[1] = {}): Promise<AutoSetup> {
  const s = await withAutomation(clients, { containers: baseList(), ...opts });
  t = s.t;
  return s;
}

/** One selfheal tick `ms` later (the scheduler job does the same every 10 s). */
async function heal(s: AutoSetup, ms = 10 * SEC): Promise<void> {
  s.t.clock.advance(ms);
  const svc = s.t.app.hzCore.features.selfheal.service;
  svc.tick();
  await svc.idle();
}

/** Ticks every 10 s for `ms`. */
async function healFor(s: AutoSetup, ms: number): Promise<void> {
  for (let i = 0; i < ms / (10 * SEC); i++) await heal(s);
}

const restarts = (s: AutoSetup, name = 'webapp') =>
  rpcsOf(s, 'container.restart').filter(
    (r) => (r.params as { id: string }).id === dockerIdOf(name),
  );

const view = async (s: AutoSetup): Promise<SelfhealResponse> => {
  const res = await api(s, 'GET', '/api/selfheal');
  expect(res.statusCode, res.body).toBe(200);
  return selfhealResponseSchema.parse(res.json());
};

describe('M20 acceptance: self-healing', () => {
  it('restarts an unhealthy container, gives up after 3 attempts with CRIT, recovers after 10 min', async () => {
    const s = await setup();
    const key = selfhealAlertKey(s.serverId, 'webapp');
    // Within the grace (120 s): nothing.
    await healFor(s, 110 * SEC);
    expect(restarts(s)).toHaveLength(0);
    await healFor(s, 20 * SEC);
    expect(restarts(s)).toHaveLength(1);
    expect(s.t.app.hzCore.alerts.active(key)).toBeNull();

    // It stays unhealthy: two more restarts, then gave_up.
    await healFor(s, 15 * MIN);
    expect(restarts(s)).toHaveLength(3);
    const alert = s.t.app.hzCore.alerts.active(key);
    expect(alert?.level).toBe('crit');
    expect(alert?.title).toBe('webapp auf heimserver: Selbstheilung aufgegeben');
    let v = await view(s);
    expect(v.state).toEqual([
      expect.objectContaining({
        container: 'webapp',
        phase: 'gave_up',
        attempts: 3,
        lastReason: 'unhealthy',
      }),
    ]);
    expect(v.events.map((e) => e.action)).toEqual(['gave_up', 'restart', 'restart', 'restart']);
    expect(v.events.map((e) => e.attempt)).toEqual([3, 3, 2, 1]);

    // No further restarts while it is given up (also after the window passed).
    await healFor(s, 35 * MIN);
    expect(restarts(s)).toHaveLength(3);

    // Healthy for 10 minutes: recovered, alert resolved with an OK entry.
    inventory(s.t, s.serverId, baseList({ health: 'healthy' }));
    await healFor(s, 9 * MIN);
    expect(s.t.app.hzCore.alerts.active(key)).not.toBeNull();
    await healFor(s, 2 * MIN);
    expect(s.t.app.hzCore.alerts.active(key)).toBeNull();
    const okAlert = s.t.app.hzCore.alerts
      .list({ state: 'all', limit: 100 })
      .find((a) => a.key === key && a.level === 'ok');
    expect(okAlert?.title).toBe('webapp auf heimserver läuft wieder stabil');
    v = await view(s);
    expect(v.events[0]?.action).toBe('recovered');
    expect(v.state).toEqual([]);

    // Audit: every restart and the give-up.
    const audit = (
      s.t.db.sqlite
        .prepare("SELECT action FROM audit_log WHERE action LIKE 'selfheal.%' ORDER BY id")
        .all() as { action: string }[]
    ).map((r) => r.action);
    expect(audit).toEqual([
      'selfheal.restart',
      'selfheal.restart',
      'selfheal.restart',
      'selfheal.gave_up',
      'selfheal.recovered',
    ]);
  });
});

describe('selfheal: rule set', () => {
  it('a short unhealthy phase within the grace is not restarted', async () => {
    const s = await setup();
    await healFor(s, 100 * SEC);
    inventory(s.t, s.serverId, baseList({ health: 'healthy' }));
    await healFor(s, 5 * MIN);
    expect(restarts(s)).toHaveLength(0);
  });

  it('keeps minGapSeconds between restarts and honors maxRestarts from the settings', async () => {
    const s = await setup();
    const res = await api(s, 'PUT', '/api/selfheal/settings', {
      defaultMode: 'unhealthy',
      maxRestarts: 1,
      windowMinutes: 30,
      minGapSeconds: 600,
      unhealthyGraceSeconds: 30,
      checkDownMinutes: 1,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(selfhealSettingsSchema.parse(res.json()).maxRestarts).toBe(1);
    await healFor(s, 40 * SEC);
    expect(restarts(s)).toHaveLength(1);
    // The next trigger after minGap: limit 1 reached -> gave_up.
    await healFor(s, 9 * MIN);
    expect(s.t.app.hzCore.alerts.active(selfhealAlertKey(s.serverId, 'webapp'))).toBeNull();
    await healFor(s, 2 * MIN);
    expect(restarts(s)).toHaveLength(1);
    expect(s.t.app.hzCore.alerts.active(selfhealAlertKey(s.serverId, 'webapp'))?.level).toBe(
      'crit',
    );
  });

  it('a crash is only healed in mode unhealthy_or_exited (exit code != 0, seen running)', async () => {
    const list: ContainerInfo[] = [
      info('webapp'),
      info('worker'),
      info('oneshot'),
      info('legacy', { state: 'exited', exitCode: 1 }),
    ];
    const s = await setup({ containers: list });
    for (const name of ['webapp', 'oneshot', 'legacy']) {
      const r = await api(s, 'PUT', `/api/selfheal/rules/${s.serverId}/${name}`, {
        mode: 'unhealthy_or_exited',
      });
      expect(r.statusCode, r.body).toBe(200);
    }
    await heal(s);
    for (const name of ['webapp', 'worker']) {
      event(s.t, s.serverId, {
        kind: 'container',
        action: 'die',
        name,
        dockerId: dockerIdOf(name),
        exitCode: 137,
      });
    }
    event(s.t, s.serverId, {
      kind: 'container',
      action: 'die',
      name: 'oneshot',
      dockerId: dockerIdOf('oneshot'),
      exitCode: 0,
    });
    await heal(s);
    expect(restarts(s, 'webapp')).toHaveLength(1);
    // Default mode `unhealthy`: no crash healing.
    expect(restarts(s, 'worker')).toHaveLength(0);
    // A clean exit (0) is no crash; a container never seen running is not touched.
    expect(restarts(s, 'oneshot')).toHaveLength(0);
    expect(restarts(s, 'legacy')).toHaveLength(0);
    const v = await view(s);
    expect(v.events[0]).toMatchObject({ container: 'webapp', reason: 'exited', action: 'restart' });
  });

  it('restarts a container when its linked website check is DOWN for checkDownMinutes', async () => {
    const s = await setup({
      containers: [info('webapp', { health: 'healthy' })],
      reply: (m) =>
        m.action === 'check.tcp' ? ok(m, { ok: false, ms: null, error: 'refused' }) : null,
    });
    const c = await api(s, 'POST', '/api/checks', {
      kind: 'tcp',
      name: 'Webapp',
      host: 'webapp.example.org',
      port: 443,
      runFrom: s.serverId,
    });
    expect(c.statusCode, c.body).toBe(200);
    const checkId = c.json<{ check: { id: string } }>().check.id;
    const rule = await api(s, 'PUT', `/api/selfheal/rules/${s.serverId}/webapp`, {
      mode: 'unhealthy',
      checkId,
    });
    expect(selfhealRuleSchema.parse(rule.json())).toMatchObject({ checkId, mode: 'unhealthy' });
    for (let i = 0; i < 2; i++) {
      await api(s, 'POST', `/api/checks/${checkId}/run`);
      s.t.clock.advance(10 * SEC);
    }
    const status = s.t.db.sqlite.prepare('SELECT status FROM checks WHERE id = ?').get(checkId) as {
      status: string;
    };
    expect(status.status).toBe('crit');
    await heal(s, MIN);
    expect(restarts(s)).toHaveLength(0);
    await heal(s, 3 * MIN);
    expect(restarts(s)).toHaveLength(1);
    expect((await view(s)).events[0]).toMatchObject({ reason: 'check_down', action: 'restart' });
  });

  it('a failed restart is recorded and counts as an attempt', async () => {
    const s = await setup({
      reply: (m) =>
        m.action === 'container.restart'
          ? { type: 'rpc.result', id: m.id, ok: false, error: { code: 'failed', message: 'x' } }
          : null,
    });
    await healFor(s, 130 * SEC);
    const v = await view(s);
    expect(v.events[0]).toMatchObject({ action: 'restart_failed', attempt: 1 });
    expect(v.state[0]?.attempts).toBe(1);
    // The failed attempt released the intent (no restart intent left behind).
    const row = s.t.app.hzCore.containers.row(containerByName(s.t, 'webapp')?.id ?? '');
    expect(row?.intent).toBeNull();
  });

  it('reset: gave_up -> watching, alert closed, restarts resume', async () => {
    const s = await setup();
    await healFor(s, 20 * MIN);
    expect(restarts(s)).toHaveLength(3);
    expect((await view(s)).state[0]?.phase).toBe('gave_up');
    const res = await api(s, 'POST', `/api/selfheal/reset/${s.serverId}/webapp`);
    expect(res.statusCode).toBe(204);
    expect(s.t.app.hzCore.alerts.active(selfhealAlertKey(s.serverId, 'webapp'))).toBeNull();
    const v = await view(s);
    expect(v.state).toEqual([]);
    expect(v.events[0]).toMatchObject({ action: 'reset', attempt: 0 });
    await healFor(s, 130 * SEC);
    expect(restarts(s)).toHaveLength(4);
    // Reset of a container without history: 204, no event.
    expect((await api(s, 'POST', `/api/selfheal/reset/${s.serverId}/db`)).statusCode).toBe(204);
    expect((await view(s)).events.filter((e) => e.container === 'db')).toEqual([]);
  });

  it('rule off and module off: no restarts', async () => {
    const s = await setup();
    await api(s, 'PUT', `/api/selfheal/rules/${s.serverId}/webapp`, { mode: 'off' });
    await healFor(s, 5 * MIN);
    expect(restarts(s)).toHaveLength(0);
    expect((await api(s, 'DELETE', `/api/selfheal/rules/${s.serverId}/webapp`)).statusCode).toBe(
      204,
    );
    expect((await view(s)).rules).toEqual([]);
    s.t.app.hzCore.modules.set({ selfheal: false });
    await healFor(s, 5 * MIN);
    // Also the scheduler job is gone.
    expect(s.t.app.hzCore.scheduler.has('selfheal.tick')).toBe(false);
    expect(restarts(s)).toHaveLength(0);
    s.t.app.hzCore.modules.set({ selfheal: true });
    expect(s.t.app.hzCore.scheduler.has('selfheal.tick')).toBe(true);
  });

  it(`events older than ${SELFHEAL_EVENTS_KEEP_DAYS} days are removed`, async () => {
    const s = await setup();
    await healFor(s, 130 * SEC);
    expect((await view(s)).events).toHaveLength(1);
    s.t.clock.advance((SELFHEAL_EVENTS_KEEP_DAYS + 1) * 24 * 60 * MIN);
    s.t.app.hzCore.features.selfheal.service.prune();
    const n = s.t.db.sqlite.prepare('SELECT count(*) AS n FROM selfheal_events').get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });

  it('the scheduler job runs the rule set', async () => {
    const s = await setup();
    for (let i = 0; i < 14; i++) {
      s.t.clock.advance(10 * SEC);
      await s.t.app.hzCore.scheduler.tick();
      await s.t.app.hzCore.features.selfheal.idle();
    }
    expect(restarts(s)).toHaveLength(1);
  });
});

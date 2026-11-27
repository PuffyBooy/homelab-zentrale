import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultUpdatePolicy,
  updatesResponseSchema,
  updateServerStateSchema,
  type ContainerInfo,
  type ImageVersion,
  type SystemUpgradeData,
  type UpdatePolicy,
  type UpdatesResponse,
} from '@hz/shared';
import { setTimeZone } from '../src/timezone.js';
import { RUN_TIMEOUT_MS, UpdateService } from '../src/updates/service.js';
import { nextWindowAfter, openWindowAt } from '../src/updates/window.js';
import { enrollAgent, inventoryMsg, listen, stepUp, until, WsClient } from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
  setTimeZone('Europe/Vienna');
});

const MIN = 60_000;
/** Thursday 2026-11-26 03:00 in Vienna (CET, UTC+1). T0 is Wednesday 13:00 Vienna. */
const THU_0300 = Date.UTC(2026, 10, 26, 2, 0);

function v(tag: string): ImageVersion {
  return { imageId: `sha256:${createHash('sha256').update(tag).digest('hex')}`, version: tag };
}

const CORE_CONTAINER: ContainerInfo = {
  dockerId: 'cccccccccccc',
  name: 'homelab-zentrale',
  image: 'ghcr.io/owner/homelab-zentrale:latest',
  state: 'running',
  health: 'healthy',
  statusText: 'Up 2 days',
  ports: [],
  role: 'core',
};

async function setup() {
  t = await makeApp({ liveOptions: { throttleMs: 10 } });
  const admin = await completeSetup(t);
  const url = await listen(t);
  return { t, url, ...admin };
}

async function addAgent(s: { t: TestApp; url: string; cookie: string }, name = 'heimserver') {
  const e = await enrollAgent(s.t, s.url, s.cookie, name);
  clients.push(e.agent);
  return e;
}

async function makeCoreHost(t: TestApp, agent: WsClient, serverId: string): Promise<void> {
  const inv = inventoryMsg();
  agent.send({ ...inv, containers: [...inv.containers, CORE_CONTAINER] });
  await until(() => t.app.hzUpdates.hostsCore(serverId));
}

const req = (
  t: TestApp,
  cookie: string,
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  payload?: unknown,
) =>
  t.app.inject({
    method,
    url,
    headers: authHeaders(cookie),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const updates = async (t: TestApp, cookie: string): Promise<UpdatesResponse> =>
  updatesResponseSchema.parse((await req(t, cookie, 'GET', '/api/updates')).json());

const event = (event: Record<string, unknown>) => ({
  type: 'event',
  ts: new Date().toISOString(),
  event,
});

interface Script {
  /** Version the check reports as available (null: up to date). */
  available?: Partial<Record<'agent' | 'core', string | null>>;
  /** Outcome sent as update_result after update.apply; null: no event. */
  outcome?: (target: string) => { outcome: string; message?: string } | null;
  upgrade?: SystemUpgradeData;
  beforeUpgradeReply?: () => void;
}

/** Answers every RPC like a cooperative agent and records the actions (with target). */
function autoRespond(agent: WsClient, log: string[], script: Script = {}): void {
  agent.ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as {
      type: string;
      id: string;
      action: string;
      params: Record<string, unknown>;
    };
    if (m.type !== 'rpc') return;
    const target = typeof m.params.target === 'string' ? `:${m.params.target}` : '';
    log.push(`${m.action}${target}`);
    const ok = (data: unknown) => agent.send({ type: 'rpc.result', id: m.id, ok: true, data });
    switch (m.action) {
      case 'update.check': {
        const tg = m.params.target as 'agent' | 'core';
        const avail = script.available?.[tg] ?? null;
        ok({
          target: tg,
          ref: `ghcr.io/owner/homelab-${tg}:latest`,
          current: v('sha-1a2b3c4'),
          available: avail === null ? null : v(avail),
          pulled: true,
        });
        return;
      }
      case 'update.apply': {
        ok({ accepted: true });
        const o = script.outcome
          ? script.outcome(m.params.target as string)
          : { outcome: 'updated' };
        if (o) {
          setTimeout(() => {
            agent.send(
              event({
                kind: 'update_result',
                runId: m.params.runId,
                target: m.params.target,
                from: v('sha-1a2b3c4'),
                to: v('sha-5d6e7f8'),
                ...o,
              }),
            );
          }, 5);
        }
        return;
      }
      case 'system.upgrade':
        script.beforeUpgradeReply?.();
        ok(script.upgrade ?? { upgraded: 12, kept: 0, rebootRequired: true });
        return;
      default:
        ok(null);
    }
  });
}

const runsOf = (t: TestApp) => t.app.hzUpdates.response().runs;

describe('window math (HZ_TIMEZONE)', () => {
  const w = defaultUpdatePolicy.window;

  it('default window: daily 03:00 for 120 min in Europe/Vienna', () => {
    expect(openWindowAt(w, THU_0300 - 1)).toBeNull();
    expect(openWindowAt(w, THU_0300)).toEqual({
      key: '2026-11-26T03:00',
      start: THU_0300,
      end: THU_0300 + 120 * MIN,
    });
    expect(openWindowAt(w, THU_0300 + 119 * MIN)?.key).toBe('2026-11-26T03:00');
    expect(openWindowAt(w, THU_0300 + 120 * MIN)).toBeNull();
    expect(nextWindowAfter(w, THU_0300)?.start).toBe(THU_0300 + 24 * 60 * MIN);
  });

  it('over midnight: belongs to the start day', () => {
    const night = { days: [3], start: '23:00', durationMin: 180 }; // Wednesday
    const wed2330 = Date.UTC(2026, 10, 25, 22, 30);
    const thu0130 = Date.UTC(2026, 10, 26, 0, 30);
    expect(openWindowAt(night, wed2330)?.key).toBe('2026-11-25T23:00');
    expect(openWindowAt(night, thu0130)?.key).toBe('2026-11-25T23:00');
    expect(openWindowAt(night, Date.UTC(2026, 10, 26, 1, 0))).toBeNull(); // Thu 02:00
    expect(openWindowAt(night, Date.UTC(2026, 10, 26, 22, 30))).toBeNull(); // Thu 23:30
  });

  it('weekdays are ISO (1 = Monday) in the local zone', () => {
    const monday = { days: [1], start: '03:00', durationMin: 60 };
    expect(openWindowAt(monday, THU_0300 + MIN)).toBeNull();
    expect(nextWindowAfter(monday, THU_0300)?.start).toBe(Date.UTC(2026, 10, 30, 2, 0));
    const sunday = { days: [7], start: '00:30', durationMin: 60 };
    // Sunday 00:30 Vienna is Saturday 23:30 UTC.
    expect(openWindowAt(sunday, Date.UTC(2026, 10, 28, 23, 45))?.key).toBe('2026-11-29T00:30');
  });

  it('follows HZ_TIMEZONE', () => {
    setTimeZone('America/New_York');
    // 03:00 EST = 08:00 UTC.
    expect(openWindowAt(w, Date.UTC(2026, 10, 26, 8, 30))?.start).toBe(Date.UTC(2026, 10, 26, 8));
    expect(openWindowAt(w, THU_0300 + MIN)).toBeNull();
  });

  it('DST: the window starts at local 03:00 on both sides of the change', () => {
    // 2026-03-29: 02:00 CET -> 03:00 CEST. 2026-10-25: 03:00 CEST -> 02:00 CET.
    expect(nextWindowAfter(w, Date.UTC(2026, 2, 28, 12))?.start).toBe(Date.UTC(2026, 2, 29, 1));
    expect(nextWindowAfter(w, Date.UTC(2026, 2, 27, 12))?.start).toBe(Date.UTC(2026, 2, 28, 2));
    expect(nextWindowAfter(w, Date.UTC(2026, 9, 24, 12))?.start).toBe(Date.UTC(2026, 9, 25, 2));
    expect(nextWindowAfter(w, Date.UTC(2026, 9, 23, 12))?.start).toBe(Date.UTC(2026, 9, 24, 1));
    // A start inside the skipped hour still yields one window that day.
    const gap = { days: [7], start: '02:30', durationMin: 60 };
    const occ = nextWindowAfter(gap, Date.UTC(2026, 2, 28, 12));
    expect(occ?.key).toBe('2026-03-29T02:30');
    expect(occ?.start).toBeGreaterThanOrEqual(Date.UTC(2026, 2, 29, 0));
    expect(occ?.start).toBeLessThanOrEqual(Date.UTC(2026, 2, 29, 2));
  });
});

describe('policy', () => {
  it('defaults, PUT and audit', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    agent.send(inventoryMsg());
    await until(() => s.t.app.hzCore.servers.detail(serverId)?.updates !== null);
    const r0 = await updates(s.t, s.cookie);
    expect(r0.coreHostKnown).toBe(false);
    expect(r0.runs).toEqual([]);
    expect(r0.servers).toHaveLength(1);
    expect(r0.servers[0]).toMatchObject({
      serverId,
      name: 'heimserver',
      connected: true,
      hostsCore: false,
      policy: defaultUpdatePolicy,
      agent: { current: null, available: null, upToDate: null, checkedAt: null },
      core: null,
      os: { total: 4, security: 0 },
      running: null,
      nextWindow: new Date(THU_0300).toISOString(),
    });

    const policy: UpdatePolicy = {
      ...defaultUpdatePolicy,
      os: true,
      window: { days: [6, 7], start: '04:30', durationMin: 60 },
    };
    const res = await req(s.t, s.cookie, 'PUT', `/api/servers/${serverId}/update-policy`, policy);
    expect(res.statusCode).toBe(200);
    expect(updateServerStateSchema.parse(res.json()).policy).toEqual(policy);
    // Saturday 2026-11-28 04:30 Vienna.
    expect(res.json().nextWindow).toBe(new Date(Date.UTC(2026, 10, 28, 3, 30)).toISOString());
    const audit = s.t.db.sqlite
      .prepare("SELECT target FROM audit_log WHERE action = 'server.update_policy'")
      .all();
    expect(audit).toEqual([{ target: serverId }]);
  });

  it('turning on the automatic reboot needs step-up; turning it off does not', async () => {
    const s = await setup();
    const { serverId } = await addAgent(s);
    const url = `/api/servers/${serverId}/update-policy`;
    const on = { ...defaultUpdatePolicy, reboot: true };
    const denied = await req(s.t, s.cookie, 'PUT', url, on);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ ok: false, error: 'step_up_required' });
    expect(s.t.app.hzUpdates.policy(serverId).reboot).toBe(false);

    await stepUp(s.t, s.secret, s.cookie);
    expect((await req(s.t, s.cookie, 'PUT', url, on)).statusCode).toBe(200);
    expect(s.t.app.hzUpdates.policy(serverId).reboot).toBe(true);

    s.t.clock.advance(16 * MIN); // step-up expired
    // Already on: other changes need no step-up.
    expect((await req(s.t, s.cookie, 'PUT', url, { ...on, os: true })).statusCode).toBe(200);
    expect((await req(s.t, s.cookie, 'PUT', url, defaultUpdatePolicy)).statusCode).toBe(200);
    expect(s.t.app.hzUpdates.policy(serverId).reboot).toBe(false);
    expect((await req(s.t, s.cookie, 'PUT', url, on)).statusCode).toBe(403);
  });

  it('rejects invalid policies', async () => {
    const s = await setup();
    const { serverId } = await addAgent(s);
    const url = `/api/servers/${serverId}/update-policy`;
    for (const payload of [
      { ...defaultUpdatePolicy, window: { days: [0], start: '03:00', durationMin: 120 } },
      { ...defaultUpdatePolicy, window: { days: [1, 1], start: '03:00', durationMin: 120 } },
      { ...defaultUpdatePolicy, window: { days: [1], start: '24:00', durationMin: 120 } },
      { ...defaultUpdatePolicy, window: { days: [1], start: '03:00', durationMin: 10 } },
      { ...defaultUpdatePolicy, image: 'evil/image:latest' },
    ]) {
      expect((await req(s.t, s.cookie, 'PUT', url, payload)).statusCode).toBe(400);
    }
    expect(
      (
        await req(
          s.t,
          s.cookie,
          'PUT',
          '/api/servers/AAAAAAAAAAAAAAAAAAAAAA/update-policy',
          defaultUpdatePolicy,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('check and manual runs', () => {
  it('update-check stores the component state', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    const log: string[] = [];
    autoRespond(agent, log, { available: { agent: 'sha-5d6e7f8' } });
    const res = await req(s.t, s.cookie, 'POST', `/api/servers/${serverId}/update-check`, {
      target: 'agent',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      current: v('sha-1a2b3c4'),
      available: v('sha-5d6e7f8'),
      upToDate: false,
      checkedAt: new Date(s.t.clock.t).toISOString(),
    });
    expect(log).toEqual(['update.check:agent']);
    expect((await updates(s.t, s.cookie)).servers[0]?.agent.upToDate).toBe(false);
  });

  it('agent update: run, event, alert, versions', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    const log: string[] = [];
    autoRespond(agent, log);
    const res = await req(s.t, s.cookie, 'POST', `/api/servers/${serverId}/update`, {
      target: 'agent',
    });
    expect(res.statusCode).toBe(200);
    const { runId } = res.json<{ runId: string }>();
    await until(() => s.t.app.hzUpdates.run(runId)?.status !== 'running');
    expect(s.t.app.hzUpdates.run(runId)).toMatchObject({
      serverId,
      serverName: 'heimserver',
      target: 'agent',
      trigger: 'manual',
      status: 'updated',
      from: 'sha-1a2b3c4',
      to: 'sha-5d6e7f8',
    });
    const info = s.t.app.hzCore.alerts
      .list({ state: 'all', limit: 50 })
      .find((a) => a.key === `update:${serverId}:agent`);
    expect(info).toMatchObject({
      level: 'info',
      title: 'Agent auf heimserver aktualisiert: sha-1a2b3c4 → sha-5d6e7f8',
    });
    // Fresh versions after the run.
    await until(() => log.includes('update.check:agent'));
    await s.t.app.hzUpdates.idle();
    expect(log[0]).toBe('update.apply:agent');
    const audit = s.t.db.sqlite
      .prepare("SELECT target FROM audit_log WHERE action = 'server.update'")
      .all();
    expect(audit).toEqual([{ target: serverId }]);
  });

  it('one run at a time: 409 busy; offline: 409 agent_offline', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    autoRespond(agent, [], { outcome: () => null });
    const url = `/api/servers/${serverId}/update`;
    expect((await req(s.t, s.cookie, 'POST', url, { target: 'agent' })).statusCode).toBe(200);
    const busy = await req(s.t, s.cookie, 'POST', url, { target: 'os' });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ ok: false, error: 'busy' });
    expect((await updates(s.t, s.cookie)).servers[0]?.running).toBe('agent');

    s.t.clock.advance(RUN_TIMEOUT_MS);
    s.t.app.hzUpdates.tick();
    agent.close();
    await until(() => !s.t.app.hzCore.hub.isConnected(serverId));
    const off = await req(s.t, s.cookie, 'POST', url, { target: 'agent' });
    expect(off.statusCode).toBe(409);
    expect(off.json()).toEqual({ ok: false, error: 'agent_offline' });
    const check = await req(s.t, s.cookie, 'POST', `/api/servers/${serverId}/update-check`, {
      target: 'agent',
    });
    expect(check.statusCode).toBe(409);
  });

  it('core only on the core host', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    const log: string[] = [];
    autoRespond(agent, log);
    for (const [path, body] of [
      ['update', { target: 'core' }],
      ['update-check', { target: 'core' }],
    ] as const) {
      const res = await req(s.t, s.cookie, 'POST', `/api/servers/${serverId}/${path}`, body);
      expect(res.statusCode, path).toBe(400);
    }
    expect(log).toEqual([]);
    let r = await updates(s.t, s.cookie);
    expect(r.coreHostKnown).toBe(false);
    expect(r.servers[0]?.core).toBeNull();

    await makeCoreHost(s.t, agent, serverId);
    r = await updates(s.t, s.cookie);
    expect(r.coreHostKnown).toBe(true);
    expect(r.servers[0]).toMatchObject({ hostsCore: true, core: { current: null } });
    const res = await req(s.t, s.cookie, 'POST', `/api/servers/${serverId}/update`, {
      target: 'core',
    });
    expect(res.statusCode).toBe(200);
    const { runId } = res.json<{ runId: string }>();
    await until(() => s.t.app.hzUpdates.run(runId)?.status === 'updated');
    const alert = s.t.app.hzCore.alerts
      .list({ state: 'all', limit: 50 })
      .find((a) => a.key === `update:${serverId}:core`);
    expect(alert?.title).toBe('Zentrale aktualisiert: sha-1a2b3c4 → sha-5d6e7f8');
    await s.t.app.hzUpdates.idle();
  });

  it('os: system.upgrade, N Pakete; nothing to do is up_to_date without an alert', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    const log: string[] = [];
    const script: Script = { upgrade: { upgraded: 12, kept: 1, rebootRequired: false } };
    autoRespond(agent, log, script);
    const url = `/api/servers/${serverId}/update`;
    const { runId } = (await req(s.t, s.cookie, 'POST', url, { target: 'os' })).json<{
      runId: string;
    }>();
    await until(() => s.t.app.hzUpdates.run(runId)?.status !== 'running');
    expect(s.t.app.hzUpdates.run(runId)).toMatchObject({
      target: 'os',
      status: 'updated',
      to: '12 Pakete',
      message: '12 Pakete aktualisiert, 1 zurückgehalten',
    });
    expect(log).toEqual(['system.upgrade']);
    const alerts = () =>
      s.t.app.hzCore.alerts
        .list({ state: 'all', limit: 50 })
        .filter((a) => a.key === `update:${serverId}:os`);
    expect(alerts().map((a) => a.title)).toEqual(['OS-Pakete auf heimserver: 12 aktualisiert']);

    script.upgrade = { upgraded: 0, kept: 0, rebootRequired: false };
    const second = (await req(s.t, s.cookie, 'POST', url, { target: 'os' })).json<{
      runId: string;
    }>();
    await until(() => s.t.app.hzUpdates.run(second.runId)?.status !== 'running');
    expect(s.t.app.hzUpdates.run(second.runId)?.status).toBe('up_to_date');
    expect(alerts()).toHaveLength(1);
  });

  it('alerts per outcome: warn on rollback, failure and timeout, crit when the rollback failed, ok after recovery', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    let next: { outcome: string; message?: string } | null = {
      outcome: 'rolled_back',
      message: 'health check failed after 180 s',
    };
    autoRespond(agent, [], { outcome: () => next });
    const key = `update:${serverId}:agent`;
    const run = async (): Promise<string> => {
      const res = await req(s.t, s.cookie, 'POST', `/api/servers/${serverId}/update`, {
        target: 'agent',
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ runId: string }>().runId;
    };

    const r1 = await run();
    await until(() => s.t.app.hzUpdates.run(r1)?.status === 'rolled_back');
    expect(s.t.app.hzCore.alerts.active(key)).toMatchObject({
      level: 'warn',
      title: 'Update des Agents auf heimserver zurückgerollt: health check failed after 180 s',
    });
    await s.t.app.hzUpdates.idle();

    // A failed pull: the old version still runs, warn. The open warn of this target
    // stays the one alert (same level: no new entry, no new push).
    next = { outcome: 'failed', message: 'pull denied' };
    const r2 = await run();
    await until(() => s.t.app.hzUpdates.run(r2)?.status === 'failed');
    expect(s.t.app.hzCore.alerts.active(key)?.level).toBe('warn');
    expect(
      s.t.app.hzCore.alerts.list({ state: 'all', limit: 50 }).filter((a) => a.key === key),
    ).toHaveLength(1);
    await s.t.app.hzUpdates.idle();

    // The rollback itself failed: nothing runs, crit.
    next = { outcome: 'failed', message: 'rollback failed: old container is gone' };
    const r2b = await run();
    await until(() => s.t.app.hzUpdates.run(r2b)?.status === 'failed');
    expect(s.t.app.hzCore.alerts.active(key)).toMatchObject({
      level: 'crit',
      title: 'Update des Agents auf heimserver fehlgeschlagen, Rollback misslungen',
    });
    await s.t.app.hzUpdates.idle();

    next = { outcome: 'updated' };
    const r3 = await run();
    await until(() => s.t.app.hzUpdates.run(r3)?.status === 'updated');
    expect(s.t.app.hzCore.alerts.active(key)).toBeNull();
    const ok = s.t.app.hzCore.alerts
      .list({ state: 'all', limit: 50 })
      .find((a) => a.key === key && a.level === 'ok');
    expect(ok?.title).toBe('Agent auf heimserver aktualisiert: sha-1a2b3c4 → sha-5d6e7f8');
    await s.t.app.hzUpdates.idle();

    next = null;
    const r4 = await run();
    s.t.clock.advance(RUN_TIMEOUT_MS - 1000);
    s.t.app.hzUpdates.tick();
    expect(s.t.app.hzUpdates.run(r4)?.status).toBe('running');
    s.t.clock.advance(1000);
    s.t.app.hzUpdates.tick();
    expect(s.t.app.hzUpdates.run(r4)).toMatchObject({ status: 'timeout' });
    expect(s.t.app.hzCore.alerts.active(key)).toMatchObject({
      level: 'warn',
      title: 'Update des Agents auf heimserver ohne Ergebnis',
    });
  });

  it('after a core restart: the event finishes the run from the database, else timeout', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    autoRespond(agent, [], { outcome: () => null });
    await makeCoreHost(s.t, agent, serverId);
    const url = `/api/servers/${serverId}/update`;
    const { runId } = (await req(s.t, s.cookie, 'POST', url, { target: 'core' })).json<{
      runId: string;
    }>();
    await until(() => agent.received.length > 0 && s.t.app.hzUpdates.run(runId) !== null);
    // A new core process: nothing in memory, only the database knows the run.
    const restarted = new UpdateService({
      db: s.t.db.db,
      now: () => s.t.clock.t,
      hub: s.t.app.hzCore.hub,
      alerts: s.t.app.hzCore.alerts,
      isConnected: () => true,
      log: s.t.app.log,
    });
    restarted.onUpdateResult(serverId, {
      kind: 'update_result',
      runId,
      target: 'core',
      outcome: 'updated',
      to: v('sha-5d6e7f8'),
    });
    expect(restarted.run(runId)).toMatchObject({ status: 'updated', to: 'sha-5d6e7f8' });
    expect(restarted.serverState(serverId)?.core?.current).toEqual(v('sha-5d6e7f8'));
    await s.t.app.hzUpdates.idle();

    // Another run without any result: the restarted core sweeps it after 15 min.
    const second = (await req(s.t, s.cookie, 'POST', url, { target: 'agent' })).json<{
      runId: string;
    }>();
    s.t.clock.advance(RUN_TIMEOUT_MS);
    restarted.sweep();
    expect(restarted.run(second.runId)?.status).toBe('timeout');
    expect(s.t.app.hzCore.alerts.active(`update:${serverId}:agent`)?.level).toBe('warn');
  });
});

describe('os and apply failures are warnings', () => {
  it('update.apply refused by the agent: failed with a warn alert', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    const p = req(s.t, s.cookie, 'POST', `/api/servers/${serverId}/update`, { target: 'agent' });
    const rpc = await agent.nextOfType('rpc');
    agent.send({
      type: 'rpc.result',
      id: rpc.id,
      ok: false,
      error: { code: 'failed', message: 'helper container did not start' },
    });
    const { runId } = (await p).json<{ runId: string }>();
    await until(() => s.t.app.hzUpdates.run(runId)?.status === 'failed');
    expect(s.t.app.hzCore.alerts.active(`update:${serverId}:agent`)?.level).toBe('warn');
  });

  it('a host without apt: one warn alert, not a new one every night', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    await req(s.t, s.cookie, 'PUT', `/api/servers/${serverId}/update-policy`, {
      ...defaultUpdatePolicy,
      os: true,
      agent: false,
      core: false,
    });
    const log: string[] = [];
    agent.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { type: string; id: string; action: string };
      if (m.type !== 'rpc') return;
      log.push(m.action);
      agent.send({
        type: 'rpc.result',
        id: m.id,
        ok: false,
        error: { code: 'not_allowed', message: 'apt-get not available on this host' },
      });
    });
    const osAlerts = () =>
      s.t.app.hzCore.alerts
        .list({ state: 'all', limit: 50 })
        .filter((a) => a.key === `update:${serverId}:os`);
    for (const day of [0, 1, 2]) {
      s.t.clock.t = THU_0300 + day * 24 * 60 * MIN + MIN;
      s.t.app.hzUpdates.tick();
      await until(() => log.filter((a) => a === 'system.upgrade').length === day + 1);
      await s.t.app.hzUpdates.idle();
    }
    // No image checks: agent and core are off in the policy.
    expect(log).toEqual(['system.upgrade', 'system.upgrade', 'system.upgrade']);
    expect(runsOf(s.t).map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
    expect(osAlerts()).toHaveLength(1);
    expect(osAlerts()[0]).toMatchObject({ level: 'warn', state: 'open' });
  });

  it('a dropped connection during the upgrade: timeout with a warn alert', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    const p = req(s.t, s.cookie, 'POST', `/api/servers/${serverId}/update`, { target: 'os' });
    const rpc = await agent.nextOfType('rpc');
    expect(rpc.action).toBe('system.upgrade');
    const { runId } = (await p).json<{ runId: string }>();
    agent.ws.terminate(); // apt restarts tailscaled
    await until(() => s.t.app.hzUpdates.run(runId)?.status !== 'running');
    expect(s.t.app.hzUpdates.run(runId)).toMatchObject({
      status: 'timeout',
      message: 'Verbindung während der Paket-Updates getrennt',
    });
    expect(s.t.app.hzCore.alerts.active(`update:${serverId}:os`)).toMatchObject({
      level: 'warn',
      title: 'Update der OS-Pakete auf heimserver ohne Ergebnis',
    });
  });
});

describe('scheduled sequence', () => {
  it('runs os -> agent -> core -> reboot once per window, nothing outside it', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    await makeCoreHost(s.t, agent, serverId);
    await stepUp(s.t, s.secret, s.cookie);
    const put = await req(s.t, s.cookie, 'PUT', `/api/servers/${serverId}/update-policy`, {
      ...defaultUpdatePolicy,
      os: true,
      reboot: true,
    });
    expect(put.statusCode).toBe(200);
    const log: string[] = [];
    autoRespond(agent, log, { available: { agent: 'sha-5d6e7f8', core: 'sha-5d6e7f8' } });
    expect(s.t.app.hzCore.scheduler.has('updates.tick')).toBe(true);

    // Wednesday 13:00 (T0 + step-up): outside the window, nothing happens.
    s.t.app.hzUpdates.tick();
    await s.t.app.hzUpdates.idle();
    expect(log).toEqual([]);

    s.t.clock.t = THU_0300 + MIN;
    s.t.app.hzUpdates.tick();
    await until(() => log.includes('system.reboot'), 5000);
    await s.t.app.hzUpdates.idle();
    const steps = log.filter((a) => a !== 'update.check:agent' && a !== 'update.check:core');
    expect(steps).toEqual([
      'system.upgrade',
      'update.apply:agent',
      'update.apply:core',
      'system.reboot',
    ]);
    // Fresh check before the steps.
    expect(log.slice(0, 2)).toEqual(['update.check:agent', 'update.check:core']);
    const runs = runsOf(s.t);
    expect(runs.map((r) => [r.target, r.trigger, r.status])).toEqual([
      ['reboot', 'schedule', 'updated'],
      ['core', 'schedule', 'updated'],
      ['agent', 'schedule', 'updated'],
      ['os', 'schedule', 'updated'],
    ]);

    // Same window again: nothing.
    const before = log.length;
    s.t.clock.advance(10 * MIN);
    s.t.app.hzUpdates.tick();
    await s.t.app.hzUpdates.idle();
    expect(log.length).toBe(before);
    // After the window: nothing.
    s.t.clock.t = THU_0300 + 3 * 60 * MIN;
    s.t.app.hzUpdates.tick();
    await s.t.app.hzUpdates.idle();
    expect(log.length).toBe(before);
    expect((await updates(s.t, s.cookie)).servers[0]?.nextWindow).toBe(
      new Date(THU_0300 + 24 * 60 * MIN).toISOString(),
    );
  });

  it('a core that updated itself continues the sequence after the restart (reboot last)', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    await makeCoreHost(s.t, agent, serverId);
    await stepUp(s.t, s.secret, s.cookie);
    await req(s.t, s.cookie, 'PUT', `/api/servers/${serverId}/update-policy`, {
      ...defaultUpdatePolicy,
      os: true,
      reboot: true,
    });
    const log: string[] = [];
    autoRespond(agent, log, {
      available: { agent: 'sha-5d6e7f8', core: 'sha-5d6e7f8' },
      // The core is replaced: its result only reaches the new process.
      outcome: (target) => (target === 'core' ? null : { outcome: 'updated' }),
    });
    s.t.clock.t = THU_0300 + MIN;
    s.t.app.hzUpdates.tick();
    await until(() => log.includes('update.apply:core'), 5000);
    // The old process dies; a new one starts on the same database.
    s.t.app.hzUpdates.close();
    await s.t.app.hzUpdates.idle();
    const restarted = new UpdateService({
      db: s.t.db.db,
      now: () => s.t.clock.t,
      hub: s.t.app.hzCore.hub,
      alerts: s.t.app.hzCore.alerts,
      isConnected: () => true,
      log: s.t.app.log,
    });
    s.t.app.hzCore.servers.onUpdateResult((id, e) => restarted.onUpdateResult(id, e));
    const coreRun = restarted.response().runs.find((r) => r.target === 'core');
    expect(coreRun?.status).toBe('running');

    // While the core run has no result, the sequence waits (no reboot yet).
    s.t.clock.advance(MIN);
    restarted.tick();
    await restarted.idle();
    expect(log).not.toContain('system.reboot');

    agent.send(
      event({
        kind: 'update_result',
        runId: coreRun?.id,
        target: 'core',
        outcome: 'updated',
        to: v('sha-5d6e7f8'),
      }),
    );
    await until(() => restarted.run(coreRun?.id ?? '')?.status === 'updated');
    s.t.clock.advance(MIN);
    restarted.tick();
    await until(() => log.includes('system.reboot'));
    await restarted.idle();
    const steps = log.filter((a) => !a.startsWith('update.check'));
    expect(steps).toEqual([
      'system.upgrade',
      'update.apply:agent',
      'update.apply:core',
      'system.reboot',
    ]);
    // Each step at most once per window.
    const n = log.length;
    s.t.clock.advance(MIN);
    restarted.tick();
    await restarted.idle();
    expect(log.length).toBe(n);
    expect(restarted.response().runs.map((r) => r.target)).toEqual([
      'reboot',
      'core',
      'agent',
      'os',
    ]);
  });

  it('skips agent and core when no update is available and reboot when not needed', async () => {
    const s = await setup();
    const { agent } = await addAgent(s);
    const log: string[] = [];
    autoRespond(agent, log, { available: { agent: null } });
    s.t.clock.t = THU_0300 + MIN;
    s.t.app.hzUpdates.tick();
    await until(() => log.length > 0);
    await s.t.app.hzUpdates.idle();
    expect(log).toEqual(['update.check:agent']);
    expect(runsOf(s.t)).toEqual([]);
  });

  it('never starts a step after the window ended', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    await req(s.t, s.cookie, 'PUT', `/api/servers/${serverId}/update-policy`, {
      ...defaultUpdatePolicy,
      os: true,
    });
    const log: string[] = [];
    autoRespond(agent, log, {
      available: { agent: 'sha-5d6e7f8' },
      upgrade: { upgraded: 3, kept: 0, rebootRequired: false },
      // apt runs until after the window.
      beforeUpgradeReply: () => {
        s.t.clock.t = THU_0300 + 121 * MIN;
      },
    });
    s.t.clock.t = THU_0300 + MIN;
    s.t.app.hzUpdates.tick();
    await until(() => log.includes('system.upgrade'));
    await s.t.app.hzUpdates.idle();
    expect(log).toEqual(['update.check:agent', 'system.upgrade']);
  });

  it('servers one after another, the core host last', async () => {
    const s = await setup();
    const heim = await addAgent(s, 'heimserver');
    const pi = await addAgent(s, 'pi');
    const zz = await addAgent(s, 'zz-vps');
    await makeCoreHost(s.t, heim.agent, heim.serverId);
    const order: string[] = [];
    for (const [name, e] of [
      ['heimserver', heim],
      ['pi', pi],
      ['zz-vps', zz],
    ] as const) {
      const log: string[] = [];
      autoRespond(e.agent, log, { available: { agent: 'sha-5d6e7f8', core: null } });
      e.agent.ws.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as { type: string; action?: string };
        if (m.type === 'rpc' && m.action === 'update.apply') order.push(name);
      });
    }
    s.t.clock.t = THU_0300 + MIN;
    s.t.app.hzUpdates.tick();
    await until(() => order.length === 3, 5000);
    await s.t.app.hzUpdates.idle();
    expect(order).toEqual(['pi', 'zz-vps', 'heimserver']);
  });

  it('automatic checks pull only what the policy may update', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    await makeCoreHost(s.t, agent, serverId);
    await req(s.t, s.cookie, 'PUT', `/api/servers/${serverId}/update-policy`, {
      ...defaultUpdatePolicy,
      core: false,
    });
    const log: string[] = [];
    autoRespond(agent, log, { available: { agent: null, core: 'sha-5d6e7f8' } });
    s.t.clock.t = THU_0300 + MIN;
    s.t.app.hzUpdates.tick();
    await until(() => log.length > 0);
    await s.t.app.hzUpdates.idle();
    expect(log).toEqual(['update.check:agent']);
  });

  it('re-reads the policy before every step', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    await req(s.t, s.cookie, 'PUT', `/api/servers/${serverId}/update-policy`, {
      ...defaultUpdatePolicy,
      os: true,
    });
    const log: string[] = [];
    autoRespond(agent, log, {
      available: { agent: 'sha-5d6e7f8' },
      upgrade: { upgraded: 1, kept: 0, rebootRequired: false },
      // While apt runs, the admin switches the agent update off.
      beforeUpgradeReply: () =>
        s.t.app.hzUpdates.setPolicy(serverId, { ...defaultUpdatePolicy, os: true, agent: false }),
    });
    s.t.clock.t = THU_0300 + MIN;
    s.t.app.hzUpdates.tick();
    await until(() => log.includes('system.upgrade'));
    await s.t.app.hzUpdates.idle();
    expect(log).toEqual(['update.check:agent', 'system.upgrade']);
  });

  it('the daily check also runs on days without a window', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    await req(s.t, s.cookie, 'PUT', `/api/servers/${serverId}/update-policy`, {
      ...defaultUpdatePolicy,
      window: { days: [1], start: '03:00', durationMin: 120 },
    });
    const log: string[] = [];
    autoRespond(agent, log, { available: { agent: 'sha-5d6e7f8' } });
    s.t.clock.t = THU_0300 + MIN; // Thursday, the window is on Mondays
    s.t.app.hzUpdates.tick();
    await until(() => log.length > 0);
    s.t.app.hzUpdates.tick();
    await s.t.app.hzUpdates.idle();
    expect(log).toEqual(['update.check:agent']);
    expect(runsOf(s.t)).toEqual([]);
    expect(s.t.app.hzUpdates.serverState(serverId)?.agent.available).toEqual(v('sha-5d6e7f8'));
  });
});

describe('live topic updates', () => {
  it('snapshot, then the full response as the only upsert', async () => {
    const s = await setup();
    const { serverId, agent } = await addAgent(s);
    autoRespond(agent, [], { outcome: () => null });
    const live = await WsClient.connect(`${s.url}/live`, {
      cookie: `hz_session=${s.cookie}`,
      origin: s.url.replace('ws://', 'http://'),
    });
    clients.push(live);
    live.send({ type: 'subscribe', topics: ['updates'] });
    const snap = await live.nextOfType('snapshot');
    expect(updatesResponseSchema.parse(snap.data).servers[0]?.serverId).toBe(serverId);
    await req(s.t, s.cookie, 'POST', `/api/servers/${serverId}/update`, { target: 'agent' });
    const upd = await live.next(
      (m) =>
        m.type === 'update' &&
        Array.isArray(m.upsert) &&
        updatesResponseSchema.parse(m.upsert[0]).runs.length === 1,
    );
    expect(upd.upsert).toHaveLength(1);
  });
});

describe('HZ_DEMO=1', () => {
  it('demo servers have versions, a core host and a few runs', async () => {
    t = await makeApp({ env: { HZ_DEMO: '1' } });
    const { cookie } = await completeSetup(t);
    const r = await updates(t, cookie);
    expect(r.coreHostKnown).toBe(true);
    expect(r.servers.map((x) => x.name)).toEqual(['heimserver', 'oracle-a1', 'raspi']);
    expect(r.servers.find((x) => x.name === 'heimserver')?.core?.current?.version).toBe(
      'sha-5d6e7f8',
    );
    expect(r.servers.find((x) => x.name === 'oracle-a1')?.agent.upToDate).toBe(false);
    expect(r.runs.length).toBeGreaterThanOrEqual(4);
    expect(r.runs.some((x) => x.status === 'rolled_back')).toBe(true);
    // Demo servers have no agent: updating them is refused.
    const id = r.servers[0]?.serverId ?? '';
    const res = await req(t, cookie, 'POST', `/api/servers/${id}/update`, { target: 'agent' });
    expect(res.statusCode).toBe(409);
  });
});

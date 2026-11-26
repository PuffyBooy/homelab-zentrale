import { afterEach, describe, expect, it, vi } from 'vitest';
import { vulnScanStateSchema, type ImageScanData } from '@hz/shared';
import { inventoryMsg, until, type Received, type WsClient } from './agent-helpers.js';
import { info } from './container-helpers.js';
import { authHeaders, SAME_ORIGIN, type TestApp } from './helpers.js';
import { fail, ok, opsSetup, scanData, vulnData, type OpsSetup } from './ops-helpers.js';
import { VULNSCAN_JOB, vulnAlertKey, vulnAlertText } from '../src/ops/vulnscan.js';
import { StorageService } from '../src/storage/service.js';

const clients: WsClient[] = [];
let t: TestApp | undefined;
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.app.close();
  t = undefined;
});

const isScan = (m: Received): boolean => m.action === 'image.scan';

/** Agent reply: image.scan answers with the data of the container's docker id. */
function scans(byDockerId: Map<string, ImageScanData>) {
  return (rpc: Received) => {
    if (!isScan(rpc)) return null;
    const id = (rpc.params as { id: string }).id;
    return ok(rpc, byDockerId.get(id) ?? scanData());
  };
}

async function getState(s: OpsSetup) {
  const res = await s.t.app.inject({
    method: 'GET',
    url: '/api/vulnscan',
    headers: authHeaders(s.cookie),
  });
  expect(res.statusCode).toBe(200);
  return vulnScanStateSchema.parse(res.json());
}

async function runNow(s: OpsSetup): Promise<void> {
  await s.t.app.hzCore.ops.vulnscan.start();
}

describe('vulnscan', () => {
  it('runs nightly at the set local time, scans only running containers, raises alerts', async () => {
    const data = new Map<string, ImageScanData>();
    const s = await opsSetup(clients, {
      servers: [
        {
          name: 'heimserver',
          containers: [info('nginx'), info('db'), info('old', { state: 'exited' })],
          reply: scans(data),
        },
      ],
    });
    t = s.t;
    data.set(info('nginx').dockerId, vulnData(2, 1));
    const sched = t.app.hzCore.scheduler;
    const next = sched.nextRunOf(VULNSCAN_JOB);
    // T0 = 2026-11-25 13:00 in Vienna; default 03:30 local = 02:30 UTC the next day.
    expect(next).toBe(Date.UTC(2026, 10, 26, 2, 30));
    expect((await getState(s)).nextRunAt).toBe('2026-11-26T02:30:00.000Z');
    // A run a few minutes from now (a 13 h jump would let the agent go stale).
    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/vulnscan/settings',
      headers: authHeaders(s.cookie),
      payload: { time: '13:05', alertFrom: 'critical' },
    });
    expect(put.statusCode).toBe(200);
    const at = sched.nextRunOf(VULNSCAN_JOB) ?? 0;
    expect(at).toBe(Date.UTC(2026, 10, 25, 12, 5));
    t.clock.t = at - 1000;
    await sched.tick();
    expect(s.agents[0]?.rpcs.some(isScan)).toBe(false);
    t.clock.t = at;
    await sched.tick();
    await t.app.hzCore.ops.vulnscan.idle();
    const ids = s.agents[0]?.rpcs.filter(isScan).map((r) => (r.params as { id: string }).id);
    expect(ids?.sort()).toEqual([info('db').dockerId, info('nginx').dockerId].sort());
    const st = await getState(s);
    expect(st.running).toBe(false);
    expect(st.lastRunAt).toBe('2026-11-25T12:05:00.000Z');
    expect(st.nextRunAt).toBe('2026-11-26T12:05:00.000Z');
    expect(st.results.map((r) => [r.containerName, r.scan.counts.critical])).toEqual([
      ['nginx', 2],
      ['db', 0],
    ]);
    const alert = t.app.hzCore.alerts.active(vulnAlertKey(s.agents[0]?.serverId ?? '', 'nginx'));
    expect(alert).toMatchObject({
      level: 'warn',
      title: '2 kritische Lücken in nginx',
      body: 'auf heimserver: CVE-2026-1000 (behoben in 3.0.9), CVE-2026-1001 (behoben in 3.0.9)',
    });
    expect(t.app.hzCore.alerts.active(vulnAlertKey(s.agents[0]?.serverId ?? '', 'db'))).toBeNull();
  });

  it('default schedule: 03:30 Vienna fires at that minute, not before', async () => {
    const s = await opsSetup(clients, {
      servers: [
        {
          name: 'heimserver',
          containers: [info('nginx')],
          reply: (rpc) => (isScan(rpc) ? ok(rpc, scanData()) : null),
        },
      ],
    });
    t = s.t;
    const sched = t.app.hzCore.scheduler;
    const at = Date.UTC(2026, 10, 26, 2, 30);
    t.clock.t = at - 60_000;
    await sched.tick();
    expect(s.agents[0]?.rpcs.some(isScan)).toBe(false);
    t.clock.t = at;
    await sched.tick();
    await t.app.hzCore.ops.vulnscan.idle();
    expect(s.agents[0]?.rpcs.filter(isScan)).toHaveLength(1);
    expect(sched.nextRunOf(VULNSCAN_JOB)).toBe(Date.UTC(2026, 10, 27, 2, 30));
  });

  it('PUT settings reschedules; alertFrom high alerts high findings; invalid -> 400', async () => {
    const data = new Map<string, ImageScanData>();
    const s = await opsSetup(clients, {
      servers: [{ name: 'heimserver', containers: [info('nginx')], reply: scans(data) }],
    });
    t = s.t;
    data.set(info('nginx').dockerId, vulnData(0, 3));
    const headers = authHeaders(s.cookie);
    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/vulnscan/settings',
      headers,
      payload: { time: '22:05', alertFrom: 'critical' },
    });
    expect(put.statusCode).toBe(200);
    // 22:05 Vienna (UTC+1) on the same day.
    expect(vulnScanStateSchema.parse(put.json()).nextRunAt).toBe('2026-11-25T21:05:00.000Z');
    await runNow(s);
    const key = vulnAlertKey(s.agents[0]?.serverId ?? '', 'nginx');
    expect(t.app.hzCore.alerts.active(key)).toBeNull();
    // Lower threshold: raised at once from the stored result.
    await t.app.inject({
      method: 'PUT',
      url: '/api/vulnscan/settings',
      headers,
      payload: { time: '22:05', alertFrom: 'high' },
    });
    expect(t.app.hzCore.alerts.active(key)?.title).toBe('3 hohe Lücken in nginx');
    for (const payload of [
      { time: '24:00', alertFrom: 'high' },
      { time: '3:30', alertFrom: 'high' },
      { time: '03:30', alertFrom: 'low' },
      { time: '03:30' },
      { time: '03:30', alertFrom: 'high', image: 'evil:latest' },
    ]) {
      const res = await t.app.inject({
        method: 'PUT',
        url: '/api/vulnscan/settings',
        headers,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const audit = t.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'vulnscan.settings'")
      .get() as { n: number };
    expect(audit.n).toBe(2);
  });

  it('resolves the alert when the findings are fixed or the container is gone', async () => {
    const data = new Map<string, ImageScanData>();
    const s = await opsSetup(clients, {
      servers: [
        { name: 'heimserver', containers: [info('nginx'), info('app')], reply: scans(data) },
      ],
    });
    t = s.t;
    const sid = s.agents[0]?.serverId ?? '';
    data.set(info('nginx').dockerId, vulnData(1, 0));
    data.set(info('app').dockerId, vulnData(3, 0));
    await runNow(s);
    expect(t.app.hzCore.alerts.active(vulnAlertKey(sid, 'nginx'))?.title).toBe(
      '1 kritische Lücke in nginx',
    );
    expect(t.app.hzCore.alerts.active(vulnAlertKey(sid, 'app'))).not.toBeNull();
    // Fixed at the next run.
    data.set(info('nginx').dockerId, vulnData(0, 0));
    await runNow(s);
    expect(t.app.hzCore.alerts.active(vulnAlertKey(sid, 'nginx'))).toBeNull();
    // Container removed from the inventory: result and alert go.
    s.agents[0]?.agent.send(inventoryMsg({ containers: [info('nginx')] }));
    await until(() => t?.app.hzCore.containers.list().length === 1);
    expect(t.app.hzCore.alerts.active(vulnAlertKey(sid, 'app'))).toBeNull();
    expect((await getState(s)).results.map((r) => r.containerName)).toEqual(['nginx']);
  });

  it('reuses a scan for containers of the same image; old agents land in skippedServers', async () => {
    const s = await opsSetup(clients, {
      servers: [
        {
          name: 'heimserver',
          containers: [
            info('web1', { imageId: 'sha256:1111' }),
            info('web2', { imageId: 'sha256:1111' }),
            info('db', { imageId: 'sha256:2222' }),
          ],
          reply: (rpc) => (isScan(rpc) ? ok(rpc, vulnData(1, 0)) : null),
        },
        {
          name: 'alt',
          containers: [info('x'), info('y')],
          reply: (rpc) => (isScan(rpc) ? fail(rpc, 'not_allowed') : null),
        },
        { name: 'weg', containers: [info('z')] },
      ],
    });
    t = s.t;
    const weg = s.agents[2];
    if (!weg) throw new Error('no agent');
    weg.agent.close();
    await until(() => !s.t.app.hzCore.hub.isConnected(weg.serverId));
    await runNow(s);
    expect(s.agents[0]?.rpcs.filter(isScan)).toHaveLength(2);
    // The first rejection skips the rest of the server.
    expect(s.agents[1]?.rpcs.filter(isScan)).toHaveLength(1);
    const st = await getState(s);
    expect(st.results.map((r) => r.containerName).sort()).toEqual(['db', 'web1', 'web2']);
    expect(st.skippedServers.map((x) => x.name)).toEqual(['alt', 'weg']);
  });

  it('POST run -> 202 running with progress; 409 while running; 429 within 10 min', async () => {
    let hold: Received[] = [];
    const s = await opsSetup(clients, {
      servers: [
        {
          name: 'heimserver',
          containers: [info('nginx'), info('db')],
          reply: (rpc) => {
            if (!isScan(rpc)) return null;
            hold.push(rpc);
            return 'silent';
          },
        },
      ],
    });
    t = s.t;
    const headers = authHeaders(s.cookie);
    const run = () => s.t.app.inject({ method: 'POST', url: '/api/vulnscan/run', headers });
    const first = await run();
    expect(first.statusCode).toBe(202);
    const st = vulnScanStateSchema.parse(first.json());
    expect(st.running).toBe(true);
    expect(st.progress).toEqual({ done: 0, total: 2 });
    const busy = await run();
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ ok: false, error: 'busy' });
    // Answer the scans one after another (sequential per server).
    const agent = s.agents[0]?.agent;
    await until(() => hold.length === 1);
    const r1 = hold[0];
    if (!r1 || !agent) throw new Error('no rpc');
    agent.send(ok(r1, vulnData(0, 0)));
    await until(() => hold.length === 2);
    expect((await getState(s)).progress).toEqual({ done: 1, total: 2 });
    const r2 = hold[1];
    if (!r2) throw new Error('no rpc');
    agent.send(ok(r2, vulnData(0, 0)));
    await t.app.hzCore.ops.vulnscan.idle();
    expect((await getState(s)).running).toBe(false);
    hold = [];
    const limited = await run();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ ok: false, error: 'rate_limited' });
    t.clock.advance(10 * 60_000);
    if (s.agents[0]) s.agents[0].reply = (rpc) => (isScan(rpc) ? ok(rpc, scanData()) : null);
    expect((await run()).statusCode).toBe(202);
    await t.app.hzCore.ops.vulnscan.idle();
    const audit = t.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'vulnscan.run'")
      .get() as { n: number };
    expect(audit.n).toBe(2);
  });

  it('module off: job removed, alerts resolved, routes 404; anonymous 401', async () => {
    const s = await opsSetup(clients, {
      servers: [
        {
          name: 'heimserver',
          containers: [info('nginx')],
          reply: (rpc) => (isScan(rpc) ? ok(rpc, vulnData(2, 0)) : null),
        },
      ],
    });
    t = s.t;
    await runNow(s);
    const key = vulnAlertKey(s.agents[0]?.serverId ?? '', 'nginx');
    expect(t.app.hzCore.alerts.active(key)).not.toBeNull();
    t.app.hzCore.modules.set({ vulnscan: false });
    expect(t.app.hzCore.alerts.active(key)).toBeNull();
    expect(t.app.hzCore.scheduler.has(VULNSCAN_JOB)).toBe(false);
    for (const [method, url] of [
      ['GET', '/api/vulnscan'],
      ['POST', '/api/vulnscan/run'],
      ['PUT', '/api/vulnscan/settings'],
    ] as const) {
      const res = await t.app.inject({
        method,
        url,
        headers: authHeaders(s.cookie),
        ...(method === 'PUT' ? { payload: { time: '03:30', alertFrom: 'high' } } : {}),
      });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ ok: false, error: 'module_disabled' });
      const anon = await t.app.inject({ method, url, headers: SAME_ORIGIN });
      expect(anon.statusCode, url).toBe(401);
    }
    // Even a direct start does nothing while off.
    const before = s.agents[0]?.rpcs.filter(isScan).length;
    await runNow(s);
    expect(s.agents[0]?.rpcs.filter(isScan).length).toBe(before);
    t.app.hzCore.modules.set({ vulnscan: true });
    expect(t.app.hzCore.scheduler.has(VULNSCAN_JOB)).toBe(true);
  });

  it('is off by default (fresh install): no job', async () => {
    const s = await opsSetup(clients, { modules: { vulnscan: false } });
    t = s.t;
    expect(t.app.hzCore.scheduler.has(VULNSCAN_JOB)).toBe(false);
  });

  it('switching an ops module does not touch the storage module', async () => {
    const spy = vi.spyOn(StorageService.prototype, 'setEnabled');
    try {
      const s = await opsSetup(clients);
      t = s.t;
      spy.mockClear();
      t.app.hzCore.modules.set({ vulnscan: false, logsearch: false, fail2ban: false });
      t.app.hzCore.modules.set({ vulnscan: true, discordbot: true, voice: false });
      expect(spy).not.toHaveBeenCalled();
      t.app.hzCore.modules.set({ storage: false });
      expect(spy).toHaveBeenCalledWith(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('vulnAlertText', () => {
  const base = { serverName: 'heimserver', containerName: 'nginx' };
  it('German title with singular/plural, high only with alertFrom high', () => {
    expect(vulnAlertText({ ...base, scan: vulnData(1, 2) }, 'critical')?.title).toBe(
      '1 kritische Lücke in nginx',
    );
    expect(vulnAlertText({ ...base, scan: vulnData(1, 2) }, 'high')?.title).toBe(
      '1 kritische und 2 hohe Lücken in nginx',
    );
    expect(vulnAlertText({ ...base, scan: vulnData(0, 2) }, 'critical')).toBeNull();
    expect(vulnAlertText({ ...base, scan: vulnData(0, 0) }, 'high')).toBeNull();
  });

  it('limits the body length and strips control characters', () => {
    const scan = vulnData(60, 0);
    if (scan.vulns[0]) scan.vulns[0].id = 'CVE-1\n\u001b[31mX';
    const text = vulnAlertText({ ...base, scan }, 'critical');
    expect(text?.body.length).toBeLessThanOrEqual(300);
    expect(
      text?.body.startsWith('auf heimserver: CVE-1 [31mX (behoben in 3.0.9), CVE-2026-1001'),
    ).toBe(true);
    expect(text?.body.endsWith(', …')).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(text?.body).not.toMatch(/[\u0000-\u001f]/);
  });
});

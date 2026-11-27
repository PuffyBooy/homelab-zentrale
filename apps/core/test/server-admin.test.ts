import { afterEach, describe, expect, it } from 'vitest';
import { serverDetailSchema, type Alert } from '@hz/shared';
import { DU_BURST, DU_REFILL_MS } from '../src/servers/admin-routes.js';
import {
  enrollAgent,
  inventoryMsg,
  listen,
  until,
  type Received,
  type WsClient,
} from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function withAgent() {
  t = await makeApp();
  const admin = await completeSetup(t);
  const url = await listen(t);
  const e = await enrollAgent(t, url, admin.cookie);
  clients.push(e.agent);
  return { t, url, ...admin, ...e };
}

function get(t: TestApp, cookie: string, url: string) {
  return t.app.inject({ method: 'GET', url, headers: authHeaders(cookie) });
}

function post(t: TestApp, cookie: string, url: string, payload?: unknown) {
  return t.app.inject({
    method: 'POST',
    url,
    headers: authHeaders(cookie),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

const reply = (agent: WsClient, rpc: Received, data: unknown): void =>
  agent.send({ type: 'rpc.result', id: rpc.id, ok: true, data });

const duData = (path: string) => ({
  path,
  totalBytes: 3000,
  entries: [
    { name: 'lib', bytes: 2000, dir: true },
    { name: 'log', bytes: 1000, dir: true },
  ],
  truncated: false,
});

const auditRows = (t: TestApp, action: string) =>
  (
    t.db.sqlite
      .prepare('SELECT target, details_json AS d FROM audit_log WHERE action = ? ORDER BY id')
      .all(action) as { target: string; d: string | null }[]
  ).map((r) => ({ target: r.target, details: r.d === null ? null : (JSON.parse(r.d) as unknown) }));

describe('M16 read-only views relay to the agent', () => {
  it('du, docker-df, services and processes', async () => {
    const { t, cookie, agent, serverId } = await withAgent();

    const du = get(t, cookie, `/api/servers/${serverId}/du?path=/var`);
    const r1 = await agent.nextOfType('rpc');
    expect(r1).toMatchObject({ action: 'system.du', params: { path: '/var' } });
    reply(agent, r1, duData('/var'));
    expect((await du).json()).toEqual(duData('/var'));

    // Default path is the root.
    const du2 = get(t, cookie, `/api/servers/${serverId}/du`);
    const r2 = await agent.nextOfType('rpc');
    expect(r2.params).toEqual({ path: '/' });
    reply(agent, r2, duData('/'));
    expect((await du2).statusCode).toBe(200);

    const df = {
      images: { count: 12, bytes: 9e9, unusedCount: 4, unusedBytes: 3e9 },
      containers: { count: 9, bytes: 1e8, running: 7 },
      volumes: { count: 5, bytes: 2e9, unusedCount: 1, unusedBytes: 1e6 },
      buildCache: { count: 30, bytes: 4e9, unusedBytes: 4e9 },
    };
    const dfRes = get(t, cookie, `/api/servers/${serverId}/docker-df`);
    const r3 = await agent.nextOfType('rpc');
    expect(r3).toMatchObject({ action: 'system.dockerDf', params: {} });
    reply(agent, r3, df);
    expect((await dfRes).json()).toEqual(df);

    const services = {
      systemd: true,
      units: [
        {
          name: 'nginx.service',
          description: 'nginx',
          load: 'loaded',
          active: 'failed',
          sub: 'failed',
          manageable: true,
        },
      ],
    };
    const sv = get(t, cookie, `/api/servers/${serverId}/services`);
    const r4 = await agent.nextOfType('rpc');
    expect(r4).toMatchObject({ action: 'system.services', params: {} });
    reply(agent, r4, services);
    expect((await sv).json()).toEqual(services);

    const list = Array.from({ length: 30 }, (_, i) => ({
      pid: i + 1,
      name: `proc${i}`,
      user: 'root',
      cpu: 1,
      memBytes: 1000 * (30 - i),
      memPct: 1,
      state: 'S',
    }));
    const pr = get(t, cookie, `/api/servers/${serverId}/processes?sort=mem`);
    const r5 = await agent.nextOfType('rpc');
    expect(r5).toMatchObject({ action: 'system.processes', params: { sort: 'mem', limit: 25 } });
    reply(agent, r5, { total: 180, list });
    const prBody = (await pr).json<{ total: number; list: unknown[] }>();
    expect(prBody.total).toBe(180);
    // At most PROCESS_LIST_LIMIT, even if the agent sends more.
    expect(prBody.list).toHaveLength(25);
  });

  it('rejects invalid queries without asking the agent', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    for (const q of [
      'path=relative',
      'path=/proc',
      'path=/proc/1',
      'path=/sys/kernel',
      'path=/var/../etc',
      'path=/var/',
      'path=//etc',
      'path=/var&x=1',
    ]) {
      const res = await get(t, cookie, `/api/servers/${serverId}/du?${q}`);
      expect(res.statusCode, q).toBe(400);
    }
    expect((await get(t, cookie, `/api/servers/${serverId}/processes?sort=pid`)).statusCode).toBe(
      400,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(agent.received.filter((m) => m.type === 'rpc')).toEqual([]);
  });

  it('a broken agent answer is 502; offline is 409; unknown server 404', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    const p = get(t, cookie, `/api/servers/${serverId}/processes`);
    const rpc = await agent.nextOfType('rpc');
    // Command lines are not part of the schema: the answer is refused.
    reply(agent, rpc, {
      total: 1,
      list: [
        {
          pid: 1,
          name: 'x',
          user: 'root',
          cpu: 1,
          memBytes: 1,
          memPct: 1,
          state: 'S',
          cmdline: 'secret --password=hunter2',
        },
      ],
    });
    const res = await p;
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('hunter2');

    expect((await get(t, cookie, '/api/servers/AAAAAAAAAAAAAAAAAAAAAA/du')).statusCode).toBe(404);
    agent.close();
    await until(() => !t.app.hzCore.hub.isConnected(serverId));
    for (const path of ['du', 'docker-df', 'services', 'processes']) {
      const r = await get(t, cookie, `/api/servers/${serverId}/${path}`);
      expect(r.statusCode, path).toBe(409);
      expect(r.json()).toEqual({ ok: false, error: 'agent_offline' });
    }
    const sa = await post(t, cookie, `/api/servers/${serverId}/services`, {
      unit: 'nginx.service',
      op: 'restart',
    });
    expect(sa.statusCode).toBe(409);
  });
});

describe('du rate limit', () => {
  it(`allows a burst of ${DU_BURST}, then one call per 5 s per server`, async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    for (let i = 0; i < DU_BURST; i++) {
      const p = get(t, cookie, `/api/servers/${serverId}/du?path=/var`);
      reply(agent, await agent.nextOfType('rpc'), duData('/var'));
      expect((await p).statusCode).toBe(200);
    }
    const limited = await get(t, cookie, `/api/servers/${serverId}/du?path=/var`);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const sent = agent.received.filter((m) => m.type === 'rpc').length;
    expect(sent).toBe(DU_BURST);

    t.clock.advance(DU_REFILL_MS);
    const p = get(t, cookie, `/api/servers/${serverId}/du?path=/var`);
    reply(agent, await agent.nextOfType('rpc'), duData('/var'));
    expect((await p).statusCode).toBe(200);
    expect((await get(t, cookie, `/api/servers/${serverId}/du?path=/`)).statusCode).toBe(429);
  });
});

describe('cleanup with a selection', () => {
  it('passes items only when given; an empty body cleans everything', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    const p1 = post(t, cookie, `/api/servers/${serverId}/cleanup`, {
      items: ['docker-build-cache'],
    });
    const r1 = await agent.nextOfType('rpc');
    expect(r1).toMatchObject({
      action: 'system.cleanup',
      params: { items: ['docker-build-cache'] },
    });
    reply(agent, r1, { freedBytes: 100 });
    expect((await p1).json()).toEqual({ freedBytes: 100 });

    // No body at all, and an empty JSON object.
    for (const payload of [undefined, {}]) {
      const p = post(t, cookie, `/api/servers/${serverId}/cleanup`, payload);
      const r = await agent.nextOfType('rpc');
      expect(r.params).toEqual({});
      reply(agent, r, { freedBytes: 5 });
      expect((await p).statusCode).toBe(200);
    }
    const audit = auditRows(t, 'server.cleanup');
    expect(audit[0]?.details).toMatchObject({ items: ['docker-build-cache'] });
    expect(audit[1]?.details).not.toHaveProperty('items');
  });

  it('rejects unknown, duplicate or empty items without asking the agent', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    for (const payload of [
      { items: [] },
      { items: ['volumes'] },
      { items: ['containers'] },
      { items: ['journal', 'journal'] },
      { items: 'journal' },
      { other: 1 },
    ]) {
      const res = await post(t, cookie, `/api/servers/${serverId}/cleanup`, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(agent.received.filter((m) => m.type === 'rpc')).toEqual([]);
  });
});

describe('service actions', () => {
  it('restarts an allowed unit and audits unit and op', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    const p = post(t, cookie, `/api/servers/${serverId}/services`, {
      unit: 'nginx.service',
      op: 'restart',
    });
    const rpc = await agent.nextOfType('rpc');
    expect(rpc).toMatchObject({
      action: 'system.service',
      params: { unit: 'nginx.service', op: 'restart' },
    });
    reply(agent, rpc, null);
    const res = await p;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(auditRows(t, 'server.service')).toEqual([
      {
        target: serverId,
        details: { name: 'heimserver', unit: 'nginx.service', op: 'restart' },
      },
    ]);
  });

  it('passes agent refusals through as 403 / 400 / 404 (never the agent text)', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    const cases: [string, number, string][] = [
      ['not_allowed', 403, 'forbidden'],
      ['invalid_params', 400, 'invalid_input'],
      ['not_found', 404, 'not_found'],
      ['failed', 502, 'agent_error'],
    ];
    for (const [code, status, error] of cases) {
      const p = post(t, cookie, `/api/servers/${serverId}/services`, {
        unit: 'myapp.service',
        op: 'stop',
      });
      const rpc = await agent.nextOfType('rpc');
      agent.send({
        type: 'rpc.result',
        id: rpc.id,
        ok: false,
        error: { code, message: 'unit myapp.service not in HZ_AGENT_SERVICES' },
      });
      const res = await p;
      expect(res.statusCode, code).toBe(status);
      expect(res.json()).toEqual({ ok: false, error });
      expect(res.body).not.toContain('HZ_AGENT_SERVICES');
    }
    const failed = auditRows(t, 'server.service_failed');
    expect(failed).toHaveLength(4);
    expect(failed[0]?.details).toMatchObject({
      unit: 'myapp.service',
      op: 'stop',
      error: 'forbidden',
    });
  });
});

describe('failed systemd units from the inventory', () => {
  it('status reason, one warn alert per unit, OK entry when the unit recovers', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    const key = (u: string) => `server:${serverId}:service:${u}`;
    agent.send(inventoryMsg({ failedServices: ['nginx.service'] }));
    await until(() => t.app.hzCore.alerts.active(key('nginx.service')) !== null);
    const alert = t.app.hzCore.alerts.active(key('nginx.service'));
    expect(alert).toMatchObject({
      level: 'warn',
      source: 'server',
      serverId,
      title: 'Dienst nginx.service auf heimserver fehlgeschlagen',
    });
    const detail = serverDetailSchema.parse(
      (await get(t, cookie, `/api/servers/${serverId}`)).json(),
    );
    expect(detail.failedServices).toEqual(['nginx.service']);
    expect(detail.server.status).toBe('warn');
    expect(detail.server.reasons).toContainEqual({
      level: 'warn',
      code: 'service_failed',
      text: 'Dienst nginx.service fehlgeschlagen',
    });

    // Same unit again: still one alert (dedupe), plus two more units.
    agent.send(
      inventoryMsg({ failedServices: ['nginx.service', 'backup.service', 'foo@bar.service'] }),
    );
    await until(() => t.app.hzCore.alerts.active(key('backup.service')) !== null);
    const summary = t.app.hzCore.servers.summary(serverId);
    expect(summary?.reasons).toContainEqual({
      level: 'warn',
      code: 'service_failed',
      text: '3 Dienste fehlgeschlagen',
    });
    const open = t.app.hzCore.alerts
      .list({ state: 'active', limit: 100 })
      .filter((a: Alert) => a.key.includes(':service:'));
    expect(open.map((a) => a.key).sort()).toEqual(
      [key('backup.service'), key('foo@bar.service'), key('nginx.service')].sort(),
    );

    // nginx recovers.
    agent.send(inventoryMsg({ failedServices: ['backup.service', 'foo@bar.service'] }));
    await until(() => t.app.hzCore.alerts.active(key('nginx.service')) === null);
    const ok = t.app.hzCore.alerts
      .list({ state: 'all', limit: 100 })
      .find((a) => a.key === key('nginx.service') && a.level === 'ok');
    expect(ok?.title).toBe('Dienst nginx.service auf heimserver nicht mehr fehlgeschlagen');
    expect(t.app.hzCore.alerts.active(key('backup.service'))).not.toBeNull();

    // An inventory without the field (older agent) changes nothing.
    agent.send(inventoryMsg());
    await new Promise((r) => setTimeout(r, 50));
    expect(t.app.hzCore.alerts.active(key('backup.service'))).not.toBeNull();

    agent.send(inventoryMsg({ failedServices: [] }));
    await until(() => t.app.hzCore.alerts.active(key('backup.service')) === null);
    expect(t.app.hzCore.servers.summary(serverId)?.reasons.map((r) => r.code)).not.toContain(
      'service_failed',
    );
    expect(
      serverDetailSchema.parse((await get(t, cookie, `/api/servers/${serverId}`)).json())
        .failedServices,
    ).toEqual([]);
  });

  it('drops implausible unit names from the agent', async () => {
    const { t, agent, serverId } = await withAgent();
    agent.send(inventoryMsg({ failedServices: ['ok.service', 'bad name\n.service', '<b>x</b>'] }));
    await until(() => t.app.hzCore.alerts.active(`server:${serverId}:service:ok.service`) !== null);
    expect(t.app.hzCore.servers.detail(serverId)?.failedServices).toEqual(['ok.service']);
  });
});

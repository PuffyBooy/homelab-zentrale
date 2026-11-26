import { afterEach, describe, expect, it } from 'vitest';
import {
  enrollResponseSchema,
  historyResponseSchema,
  serverDetailSchema,
  serverListResponseSchema,
  type Alert,
} from '@hz/shared';
import {
  connectAgent,
  enrollAgent,
  inventoryMsg,
  listen,
  metricsMsg,
  stepUp,
  until,
  type WsClient,
} from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, SAME_ORIGIN, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(env: Record<string, string> = {}) {
  t = await makeApp({ env });
  const admin = await completeSetup(t);
  const url = await listen(t);
  return { t, url, ...admin };
}

async function withAgent(env: Record<string, string> = {}) {
  const s = await setup(env);
  const e = await enrollAgent(s.t, s.url, s.cookie);
  clients.push(e.agent);
  return { ...s, ...e };
}

function get(t: TestApp, cookie: string, url: string) {
  return t.app.inject({ method: 'GET', url, headers: authHeaders(cookie) });
}

function post(t: TestApp, cookie: string, url: string, payload: unknown = {}) {
  return t.app.inject({
    method: 'POST',
    url,
    headers: authHeaders(cookie),
    payload: payload as object,
  });
}

/** Ticks the scheduler after moving the fake clock in steps of `stepMs`. */
async function advance(t: TestApp, ms: number, stepMs = 5_000): Promise<void> {
  for (let done = 0; done < ms; done += stepMs) {
    t.clock.advance(Math.min(stepMs, ms - done));
    await t.app.hzCore.scheduler.tick();
  }
}

function alerts(t: TestApp): Alert[] {
  return t.app.hzCore.alerts.list({ state: 'all', limit: 500 });
}

describe('GET /api/servers, /:id, /:id/history', () => {
  it('lists servers with live values, detail with inventory', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    agent.send(metricsMsg({ cpu: 23.46, ramPct: 48, diskPct: 81 }));
    agent.send(inventoryMsg());
    await until(() => t.app.hzCore.servers.summary(serverId)?.containersTotal === 2);

    const list = await get(t, cookie, '/api/servers');
    expect(list.statusCode).toBe(200);
    const body = serverListResponseSchema.parse(list.json());
    expect(body.servers[0]).toMatchObject({
      id: serverId,
      name: 'heimserver',
      status: 'ok',
      connected: true,
      cpu: 23.5,
      ramPct: 48,
      diskPct: 81,
      tailscaleIp: '100.64.0.5',
      containersRunning: 1,
      containersTotal: 2,
      agentVersion: '0.2.0',
    });

    const detail = serverDetailSchema.parse(
      (await get(t, cookie, `/api/servers/${serverId}`)).json(),
    );
    expect(detail.system?.kernel).toBe('6.8.0');
    expect(detail.disks[0]?.mount).toBe('/');
    expect(detail.sshFailed24h).toBe(3);
    expect(detail.listeningPorts[0]?.port).toBe(22);
    expect(detail.thresholds.cpuWarn).toBe(85);

    const hist = await get(t, cookie, `/api/servers/${serverId}/history?range=1h`);
    expect(hist.statusCode).toBe(200);
    const h = historyResponseSchema.parse(hist.json());
    expect(h.points).toHaveLength(1);
    expect(h.points[0]).toMatchObject({ cpu: 23.5, ramPct: 48, netIn: 1000, netOut: 500 });
    expect((await get(t, cookie, `/api/servers/${serverId}/history`)).json().range).toBe('24h');
  });

  it('sorts crit, warn, then by name', async () => {
    const { t, url, cookie } = await setup();
    const ids: Record<string, string> = {};
    for (const name of ['zeta', 'alpha', 'mid']) {
      const e = await enrollAgent(t, url, cookie, name);
      clients.push(e.agent);
      ids[name] = e.serverId;
      e.agent.send(metricsMsg({ diskPct: name === 'zeta' ? 97 : name === 'mid' ? 88 : 10 }));
    }
    await until(() => t.app.hzCore.servers.summary(ids.zeta ?? '')?.status === 'crit');
    await until(() => t.app.hzCore.servers.summary(ids.mid ?? '')?.status === 'warn');
    const names = (await get(t, cookie, '/api/servers'))
      .json()
      .servers.map((s: { name: string }) => s.name);
    expect(names).toEqual(['zeta', 'mid', 'alpha']);
  });

  it('answers 404 for unknown servers and 400 for invalid ids or ranges', async () => {
    const { t, cookie, serverId } = await withAgent();
    expect((await get(t, cookie, '/api/servers/AAAAAAAAAAAAAAAAAAAAAA')).statusCode).toBe(404);
    expect((await get(t, cookie, '/api/servers/x')).statusCode).toBe(400);
    expect((await get(t, cookie, '/api/servers/a%20b%20c%20d%20e')).statusCode).toBe(400);
    expect((await get(t, cookie, `/api/servers/${serverId}/history?range=1y`)).statusCode).toBe(
      400,
    );
    expect((await get(t, cookie, `/api/servers/${serverId}/history?range=1h&x=1`)).statusCode).toBe(
      400,
    );
  });
});

describe('POST /api/servers/enroll', () => {
  it('returns a one-time token with docker run and compose snippets (tailnet URL)', async () => {
    const { t, cookie } = await setup({ HZ_BASE_URL: 'https://heimserver.tail1234.ts.net' });
    const res = await post(t, cookie, '/api/servers/enroll', {
      name: 'oracle-a1',
      location: 'Frankfurt',
    });
    expect(res.statusCode).toBe(200);
    const body = enrollResponseSchema.parse(res.json());
    expect(Date.parse(body.expiresAt) - t.clock.t).toBe(15 * 60_000);
    expect(body.dockerRun).toContain('-e HZ_CORE_URL=wss://heimserver.tail1234.ts.net/agent');
    expect(body.dockerRun).toContain(`-e HZ_AGENT_TOKEN=${body.token}`);
    expect(body.dockerRun).toContain('-e HZ_AGENT_NAME=oracle-a1');
    expect(body.dockerRun).toContain('--name homelab-agent');
    expect(body.dockerRun).toContain('-e HZ_AGENT_HOST_EXEC=nsenter');
    expect(body.dockerRun).toContain('--cap-drop ALL');
    expect(body.dockerRun.endsWith(' homelab-zentrale/agent:local')).toBe(true);
    expect(body.compose).toContain("HZ_CORE_URL: 'wss://heimserver.tail1234.ts.net/agent'");
    expect(body.compose).toContain(`HZ_AGENT_TOKEN: '${body.token}'`);
    expect(body.compose).toContain('container_name: homelab-agent');
  });

  it('uses ws://127.0.0.1:<port>/agent without HZ_BASE_URL', async () => {
    const { t, cookie } = await setup({ HZ_PORT: '8099' });
    const body = (await post(t, cookie, '/api/servers/enroll', { name: 'pi' })).json();
    expect(body.dockerRun).toContain('HZ_CORE_URL=ws://127.0.0.1:8099/agent');
  });

  it('rejects invalid names', async () => {
    const { t, cookie } = await setup();
    for (const name of ['', 'Heimserver', 'a b', '-x', 'x;rm -rf /', 'a'.repeat(64)]) {
      const res = await post(t, cookie, '/api/servers/enroll', { name });
      expect(res.statusCode, name).toBe(400);
    }
    expect(
      (await post(t, cookie, '/api/servers/enroll', { name: 'ok', extra: 1 })).statusCode,
    ).toBe(400);
  });

  it('needs the same Origin', async () => {
    const { t, cookie } = await setup();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/servers/enroll',
      headers: { ...authHeaders(cookie), origin: 'https://evil.example' },
      payload: { name: 'pi' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, error: 'bad_origin' });
  });
});

describe('PATCH /api/servers/:id', () => {
  it('updates location and merges thresholds (only sent keys change)', async () => {
    const { t, cookie, serverId } = await withAgent();
    const patch = (payload: unknown) =>
      t.app.inject({
        method: 'PATCH',
        url: `/api/servers/${serverId}`,
        headers: authHeaders(cookie),
        payload: payload as object,
      });
    let res = await patch({ location: 'Keller', thresholds: { diskWarn: 70 } });
    expect(res.statusCode).toBe(200);
    res = await patch({ thresholds: { cpuWarn: 90 } });
    const d = serverDetailSchema.parse(res.json());
    expect(d.server.location).toBe('Keller');
    expect(d.thresholds).toMatchObject({ diskWarn: 70, cpuWarn: 90, diskCrit: 95 });
    const audit = t.db.sqlite
      .prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'server.updated'")
      .get();
    expect(audit).toEqual({ n: 2 });
  });

  it('rejects invalid thresholds', async () => {
    const { t, cookie, serverId } = await withAgent();
    for (const payload of [
      { thresholds: { cpuWarn: 0 } },
      { thresholds: { cpuWarn: 101 } },
      { thresholds: { unknown: 1 } },
      { thresholds: { diskWarn: 97 } },
      { location: 'x'.repeat(61) },
      { name: 'renamed' },
    ]) {
      const res = await t.app.inject({
        method: 'PATCH',
        url: `/api/servers/${serverId}`,
        headers: authHeaders(cookie),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('allowTerminal needs step-up', async () => {
    const { t, cookie, secret, serverId } = await withAgent();
    const patch = () =>
      t.app.inject({
        method: 'PATCH',
        url: `/api/servers/${serverId}`,
        headers: authHeaders(cookie),
        payload: { allowTerminal: true },
      });
    const denied = await patch();
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ ok: false, error: 'step_up_required' });
    expect(t.app.hzCore.servers.row(serverId)?.allowTerminal).toBe(false);
    await stepUp(t, secret, cookie);
    const ok = await patch();
    expect(ok.statusCode).toBe(200);
    expect(ok.json().server.allowTerminal).toBe(true);
  });
});

describe('cleanup and reboot (RPC to the agent)', () => {
  it('cleanup-preview and cleanup relay to the agent', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    const preview = post(t, cookie, `/api/servers/${serverId}/cleanup-preview`);
    const rpc = await agent.nextOfType('rpc');
    expect(rpc).toMatchObject({ action: 'system.cleanupPreview', params: {} });
    const data = { items: [{ kind: 'apt-cache', bytes: 1_000_000 }], totalBytes: 1_000_000 };
    agent.send({ type: 'rpc.result', id: rpc.id, ok: true, data });
    const res = await preview;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(data);

    const cleanup = post(t, cookie, `/api/servers/${serverId}/cleanup`);
    const rpc2 = await agent.nextOfType('rpc');
    agent.send({ type: 'rpc.result', id: rpc2.id, ok: true, data: { freedBytes: 42 } });
    expect((await cleanup).json()).toEqual({ freedBytes: 42 });
  });

  it('maps a broken agent answer to 502 and agent errors to 502', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    const p = post(t, cookie, `/api/servers/${serverId}/cleanup-preview`);
    const rpc = await agent.nextOfType('rpc');
    agent.send({ type: 'rpc.result', id: rpc.id, ok: true, data: { items: 'nope' } });
    expect((await p).statusCode).toBe(502);
    const p2 = post(t, cookie, `/api/servers/${serverId}/cleanup`);
    const rpc2 = await agent.nextOfType('rpc');
    agent.send({
      type: 'rpc.result',
      id: rpc2.id,
      ok: false,
      error: { code: 'failed', message: 'apt locked' },
    });
    const r2 = await p2;
    expect(r2.statusCode).toBe(502);
    expect(r2.json()).toEqual({ ok: false, error: 'agent_error' });
  });

  it('answers 409 agent_offline when the agent is not connected', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    agent.close();
    await until(() => !t.app.hzCore.hub.isConnected(serverId));
    for (const path of ['cleanup-preview', 'cleanup']) {
      const res = await post(t, cookie, `/api/servers/${serverId}/${path}`);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ ok: false, error: 'agent_offline' });
    }
  });

  it('reboots with step-up and the right name', async () => {
    const { t, cookie, secret, agent, serverId } = await withAgent();
    await stepUp(t, secret, cookie);
    const p = post(t, cookie, `/api/servers/${serverId}/reboot`, { confirmName: 'heimserver' });
    const rpc = await agent.nextOfType('rpc');
    expect(rpc).toMatchObject({ action: 'system.reboot', params: { confirmName: 'heimserver' } });
    agent.send({ type: 'rpc.result', id: rpc.id, ok: true, data: null });
    const res = await p;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const audit = t.db.sqlite
      .prepare("SELECT target FROM audit_log WHERE action = 'server.reboot'")
      .all();
    expect(audit).toEqual([{ target: serverId }]);
  });
});

describe('DELETE /api/servers/:id', () => {
  it('disconnects, deletes data and resolves its alerts', async () => {
    const { t, cookie, secret, agent, serverId } = await withAgent();
    agent.send(metricsMsg({ diskPct: 97 }));
    await until(() => t.app.hzCore.alerts.active(`server:${serverId}:disk`) !== null);
    await stepUp(t, secret, cookie);
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/servers/${serverId}`,
      headers: authHeaders(cookie),
    });
    expect(res.statusCode).toBe(200);
    await agent.closed;
    expect((await get(t, cookie, `/api/servers/${serverId}`)).statusCode).toBe(404);
    for (const table of ['metrics_raw', 'agent_tokens', 'server_state', 'containers']) {
      expect(t.db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    expect(t.app.hzCore.alerts.list({ state: 'active', limit: 10 })).toEqual([]);
    // The name is free again.
    expect((await post(t, cookie, '/api/servers/enroll', { name: 'heimserver' })).statusCode).toBe(
      200,
    );
  });
});

describe('offline detection (fake clock)', () => {
  it('a stopped agent is DOWN within 90 s, with an alert, and OK when it is back', async () => {
    const { t, url, cookie, agent, serverId, agentToken } = await withAgent();
    agent.send(metricsMsg());
    await until(() => t.app.hzCore.servers.summary(serverId)?.cpu !== null);
    agent.close();
    await until(() => !t.app.hzCore.hub.isConnected(serverId));

    await advance(t, 25_000);
    expect(t.app.hzCore.servers.summary(serverId)?.status).toBe('ok');
    await advance(t, 5_000);
    const down = t.app.hzCore.servers.summary(serverId);
    expect(down?.status).toBe('crit');
    expect(down?.reasons[0]?.code).toBe('offline');

    const offline = t.app.hzCore.alerts.active(`server:${serverId}:offline`);
    expect(offline).toMatchObject({
      level: 'crit',
      title: 'heimserver ist offline',
      source: 'server',
      serverId,
      state: 'open',
    });
    // T0 is 12:00 UTC = 13:00 in Vienna.
    expect(offline?.body).toMatch(
      /^Seit 13:0\d keine Meldung vom Agent\. Prüf, ob der Container homelab-agent läuft\.$/,
    );

    // Dedupe: more ticks, still one alert.
    await advance(t, 60_000);
    expect(alerts(t).filter((a) => a.key === `server:${serverId}:offline`)).toHaveLength(1);

    const back = await connectAgent(url, agentToken);
    clients.push(back);
    await until(() => t.app.hzCore.servers.summary(serverId)?.status === 'ok');
    const all = alerts(t).filter((a) => a.key === `server:${serverId}:offline`);
    expect(all.map((a) => [a.level, a.state])).toEqual(
      expect.arrayContaining([
        ['crit', 'resolved'],
        ['ok', 'resolved'],
      ]),
    );
    const ok = all.find((a) => a.level === 'ok');
    expect(ok?.title).toBe('heimserver ist wieder online');
    expect(ok?.body).toMatch(/^Seit \d\d:\d\d wieder verbunden, nach 1 Min offline\.$/);
    void cookie;
  });

  it('a connected but silent agent is DOWN after 90 s', async () => {
    const { t, agent, serverId } = await withAgent();
    agent.send(metricsMsg());
    await until(() => t.app.hzCore.servers.summary(serverId)?.cpu !== null);
    await advance(t, 90_000);
    expect(t.app.hzCore.servers.summary(serverId)?.status).toBe('ok');
    await advance(t, 5_000);
    expect(t.app.hzCore.servers.summary(serverId)?.status).toBe('crit');
    expect(t.app.hzCore.alerts.active(`server:${serverId}:offline`)?.level).toBe('crit');
  });

  it('disk crit raises an alert, recovery resolves it with an OK alert', async () => {
    const { t, agent, serverId } = await withAgent();
    agent.send(metricsMsg({ diskPct: 86 }));
    await until(() => t.app.hzCore.alerts.active(`server:${serverId}:disk`) !== null);
    expect(t.app.hzCore.alerts.active(`server:${serverId}:disk`)).toMatchObject({
      level: 'warn',
      title: 'Disk / auf heimserver bei 86 %',
    });
    agent.send(metricsMsg({ diskPct: 96.2 }));
    await until(() => t.app.hzCore.alerts.active(`server:${serverId}:disk`)?.level === 'crit');
    const crit = t.app.hzCore.alerts.active(`server:${serverId}:disk`);
    expect(crit?.title).toBe('Disk / auf heimserver bei 96 %');
    expect(crit?.body).toMatch(/über 95 %\. Aufräumen im Serverdetail zeigt, was frei wird\.$/);
    agent.send(metricsMsg({ diskPct: 60 }));
    await until(() => t.app.hzCore.alerts.active(`server:${serverId}:disk`) === null);
    const ok = alerts(t).find((a) => a.key === `server:${serverId}:disk` && a.level === 'ok');
    expect(ok?.title).toBe('Disk auf heimserver wieder bei 60 %');
    // One alert for warn -> crit (escalated), plus the OK.
    expect(alerts(t).filter((a) => a.key === `server:${serverId}:disk`)).toHaveLength(2);
  });

  it('metric alerts are not resolved while the server is offline', async () => {
    const { t, agent, serverId } = await withAgent();
    agent.send(metricsMsg({ diskPct: 97 }));
    await until(() => t.app.hzCore.alerts.active(`server:${serverId}:disk`) !== null);
    agent.close();
    await until(() => !t.app.hzCore.hub.isConnected(serverId));
    await advance(t, 35_000);
    expect(t.app.hzCore.servers.summary(serverId)?.status).toBe('crit');
    expect(t.app.hzCore.alerts.active(`server:${serverId}:disk`)).not.toBeNull();
  });
});

describe('without session', () => {
  it('every new route answers 401', async () => {
    t = await makeApp();
    for (const [method, url] of [
      ['GET', '/api/servers'],
      ['GET', '/api/servers/AAAAAAAAAAAAAAAAAAAAAA'],
      ['GET', '/api/servers/AAAAAAAAAAAAAAAAAAAAAA/history'],
      ['POST', '/api/servers/enroll'],
      ['PATCH', '/api/servers/AAAAAAAAAAAAAAAAAAAAAA'],
      ['DELETE', '/api/servers/AAAAAAAAAAAAAAAAAAAAAA'],
      ['POST', '/api/servers/AAAAAAAAAAAAAAAAAAAAAA/reboot'],
      ['GET', '/api/alerts'],
      ['POST', '/api/alerts/AAAAAAAAAAAAAAAAAAAAAA/ack'],
    ] as const) {
      const res = await t.app.inject({
        method,
        url,
        headers: SAME_ORIGIN,
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

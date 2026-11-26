import { afterEach, describe, expect, it } from 'vitest';
import { STEP_UP_MINUTES } from '@hz/shared';
import { RpcError } from '../src/agents/hub.js';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { enrollAgent, helloMsg, listen, stepUp, WsClient } from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function withAgent(capabilities = { terminal: false, docker: true }) {
  t = await makeApp();
  const admin = await completeSetup(t);
  const url = await listen(t);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/servers/enroll',
    headers: authHeaders(admin.cookie),
    payload: { name: 'heimserver' },
  });
  const agent = await WsClient.connect(`${url}/agent`);
  clients.push(agent);
  agent.send(helloMsg(res.json<{ token: string }>().token, { capabilities }));
  const enrolled = await agent.nextOfType('enrolled');
  await agent.nextOfType('welcome');
  return { t, url, ...admin, agent, serverId: enrolled.serverId as string };
}

const reboot = (t: TestApp, cookie: string, id: string, payload: unknown) =>
  t.app.inject({
    method: 'POST',
    url: `/api/servers/${id}/reboot`,
    headers: authHeaders(cookie),
    payload: payload as object,
  });

const rpcsSent = (agent: WsClient) => agent.received.filter((m) => m.type === 'rpc');

describe('reboot', () => {
  it('without step-up: 403 and nothing reaches the agent', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    const res = await reboot(t, cookie, serverId, { confirmName: 'heimserver' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    await new Promise((r) => setTimeout(r, 50));
    expect(rpcsSent(agent)).toEqual([]);
  });

  it('with a wrong confirmName: 400 confirm_mismatch and nothing reaches the agent', async () => {
    const { t, cookie, secret, agent, serverId } = await withAgent();
    await stepUp(t, secret, cookie);
    for (const confirmName of ['oracle-a1', 'heimserver2']) {
      const res = await reboot(t, cookie, serverId, { confirmName });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'confirm_mismatch' });
    }
    for (const payload of [
      {},
      { confirmName: 'HEIMSERVER' },
      { confirmName: 'heimserver', x: 1 },
    ]) {
      expect((await reboot(t, cookie, serverId, payload)).statusCode).toBe(400);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(rpcsSent(agent)).toEqual([]);
  });

  it('step-up expires after 15 min', async () => {
    const { t, cookie, secret, serverId } = await withAgent();
    await stepUp(t, secret, cookie);
    t.clock.advance(STEP_UP_MINUTES * 60_000);
    expect((await reboot(t, cookie, serverId, { confirmName: 'heimserver' })).statusCode).toBe(403);
  });
});

describe('terminal', () => {
  it('pty actions are refused unless allowed in the core and on the agent', async () => {
    const { t, cookie, secret, agent, serverId } = await withAgent({
      terminal: true,
      docker: true,
    });
    const hub = t.app.hzCore.hub;
    expect(() => hub.stream(serverId, 'pty.open', { cols: 80, rows: 24 })).toThrow(RpcError);
    await stepUp(t, secret, cookie);
    await t.app.inject({
      method: 'PATCH',
      url: `/api/servers/${serverId}`,
      headers: authHeaders(cookie),
      payload: { allowTerminal: true },
    });
    const s = hub.stream(serverId, 'pty.open', { cols: 80, rows: 24 });
    expect((await agent.nextOfType('rpc')).id).toBe(s.id);
  });

  it('pty actions are refused when the agent has no terminal capability', async () => {
    const { t, cookie, secret, serverId, agent } = await withAgent();
    await stepUp(t, secret, cookie);
    await t.app.inject({
      method: 'PATCH',
      url: `/api/servers/${serverId}`,
      headers: authHeaders(cookie),
      payload: { allowTerminal: true },
    });
    expect(() => t.app.hzCore.hub.stream(serverId, 'pty.open', { cols: 80, rows: 24 })).toThrow(
      expect.objectContaining({ code: 'terminal_disabled' }),
    );
    expect(rpcsSent(agent)).toEqual([]);
  });
});

describe('route inventory', () => {
  it('all M2 routes are registered and none is public', async () => {
    t = await makeApp();
    const routes = t.app.hzRoutes.map((r) => `${r.method} ${r.url}`);
    const m2 = [
      'GET /api/servers',
      'GET /api/servers/:id',
      'GET /api/servers/:id/history',
      'POST /api/servers/enroll',
      'PATCH /api/servers/:id',
      'POST /api/servers/:id/cleanup-preview',
      'POST /api/servers/:id/cleanup',
      'POST /api/servers/:id/reboot',
      'POST /api/servers/:id/revoke-agent',
      'DELETE /api/servers/:id',
      'GET /api/alerts',
      'POST /api/alerts/:id/ack',
      'POST /api/alerts/:id/resolve',
    ];
    expect(routes).toEqual(expect.arrayContaining([...m2, 'GET /agent', 'GET /live']));
    for (const r of m2) expect(PUBLIC_API_ROUTES).not.toContain(r.split(' ')[1]);
  });

  it('a plain GET without upgrade: /agent 404, /live 401 (gate runs first)', async () => {
    t = await makeApp();
    expect((await t.app.inject({ method: 'GET', url: '/agent' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/live' })).statusCode).toBe(401);
  });

  it('enrollAgent helper works on a fresh app (sanity)', async () => {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    const url = await listen(t);
    const e = await enrollAgent(t, url, cookie, 'pi');
    clients.push(e.agent);
    expect(t.app.hzCore.hub.connectedIds()).toEqual([e.serverId]);
  });
});

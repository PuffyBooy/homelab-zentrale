import { afterEach, describe, expect, it } from 'vitest';
import { STEP_UP_MINUTES } from '@hz/shared';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { enrollAgent, listen, stepUp, type WsClient } from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, SAME_ORIGIN, type TestApp } from './helpers.js';

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
  return { t, ...admin, ...e };
}

const M16_ROUTES = [
  'GET /api/servers/:id/du',
  'GET /api/servers/:id/docker-df',
  'GET /api/servers/:id/services',
  'POST /api/servers/:id/services',
  'GET /api/servers/:id/processes',
  'POST /api/servers/:id/shutdown',
  'POST /api/servers/:id/cleanup',
  'GET /api/servers/:id/history',
];

const rpcsSent = (agent: WsClient) => agent.received.filter((m) => m.type === 'rpc');
const settle = () => new Promise((r) => setTimeout(r, 50));

const shutdown = (t: TestApp, cookie: string, id: string, payload: unknown) =>
  t.app.inject({
    method: 'POST',
    url: `/api/servers/${id}/shutdown`,
    headers: authHeaders(cookie),
    payload: payload as object,
  });

describe('M16 routes need an admin session', () => {
  it('are registered, not public and answer 401 without a session', async () => {
    t = await makeApp();
    const routes = t.app.hzRoutes.map((r) => `${r.method} ${r.url}`);
    expect(routes).toEqual(expect.arrayContaining(M16_ROUTES));
    for (const r of M16_ROUTES) {
      const [method, path] = r.split(' ') as [string, string];
      expect(PUBLIC_API_ROUTES).not.toContain(path);
      const res = await t.app.inject({
        method: method as 'GET',
        url: path.replace(':id', 'AAAAAAAAAAAAAAAAAAAAAA'),
        headers: SAME_ORIGIN,
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(res.statusCode, r).toBe(401);
    }
  });
});

describe('shutdown', () => {
  it('without step-up: 403 and nothing reaches the agent', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    const res = await shutdown(t, cookie, serverId, { confirmName: 'heimserver' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    await settle();
    expect(rpcsSent(agent)).toEqual([]);
  });

  it('with a wrong name: 400 confirm_mismatch and nothing reaches the agent', async () => {
    const { t, cookie, secret, agent, serverId } = await withAgent();
    await stepUp(t, secret, cookie);
    for (const confirmName of ['oracle-a1', 'heimserver2']) {
      const res = await shutdown(t, cookie, serverId, { confirmName });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'confirm_mismatch' });
    }
    for (const payload of [
      {},
      { confirmName: 'HEIMSERVER' },
      { confirmName: 'heimserver', x: 1 },
    ]) {
      expect((await shutdown(t, cookie, serverId, payload)).statusCode).toBe(400);
    }
    await settle();
    expect(rpcsSent(agent)).toEqual([]);
  });

  it('with step-up and the right name: system.shutdown and an audit entry', async () => {
    const { t, cookie, secret, agent, serverId } = await withAgent();
    await stepUp(t, secret, cookie);
    const p = shutdown(t, cookie, serverId, { confirmName: 'heimserver' });
    const rpc = await agent.nextOfType('rpc');
    expect(rpc).toMatchObject({
      action: 'system.shutdown',
      params: { confirmName: 'heimserver' },
    });
    agent.send({ type: 'rpc.result', id: rpc.id, ok: true, data: null });
    const res = await p;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const audit = t.db.sqlite
      .prepare("SELECT target FROM audit_log WHERE action = 'server.shutdown'")
      .all();
    expect(audit).toEqual([{ target: serverId }]);
  });

  it('step-up expires after 15 min', async () => {
    const { t, cookie, secret, serverId } = await withAgent();
    await stepUp(t, secret, cookie);
    t.clock.advance(STEP_UP_MINUTES * 60_000);
    expect((await shutdown(t, cookie, serverId, { confirmName: 'heimserver' })).statusCode).toBe(
      403,
    );
  });
});

describe('service actions', () => {
  it('never asks the agent for a unit on the deny list', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    for (const unit of [
      'tailscaled.service',
      'docker.service',
      'ssh.service',
      'sshd.service',
      'systemd-journald.service',
      'systemd-anything.service',
      'getty@tty1.service',
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/services`,
        headers: authHeaders(cookie),
        payload: { unit, op: 'stop' },
      });
      expect(res.statusCode, unit).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'forbidden' });
    }
    await settle();
    expect(rpcsSent(agent)).toEqual([]);
    const n = t.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'server.service_refused'")
      .get() as { n: number };
    expect(n.n).toBe(7);
  });

  it('rejects invalid units and ops without asking the agent', async () => {
    const { t, cookie, agent, serverId } = await withAgent();
    for (const payload of [
      { unit: 'nginx', op: 'restart' },
      { unit: '../x.service', op: 'restart' },
      { unit: 'nginx.service; reboot', op: 'restart' },
      { unit: 'nginx.socket', op: 'restart' },
      { unit: 'nginx.service', op: 'mask' },
      { unit: 'nginx.service', op: 'restart', extra: 1 },
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/services`,
        headers: authHeaders(cookie),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    await settle();
    expect(rpcsSent(agent)).toEqual([]);
  });
});

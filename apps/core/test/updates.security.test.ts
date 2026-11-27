import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { enrollAgent, listen, until, type Received, type WsClient } from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, SAME_ORIGIN, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

const M17_ROUTES = [
  'GET /api/updates',
  'PUT /api/servers/:id/update-policy',
  'POST /api/servers/:id/update-check',
  'POST /api/servers/:id/update',
];

async function twoAgents() {
  t = await makeApp({ captureLogs: true });
  const admin = await completeSetup(t);
  const url = await listen(t);
  const heim = await enrollAgent(t, url, admin.cookie, 'heimserver');
  const pi = await enrollAgent(t, url, admin.cookie, 'pi');
  clients.push(heim.agent, pi.agent);
  return { t, ...admin, heim, pi };
}

const imageId = (c: string) => `sha256:${c.repeat(64)}`;
const result = (runId: string, target = 'agent', outcome = 'updated') => ({
  type: 'event',
  ts: new Date().toISOString(),
  event: {
    kind: 'update_result',
    runId,
    target,
    outcome,
    from: { imageId: imageId('a'), version: 'sha-1a2b3c4' },
    to: { imageId: imageId('b'), version: 'sha-5d6e7f8' },
  },
});

const settle = () => new Promise((r) => setTimeout(r, 60));

async function startAgentRun(t: TestApp, cookie: string, serverId: string, agent: WsClient) {
  const p = t.app.inject({
    method: 'POST',
    url: `/api/servers/${serverId}/update`,
    headers: authHeaders(cookie),
    payload: { target: 'agent' },
  });
  const rpc: Received = await agent.nextOfType('rpc');
  agent.send({ type: 'rpc.result', id: rpc.id, ok: true, data: { accepted: true } });
  const res = await p;
  expect(res.statusCode).toBe(200);
  return { rpc, runId: res.json<{ runId: string }>().runId };
}

describe('M17 routes need an admin session', () => {
  it('are registered, not public and answer 401 without a session', async () => {
    t = await makeApp();
    const routes = t.app.hzRoutes.map((r) => `${r.method} ${r.url}`);
    expect(routes).toEqual(expect.arrayContaining(M17_ROUTES));
    for (const r of M17_ROUTES) {
      const [method, path] = r.split(' ') as [string, string];
      expect(PUBLIC_API_ROUTES).not.toContain(path);
      const res = await t.app.inject({
        method: method as 'GET',
        url: path.replace(':id', 'AAAAAAAAAAAAAAAAAAAAAA'),
        headers: SAME_ORIGIN,
        ...(method === 'GET' ? {} : { payload: { target: 'agent' } }),
      });
      expect(res.statusCode, r).toBe(401);
    }
  });
});

describe('no image from the request reaches the agent', () => {
  it('update.apply carries only target and runId, update.check only target', async () => {
    const { t, cookie, heim } = await twoAgents();
    const { rpc, runId } = await startAgentRun(t, cookie, heim.serverId, heim.agent);
    expect(rpc.action).toBe('update.apply');
    expect(rpc.params).toEqual({ target: 'agent', runId });

    const check = t.app.inject({
      method: 'POST',
      url: `/api/servers/${heim.serverId}/update-check`,
      headers: authHeaders(cookie),
      payload: { target: 'agent' },
    });
    const c = await heim.agent.nextOfType('rpc');
    expect(c).toMatchObject({ action: 'update.check', params: { target: 'agent' } });
    expect(Object.keys(c.params as object)).toEqual(['target']);
    heim.agent.send({
      type: 'rpc.result',
      id: c.id,
      ok: false,
      error: { code: 'failed', message: 'x' },
    });
    expect((await check).statusCode).toBe(502);
  });

  it('refuses requests with an image, a tag or another target without asking the agent', async () => {
    const { t, cookie, heim } = await twoAgents();
    for (const [path, payload] of [
      ['update', { target: 'agent', image: 'evil/agent:latest' }],
      ['update', { target: 'agent', ref: 'ghcr.io/evil/agent:latest' }],
      ['update', { target: 'reboot' }],
      ['update', { target: 'updater' }],
      ['update', {}],
      ['update-check', { target: 'os' }],
      ['update-check', { target: 'agent', image: 'x' }],
    ] as const) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/servers/${heim.serverId}/${path}`,
        headers: authHeaders(cookie),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    await settle();
    expect(heim.agent.received.filter((m) => m.type === 'rpc')).toEqual([]);
    expect(t.app.hzUpdates.response().runs).toEqual([]);
  });

  it('the hub itself refuses update.apply with extra params', async () => {
    const { t, heim } = await twoAgents();
    const params = { target: 'agent', runId: 'abcdefgh1234', image: 'evil/x' } as unknown as {
      target: 'agent';
      runId: string;
    };
    await expect(
      t.app.hzCore.hub.call(heim.serverId, 'update.apply', params),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await settle();
    expect(heim.agent.received.filter((m) => m.type === 'rpc')).toEqual([]);
  });
});

describe('update_result only for a known running run of the same server and target', () => {
  it('ignores forged runIds, other servers, other targets and finished runs', async () => {
    const { t, cookie, heim, pi } = await twoAgents();
    const { runId } = await startAgentRun(t, cookie, heim.serverId, heim.agent);
    const status = () => t.app.hzUpdates.run(runId)?.status;

    // Forged / unknown runId.
    heim.agent.send(result('forgedRunId0001'));
    // The run of heimserver reported by pi.
    pi.agent.send(result(runId));
    // Same server, wrong target.
    heim.agent.send(result(runId, 'core'));
    await settle();
    expect(status()).toBe('running');
    expect(t.app.hzUpdates.response().runs).toHaveLength(1);
    expect(
      t.app.hzCore.alerts
        .list({ state: 'all', limit: 50 })
        .filter((a) => a.key.startsWith('update:')),
    ).toEqual([]);
    expect(t.logs.join('')).toContain('update result for an unknown run ignored');

    heim.agent.send(result(runId, 'agent', 'rolled_back'));
    await until(() => status() === 'rolled_back');

    // A repeated (or contradicting) result for a finished run changes nothing.
    heim.agent.send(result(runId, 'agent', 'updated'));
    await settle();
    expect(status()).toBe('rolled_back');
    expect(t.app.hzCore.alerts.active(`update:${heim.serverId}:agent`)?.level).toBe('warn');
  });

  it('a timed-out run cannot be revived by a late event', async () => {
    const { t, cookie, heim } = await twoAgents();
    const { runId } = await startAgentRun(t, cookie, heim.serverId, heim.agent);
    t.clock.advance(15 * 60_000);
    t.app.hzUpdates.tick();
    expect(t.app.hzUpdates.run(runId)?.status).toBe('timeout');
    heim.agent.send(result(runId));
    await settle();
    expect(t.app.hzUpdates.run(runId)?.status).toBe('timeout');
  });

  it('the agent message is stored without control characters and never as HTML', async () => {
    const { t, cookie, heim } = await twoAgents();
    const { runId } = await startAgentRun(t, cookie, heim.serverId, heim.agent);
    const ev = result(runId, 'agent', 'failed');
    heim.agent.send({ ...ev, event: { ...ev.event, message: 'pull\u0007 denied\nfor x' } });
    await until(() => t.app.hzUpdates.run(runId)?.status === 'failed');
    expect(t.app.hzUpdates.run(runId)?.message).toBe('pull  denied for x');
  });
});

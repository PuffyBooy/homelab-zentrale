import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CLOSE, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from '@hz/shared';
import { RpcError } from '../src/agents/hub.js';
import { ENROLL_TTL_MS } from '../src/agents/tokens.js';
import {
  connectAgent,
  createEnrollToken,
  enrollAgent,
  helloMsg,
  listen,
  metricsMsg,
  stepUp,
  until,
  withStepUp,
  WsClient,
} from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});
const track = <T extends WsClient>(c: T): T => {
  clients.push(c);
  return c;
};

async function setup(opts: Parameters<typeof makeApp>[0] = {}) {
  t = await makeApp(opts);
  const admin = await completeSetup(t);
  const url = await listen(t);
  return { t, url, ...admin };
}

describe('enrollment', () => {
  it('exchanges a one-time token for a permanent agent token and creates the server', async () => {
    const { t, url, cookie } = await setup();
    const e = await enrollAgent(t, url, cookie, 'heimserver');
    track(e.agent);
    expect(e.agentToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const list = await t.app.inject({
      method: 'GET',
      url: '/api/servers',
      headers: authHeaders(cookie),
    });
    const servers = list.json<{
      servers: { id: string; name: string; location: string; connected: boolean }[];
    }>().servers;
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      id: e.serverId,
      name: 'heimserver',
      location: 'home',
      connected: true,
    });
    // Reconnect with the permanent token.
    e.agent.close();
    await e.agent.closed;
    const again = track(await connectAgent(url, e.agentToken));
    expect(again.received.find((m) => m.type === 'welcome')).toMatchObject({
      serverId: e.serverId,
      protocol: PROTOCOL_VERSION,
      metricsIntervalS: 10,
      inventoryIntervalS: 60,
    });
    // Audit: token creation by admin, enrollment by system.
    const actions = t.db.sqlite.prepare('SELECT actor, action FROM audit_log').all();
    expect(actions).toEqual(
      expect.arrayContaining([
        { actor: 'admin', action: 'server.enroll_token_created' },
        { actor: 'system', action: 'server.enrolled' },
      ]),
    );
  });

  it('takes the name from the enrollment, not from the hello', async () => {
    const { t, url, cookie } = await setup();
    const token = await createEnrollToken(t, cookie, 'oracle-a1');
    const a = track(await WsClient.connect(`${url}/agent`));
    a.send(helloMsg(token, { name: 'something-else' }));
    const enrolled = await a.nextOfType('enrolled');
    expect(t.app.hzCore.servers.row(enrolled.serverId as string)?.name).toBe('oracle-a1');
  });

  it('an enrollment token works only once', async () => {
    const { t, url, cookie } = await setup();
    const token = await createEnrollToken(t, cookie);
    const a = track(await WsClient.connect(`${url}/agent`));
    a.send(helloMsg(token));
    await a.nextOfType('welcome');
    const b = track(await WsClient.connect(`${url}/agent`));
    b.send(helloMsg(token));
    expect(await b.nextOfType('reject')).toEqual({ type: 'reject', code: 'bad_token' });
    expect((await b.closed).code).toBe(AGENT_CLOSE.REJECTED);
  });

  it('rejects an expired enrollment token (15 min)', async () => {
    const { t, url, cookie } = await setup();
    const token = await createEnrollToken(t, cookie);
    t.clock.advance(ENROLL_TTL_MS);
    const a = track(await WsClient.connect(`${url}/agent`));
    a.send(helloMsg(token));
    expect(await a.nextOfType('reject')).toEqual({ type: 'reject', code: 'bad_token' });
    await a.closed;
    expect(t.app.hzCore.servers.list()).toHaveLength(0);
  });

  it('a new enrollment for the same name invalidates the older token', async () => {
    const { t, url, cookie } = await setup();
    const first = await createEnrollToken(t, cookie);
    await createEnrollToken(t, cookie);
    const a = track(await WsClient.connect(`${url}/agent`));
    a.send(helloMsg(first));
    expect(await a.nextOfType('reject')).toEqual({ type: 'reject', code: 'bad_token' });
  });

  it('refuses an enrollment for a name that exists (409) and name_taken on hello', async () => {
    const { t, url, cookie } = await setup();
    const t1 = await createEnrollToken(t, cookie, 'heimserver');
    // Second token for another name, then rename collision via a direct row.
    const a = track(await WsClient.connect(`${url}/agent`));
    a.send(helloMsg(t1));
    await a.nextOfType('welcome');
    const res = await withStepUp(t, () =>
      t.app.inject({
        method: 'POST',
        url: '/api/servers/enroll',
        headers: authHeaders(cookie),
        payload: { name: 'heimserver' },
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: 'conflict' });

    // Two pending tokens for one name can race; the second enrollment must fail.
    const t2 = await createEnrollToken(t, cookie, 'pi');
    t.db.sqlite.prepare("UPDATE servers SET name = 'pi' WHERE name = 'heimserver'").run();
    const b = track(await WsClient.connect(`${url}/agent`));
    b.send(helloMsg(t2));
    expect(await b.nextOfType('reject')).toEqual({ type: 'reject', code: 'name_taken' });
  });

  it('stores only hashes of enrollment and agent tokens', async () => {
    const { t, url, cookie } = await setup();
    const token = await createEnrollToken(t, cookie);
    const a = track(await WsClient.connect(`${url}/agent`));
    a.send(helloMsg(token));
    const { agentToken } = (await a.nextOfType('enrolled')) as unknown as { agentToken: string };
    const dump = JSON.stringify([
      t.db.sqlite.prepare('SELECT * FROM enroll_tokens').all(),
      t.db.sqlite.prepare('SELECT * FROM agent_tokens').all(),
      t.db.sqlite.prepare('SELECT * FROM servers').all(),
      t.db.sqlite.prepare('SELECT * FROM audit_log').all(),
    ]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(agentToken);
  });
});

describe('re-enrollment of a revoked server', () => {
  async function revoke(t: TestApp, secret: string, cookie: string, serverId: string) {
    await stepUp(t, secret, cookie);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/revoke-agent`,
      headers: authHeaders(cookie),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  }

  it('takes over the row (same id, history kept), the old token stays invalid', async () => {
    const { t, url, cookie, secret } = await setup();
    const e = await enrollAgent(t, url, cookie, 'heimserver');
    track(e.agent);
    e.agent.send(metricsMsg());
    await until(
      () =>
        (t.db.sqlite.prepare('SELECT COUNT(*) n FROM metrics_raw').get() as { n: number }).n === 1,
    );
    await revoke(t, secret, cookie, e.serverId);
    await e.agent.closed;
    expect(t.app.hzCore.tokens.hasActiveToken(e.serverId)).toBe(false);

    const token = await createEnrollToken(t, cookie, 'heimserver');
    const a = track(await WsClient.connect(`${url}/agent`));
    a.send(helloMsg(token, { version: '0.3.0' }));
    const enrolled = await a.nextOfType('enrolled');
    await a.nextOfType('welcome');
    expect(enrolled.serverId).toBe(e.serverId);
    const newToken = enrolled.agentToken as string;
    expect(newToken).not.toBe(e.agentToken);

    // Same row, history kept, revoked state cleared.
    expect(t.app.hzCore.servers.list()).toHaveLength(1);
    expect(t.app.hzCore.servers.row(e.serverId)?.agentVersion).toBe('0.3.0');
    expect(t.db.sqlite.prepare('SELECT COUNT(*) n FROM metrics_raw').get()).toEqual({ n: 1 });
    expect(t.app.hzCore.tokens.hasActiveToken(e.serverId)).toBe(true);

    // Audit: server.reenrolled (not a second server.enrolled).
    const actions = t.db.sqlite
      .prepare("SELECT action, target FROM audit_log WHERE action LIKE 'server.%enrolled'")
      .all();
    expect(actions).toEqual([
      { action: 'server.enrolled', target: e.serverId },
      { action: 'server.reenrolled', target: e.serverId },
    ]);

    // The old (revoked) token stays invalid after the takeover.
    const old = track(await WsClient.connect(`${url}/agent`));
    old.send(helloMsg(e.agentToken));
    expect(await old.nextOfType('reject')).toEqual({ type: 'reject', code: 'revoked' });
    expect((await old.closed).code).toBe(AGENT_CLOSE.REVOKED);
    // The current connection was not replaced by the rejected one.
    expect(t.app.hzCore.hub.connectedIds()).toEqual([e.serverId]);

    // The new token works after a reconnect; only hashes are stored.
    a.close();
    await a.closed;
    track(await connectAgent(url, newToken));
    const dump = JSON.stringify(t.db.sqlite.prepare('SELECT * FROM agent_tokens').all());
    expect(dump).not.toContain(newToken);
  });

  it('a name of a server that is not revoked still fails (409, name_taken)', async () => {
    const { t, url, cookie } = await setup();
    const e = await enrollAgent(t, url, cookie, 'heimserver');
    track(e.agent);
    const res = await withStepUp(t, () =>
      t.app.inject({
        method: 'POST',
        url: '/api/servers/enroll',
        headers: authHeaders(cookie),
        payload: { name: 'heimserver' },
      }),
    );
    expect(res.statusCode).toBe(409);
  });

  it('a pending token loses the takeover when the server became active again', async () => {
    const { t, url, cookie, secret } = await setup();
    const e = await enrollAgent(t, url, cookie, 'heimserver');
    track(e.agent);
    await revoke(t, secret, cookie, e.serverId);
    await e.agent.closed;
    const first = await createEnrollToken(t, cookie, 'heimserver');
    // Simulate a race: another active token appears for the server.
    t.db.sqlite
      .prepare('UPDATE agent_tokens SET revoked_at = NULL WHERE server_id = ?')
      .run(e.serverId);
    const a = track(await WsClient.connect(`${url}/agent`));
    a.send(helloMsg(first));
    expect(await a.nextOfType('reject')).toEqual({ type: 'reject', code: 'name_taken' });
  });
});

describe('handshake', () => {
  it('rejects a wrong token', async () => {
    const { url } = await setup();
    const a = track(await WsClient.connect(`${url}/agent`));
    a.send(helloMsg('A'.repeat(43)));
    expect(await a.nextOfType('reject')).toEqual({ type: 'reject', code: 'bad_token' });
    expect((await a.closed).code).toBe(AGENT_CLOSE.REJECTED);
  });

  it('closes when the first message is not a valid hello', async () => {
    const { url } = await setup();
    for (const first of [
      JSON.stringify(metricsMsg()),
      'not json',
      JSON.stringify({ ...helloMsg('A'.repeat(43)), extra: 1 }),
      JSON.stringify(helloMsg('short')),
    ]) {
      const a = track(await WsClient.connect(`${url}/agent`));
      a.sendRaw(first);
      expect(await a.nextOfType('reject')).toEqual({ type: 'reject', code: 'invalid' });
      expect((await a.closed).code).toBe(AGENT_CLOSE.REJECTED);
    }
  });

  it('rejects another protocol version', async () => {
    const { url } = await setup();
    const a = track(await WsClient.connect(`${url}/agent`));
    a.send(helloMsg('A'.repeat(43), { protocol: PROTOCOL_VERSION + 1 }));
    expect(await a.nextOfType('reject')).toEqual({ type: 'reject', code: 'protocol' });
  });

  it('closes after the hello timeout', async () => {
    const { url } = await setup({ agentOptions: { helloTimeoutMs: 100 } });
    const a = track(await WsClient.connect(`${url}/agent`));
    expect((await a.closed).code).toBe(AGENT_CLOSE.HELLO_TIMEOUT);
  });

  it('a second connection of the same server replaces the first', async () => {
    const { t, url, cookie } = await setup();
    const e = await enrollAgent(t, url, cookie);
    track(e.agent);
    const b = track(await connectAgent(url, e.agentToken));
    expect((await e.agent.closed).code).toBe(AGENT_CLOSE.REPLACED);
    expect(t.app.hzCore.hub.isConnected(e.serverId)).toBe(true);
    b.send(metricsMsg({ cpu: 33 }));
    await until(() => t.app.hzCore.servers.summary(e.serverId)?.cpu === 33);
  });
});

describe('messages', () => {
  it('drops invalid messages and closes on a flood of them', async () => {
    const { t, url, cookie } = await setup({ agentOptions: { maxInvalid: 5 } });
    const { agent, serverId } = await enrollAgent(t, url, cookie);
    track(agent);
    agent.send({ ...metricsMsg(), cpu: 500 });
    agent.send({ type: 'exec', cmd: 'rm -rf /' });
    agent.sendRaw(Buffer.from([1, 2, 3]));
    agent.send(metricsMsg({ cpu: 7 }));
    await until(() => t.app.hzCore.servers.summary(serverId)?.cpu === 7);
    expect(agent.closeInfo).toBeNull();
    for (let i = 0; i < 4; i++) agent.sendRaw('{');
    expect((await agent.closed).code).toBe(AGENT_CLOSE.POLICY);
  });

  it('closes on an oversized frame (maxPayload)', async () => {
    const { t, url, cookie } = await setup();
    const { agent } = await enrollAgent(t, url, cookie);
    track(agent);
    agent.sendRaw('x'.repeat(MAX_MESSAGE_BYTES + 1));
    expect((await agent.closed).code).toBe(1009);
  });

  it('closes on a flood of valid messages', async () => {
    const { t, url, cookie } = await setup({ agentOptions: { maxMessages: 20 } });
    const { agent } = await enrollAgent(t, url, cookie);
    track(agent);
    for (let i = 0; i < 25; i++) agent.send({ type: 'ping', ts: new Date().toISOString() });
    expect((await agent.closed).code).toBe(AGENT_CLOSE.POLICY);
  });

  it('answers ping with pong', async () => {
    const { t, url, cookie } = await setup();
    const { agent } = await enrollAgent(t, url, cookie);
    track(agent);
    agent.send({ type: 'ping', ts: new Date().toISOString() });
    expect((await agent.nextOfType('pong')).type).toBe('pong');
  });
});

describe('revocation', () => {
  it('revoking the token disconnects at once and the token stops working', async () => {
    const { t, url, cookie, secret } = await setup();
    const e = await enrollAgent(t, url, cookie);
    track(e.agent);
    await stepUp(t, secret, cookie);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/servers/${e.serverId}/revoke-agent`,
      headers: authHeaders(cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(await e.agent.nextOfType('reject')).toEqual({ type: 'reject', code: 'revoked' });
    expect((await e.agent.closed).code).toBe(AGENT_CLOSE.REVOKED);
    expect(t.app.hzCore.hub.isConnected(e.serverId)).toBe(false);

    const again = track(await WsClient.connect(`${url}/agent`));
    again.send(helloMsg(e.agentToken));
    expect(await again.nextOfType('reject')).toEqual({ type: 'reject', code: 'revoked' });
    expect((await again.closed).code).toBe(AGENT_CLOSE.REVOKED);
    const audit = t.db.sqlite
      .prepare("SELECT target FROM audit_log WHERE action = 'server.agent_revoked'")
      .all();
    expect(audit).toEqual([{ target: e.serverId }]);
  });

  it('ignores frames that arrive after delete or revoke (no crash, no data)', async () => {
    const { t, url, cookie, secret } = await setup();
    const a = await enrollAgent(t, url, cookie, 'heimserver');
    const b = await enrollAgent(t, url, cookie, 'oracle-a1');
    track(a.agent);
    track(b.agent);
    await stepUp(t, secret, cookie);
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/servers/${a.serverId}`,
      headers: authHeaders(cookie),
    });
    expect(del.statusCode).toBe(200);
    const rev = await t.app.inject({
      method: 'POST',
      url: `/api/servers/${b.serverId}/revoke-agent`,
      headers: authHeaders(cookie),
    });
    expect(rev.statusCode).toBe(200);
    // Both agents keep talking until their sockets are gone.
    for (let i = 0; i < 5; i++) {
      if (a.agent.ws.readyState === a.agent.ws.OPEN) a.agent.send(metricsMsg());
      if (b.agent.ws.readyState === b.agent.ws.OPEN) b.agent.send(metricsMsg());
    }
    await Promise.all([a.agent.closed, b.agent.closed]);
    await new Promise((r) => setTimeout(r, 50));
    const rows = t.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM metrics_raw WHERE server_id IN (?, ?)')
      .get(a.serverId, b.serverId) as { n: number };
    expect(rows.n).toBe(0);
    expect(t.app.hzCore.hub.isConnected(a.serverId)).toBe(false);
    expect(t.app.hzCore.hub.isConnected(b.serverId)).toBe(false);
  });

  it('revoke-agent and delete need step-up', async () => {
    const { t, url, cookie } = await setup();
    const e = await enrollAgent(t, url, cookie);
    track(e.agent);
    for (const [method, path] of [
      ['POST', `/api/servers/${e.serverId}/revoke-agent`],
      ['DELETE', `/api/servers/${e.serverId}`],
    ] as const) {
      const res = await t.app.inject({ method, url: path, headers: authHeaders(cookie) });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    }
    expect(t.app.hzCore.hub.isConnected(e.serverId)).toBe(true);
  });
});

describe('RPC', () => {
  it('validates action and params before anything is sent', async () => {
    const { t, url, cookie } = await setup();
    const { agent, serverId } = await enrollAgent(t, url, cookie);
    track(agent);
    const hub = t.app.hzCore.hub;
    const before = agent.received.length;
    const bad: [string, unknown][] = [
      ['system.exec', { cmd: 'id' }],
      ['__proto__', {}],
      ['compose.up', { dir: '/etc' }],
      ['compose.up', { dir: '/opt/homelab/../etc' }],
      ['system.reboot', { confirmName: 'Heimserver; reboot' }],
      ['container.stop', { id: 'x', extra: true }],
    ];
    for (const [action, params] of bad) {
      // @ts-expect-error runtime check against untyped callers
      await expect(hub.call(serverId, action, params)).rejects.toBeInstanceOf(RpcError);
    }
    await expect(
      // @ts-expect-error runtime check
      hub.call(serverId, 'system.exec', {}),
    ).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(hub.call(serverId, 'compose.up', { dir: '/etc' })).rejects.toMatchObject({
      code: 'invalid_params',
    });
    // Terminal actions need allowTerminal in the core and the agent capability.
    expect(() => hub.stream(serverId, 'pty.open', { cols: 80, rows: 24 })).toThrow(RpcError);
    await new Promise((r) => setTimeout(r, 50));
    expect(agent.received.slice(before).filter((m) => m.type === 'rpc')).toEqual([]);
  });

  it('sends valid RPCs, resolves results, rejects agent errors and timeouts', async () => {
    const { t, url, cookie } = await setup();
    const { agent, serverId } = await enrollAgent(t, url, cookie);
    track(agent);
    const hub = t.app.hzCore.hub;

    const p = hub.call(serverId, 'container.restart', { id: 'homeassistant' });
    const rpc = await agent.nextOfType('rpc');
    expect(rpc).toMatchObject({ action: 'container.restart', params: { id: 'homeassistant' } });
    agent.send({ type: 'rpc.result', id: rpc.id, ok: true, data: { done: true } });
    await expect(p).resolves.toEqual({ done: true });

    const p2 = hub.call(serverId, 'compose.up', { dir: '/opt/homelab/x' });
    const rpc2 = await agent.nextOfType('rpc');
    agent.send({
      type: 'rpc.result',
      id: rpc2.id,
      ok: false,
      error: { code: 'bad_path', message: 'no such dir' },
    });
    await expect(p2).rejects.toMatchObject({ code: 'bad_path' });

    await expect(
      hub.call(serverId, 'system.cleanupPreview', {}, { timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('streams data and end, and fails pending calls on disconnect', async () => {
    const { t, url, cookie } = await setup();
    const { agent, serverId } = await enrollAgent(t, url, cookie);
    track(agent);
    const hub = t.app.hzCore.hub;
    const s = hub.stream(serverId, 'container.logs', { id: 'homeassistant', tail: 10 });
    const rpc = await agent.nextOfType('rpc');
    expect(rpc).toMatchObject({
      id: s.id,
      params: { id: 'homeassistant', tail: 10, follow: false },
    });
    agent.send({ type: 'stream.data', streamId: s.id, channel: 'stdout', chunk: 'line 1\n' });
    agent.send({ type: 'stream.data', streamId: s.id, chunk: 'line 2\n' });
    agent.send({ type: 'stream.end', streamId: s.id, code: 0 });
    const chunks: string[] = [];
    for await (const c of s) chunks.push(c.chunk);
    expect(chunks).toEqual(['line 1\n', 'line 2\n']);
    await expect(s.done).resolves.toEqual({ code: 0 });

    const pending = hub.call(serverId, 'system.cleanup', {});
    const s2 = hub.stream(serverId, 'container.logs', { id: 'x', follow: true });
    await agent.nextOfType('rpc');
    agent.close();
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
    await expect(s2.done).resolves.toEqual({ code: -1, error: 'disconnected' });
    await expect(hub.call(serverId, 'system.cleanup', {})).rejects.toMatchObject({
      code: 'offline',
    });
  });
});

describe('secrets', () => {
  it('never returns or logs agent or enrollment tokens', async () => {
    t = await makeApp({ captureLogs: true });
    const { cookie } = await completeSetup(t);
    const url = await listen(t);
    const app = t;
    const enroll = await withStepUp(app, () =>
      app.app.inject({
        method: 'POST',
        url: '/api/servers/enroll',
        headers: authHeaders(cookie),
        payload: { name: 'heimserver' },
      }),
    );
    expect(enroll.statusCode).toBe(200);
    const token = enroll.json<{ token: string }>().token;
    const a = track(await WsClient.connect(`${url}/agent`));
    a.send(helloMsg(token));
    const { agentToken, serverId } = (await a.nextOfType('enrolled')) as unknown as {
      agentToken: string;
      serverId: string;
    };
    a.send(metricsMsg());
    await until(() => t?.app.hzCore.servers.summary(serverId)?.cpu !== null);
    const bodies: string[] = [];
    for (const path of [
      '/api/servers',
      `/api/servers/${serverId}`,
      `/api/servers/${serverId}/history`,
      '/api/alerts',
    ]) {
      const res = await t.app.inject({ method: 'GET', url: path, headers: authHeaders(cookie) });
      expect(res.statusCode).toBe(200);
      bodies.push(res.body);
    }
    // A failed reconnect with a wrong token is logged without the token.
    const b = track(await WsClient.connect(`${url}/agent`));
    b.send(helloMsg(`${agentToken.slice(0, -2)}xx`));
    await b.closed;
    const all = bodies.join('\n') + t.logs.join('\n');
    expect(all).not.toContain(agentToken);
    expect(all).not.toContain(token);
    expect(all).not.toContain(agentToken.slice(0, -2));
    expect(t.logs.join('')).toContain('agent connected');
  });
});

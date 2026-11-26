import { afterEach, describe, expect, it } from 'vitest';
import { LIVE_CLOSE_SESSION_ENDED, liveServerMessageSchema, serverSummarySchema } from '@hz/shared';
import { enrollAgent, listen, metricsMsg, until, WsClient } from './agent-helpers.js';
import {
  authHeaders,
  completeSetup,
  login,
  makeApp,
  sessionCookie,
  totpCode,
  type TestApp,
} from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup() {
  t = await makeApp({ liveOptions: { throttleMs: 20 } });
  const admin = await completeSetup(t);
  const url = await listen(t);
  const origin = url.replace('ws://', 'http://');
  const browser = (cookie: string, o = origin) => ({ cookie: `hz_session=${cookie}`, origin: o });
  return { t, url, origin, browser, ...admin };
}

async function openLive(url: string, headers: Record<string, string>): Promise<WsClient> {
  const c = await WsClient.connect(`${url}/live`, headers);
  clients.push(c);
  return c;
}

describe('/live upgrade', () => {
  it('401 without a session, 401 with a forged cookie', async () => {
    const { url, origin } = await setup();
    expect(await WsClient.status(`${url}/live`, { origin })).toBe(401);
    expect(
      await WsClient.status(`${url}/live`, { origin, cookie: `hz_session=${'A'.repeat(43)}` }),
    ).toBe(401);
  });

  it('403 with a foreign or missing Origin', async () => {
    const { url, cookie, browser } = await setup();
    expect(await WsClient.status(`${url}/live`, browser(cookie, 'https://evil.example'))).toBe(403);
    expect(await WsClient.status(`${url}/live`, browser(cookie, 'null'))).toBe(403);
    expect(await WsClient.status(`${url}/live`, { cookie: `hz_session=${cookie}` })).toBe(403);
  });

  it('101 with session and same Origin', async () => {
    const { url, cookie, browser } = await setup();
    expect(await WsClient.status(`${url}/live`, browser(cookie))).toBe(101);
  });
});

describe('/live topics', () => {
  it('sends a snapshot on subscribe and throttled updates afterwards', async () => {
    const { t, url, cookie, browser } = await setup();
    const live = await openLive(url, browser(cookie));
    live.send({ type: 'subscribe', topics: ['servers', 'alerts'] });
    const snap = await live.nextOfType('snapshot');
    expect(snap).toEqual({ type: 'snapshot', topic: 'servers', data: [] });
    expect(await live.nextOfType('snapshot')).toEqual({
      type: 'snapshot',
      topic: 'alerts',
      data: [],
    });

    const e = await enrollAgent(t, url, cookie);
    clients.push(e.agent);
    const up = await live.next((m) => m.type === 'update' && m.topic === 'servers');
    liveServerMessageSchema.parse(up);
    const item = serverSummarySchema.parse((up.upsert as unknown[])[0]);
    expect(item).toMatchObject({ id: e.serverId, name: 'heimserver', connected: true });

    // A burst of metrics becomes few updates (throttled), the last one has the newest value.
    for (let i = 1; i <= 20; i++) e.agent.send(metricsMsg({ cpu: i }));
    await until(() => t.app.hzCore.servers.summary(e.serverId)?.cpu === 20);
    const last = await live.next(
      (m) =>
        m.type === 'update' &&
        m.topic === 'servers' &&
        (m.upsert as { cpu: number }[] | undefined)?.[0]?.cpu === 20,
    );
    expect(last).toBeTruthy();
    const updates = live.received.filter((m) => m.type === 'update' && m.topic === 'servers');
    expect(updates.length).toBeLessThan(15);

    // Disk crit -> alert update.
    e.agent.send(metricsMsg({ diskPct: 99 }));
    const alertUp = await live.next((m) => m.type === 'update' && m.topic === 'alerts');
    expect((alertUp.upsert as { level: string; title: string }[])[0]).toMatchObject({
      level: 'crit',
      title: 'Disk / auf heimserver bei 99 %',
    });
  });

  it('server:<id> gets the detail as snapshot and a remove on delete', async () => {
    const { t, url, cookie, browser } = await setup();
    const e = await enrollAgent(t, url, cookie);
    clients.push(e.agent);
    const live = await openLive(url, browser(cookie));
    live.send({ type: 'subscribe', topics: [`server:${e.serverId}`] });
    const snap = await live.nextOfType('snapshot');
    expect((snap.data as { server: { id: string } }).server.id).toBe(e.serverId);

    e.agent.send(metricsMsg({ cpu: 55 }));
    const up = await live.next((m) => m.type === 'update');
    expect((up.upsert as { server: { cpu: number } }[])[0]?.server.cpu).toBe(55);

    t.app.hzCore.servers.delete(e.serverId);
    const rm = await live.next((m) => m.type === 'update' && Array.isArray(m.remove));
    expect(rm).toEqual({ type: 'update', topic: `server:${e.serverId}`, remove: [e.serverId] });
  });

  it('unknown topics and invalid messages get an error, a flood closes', async () => {
    const { url, cookie, browser } = await setup();
    const live = await openLive(url, browser(cookie));
    live.send({ type: 'subscribe', topics: ['server:AAAAAAAAAAAAAAAAAAAAAA'] });
    expect(await live.nextOfType('error')).toEqual({ type: 'error', code: 'unknown_topic' });
    live.send({ type: 'subscribe', topics: ['deploy:AAAAAAAAAAAAAAAAAAAAAA'] });
    expect(await live.nextOfType('error')).toEqual({ type: 'error', code: 'unknown_topic' });
    live.send({ type: 'subscribe', topics: ['container-logs:AAAAAAAAAAAAAAAAAAAAAA'] });
    expect(await live.nextOfType('error')).toEqual({ type: 'error', code: 'unknown_topic' });
    live.send({ type: 'subscribe', topics: ['../etc'] });
    expect(await live.nextOfType('error')).toEqual({ type: 'error', code: 'invalid' });
    live.sendRaw('x'.repeat(20_000));
    expect(await live.nextOfType('error')).toEqual({ type: 'error', code: 'invalid' });
    live.send({ type: 'ping' });
    expect(await live.nextOfType('pong')).toEqual({ type: 'pong' });
    for (let i = 0; i < 25; i++) live.sendRaw('{');
    expect((await live.closed).code).toBe(1008);
  });

  it('closes the socket when the session is revoked (logout)', async () => {
    const { t, url, cookie, secret, browser } = await setup();
    // A second session that stays alive.
    t.clock.advance(30_000);
    const other = sessionCookie(await login(t, totpCode(secret, t.clock.t)));
    const a = await openLive(url, browser(cookie));
    const b = await openLive(url, browser(other));
    await until(() => t.app.hzCore.live.size === 2);
    const out = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: authHeaders(cookie),
    });
    expect(out.statusCode).toBe(200);
    t.clock.advance(5_000);
    await t.app.hzCore.scheduler.tick();
    expect((await a.closed).code).toBe(LIVE_CLOSE_SESSION_ENDED);
    expect(b.closeInfo).toBeNull();
    expect(t.app.hzCore.live.size).toBe(1);
  });
});

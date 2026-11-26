import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkResponseSchema, pushPayloadSchema } from '@hz/shared';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';
import { makeDevice, MockPushService } from './push-helpers.js';

let t: TestApp | undefined;
let mock: MockPushService | undefined;
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  await t?.app.close();
  t = undefined;
  await mock?.stop();
  mock = undefined;
});

function listenOn(port: number): Promise<http.Server> {
  const s = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  servers.push(s);
  return new Promise((resolve) => s.listen(port, '127.0.0.1', () => resolve(s)));
}

/** A port that was just free (closed again, so connecting is refused). */
async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

describe('M4 acceptance: unreachable URL -> crit + push, recovery -> OK + resolved', () => {
  it('raises crit after 2 intervals with one push, then OK push and the old alert resolved', async () => {
    mock = new MockPushService();
    await mock.start();
    t = await makeApp({ pushTransport: mock.transport });
    const admin = await completeSetup(t);
    const core = t.app.hzCore;
    const step = async (): Promise<void> => {
      await core.scheduler.tick();
      await core.checks.idle();
      await core.push.idle();
    };

    const device = makeDevice('/phone');
    const sub = await t.app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      headers: authHeaders(admin.cookie),
      payload: { subscription: device.subscription, label: 'Handy' },
    });
    expect(sub.statusCode).toBe(200);

    const port = await closedPort();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/checks',
      headers: authHeaders(admin.cookie),
      payload: { kind: 'http', name: 'shop', url: `http://127.0.0.1:${port}/health` },
    });
    expect(created.statusCode).toBe(200);
    const id = checkResponseSchema.parse(created.json()).check.id;

    // Interval 1: first failure -> warn in the UI, no alert, no push.
    await step();
    expect(core.checks.summary(id)).toMatchObject({ status: 'warn', consecutiveFailures: 1 });
    expect(core.alerts.active(`check:${id}:down`)).toBeNull();
    expect(mock.hits).toHaveLength(0);

    // Interval 2: second failure -> crit alert and exactly one push.
    t.clock.advance(60_000);
    await step();
    const summary = core.checks.summary(id);
    expect(summary).toMatchObject({ status: 'crit', reason: 'Verbindung abgelehnt' });
    const down = core.alerts.active(`check:${id}:down`);
    expect(down).toMatchObject({
      level: 'crit',
      state: 'open',
      title: 'shop ist nicht erreichbar',
      source: 'check',
    });
    expect(down?.body).toContain('Verbindung abgelehnt');
    expect(mock.hits).toHaveLength(1);
    const hit = mock.hits[0];
    if (!hit) throw new Error('no push');
    expect(hit.path).toBe('/phone');
    expect(hit.headers['content-encoding']).toBe('aes128gcm');
    expect(hit.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(hit.headers.urgency).toBe('high');
    const payload = pushPayloadSchema.parse(device.decrypt(hit.body));
    expect(payload).toMatchObject({
      level: 'crit',
      title: 'shop ist nicht erreichbar',
      tag: `check:${id}:down`,
    });

    // A third failure does not push again (same alert).
    t.clock.advance(60_000);
    await step();
    expect(mock.hits).toHaveLength(1);

    // Recovery: the service is back on the same port.
    await listenOn(port);
    t.clock.advance(60_000);
    await step();
    expect(core.checks.summary(id)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    expect(core.alerts.get(down?.id ?? '')).toMatchObject({ state: 'resolved' });
    expect(core.alerts.active(`check:${id}:down`)).toBeNull();
    const ok = core.alerts
      .list({ state: 'all', limit: 10, source: 'check' })
      .find((a) => a.level === 'ok');
    expect(ok).toMatchObject({ title: 'shop ist wieder erreichbar', state: 'resolved' });
    expect(mock.hits).toHaveLength(2);
    const okPayload = pushPayloadSchema.parse(
      device.decrypt(mock.hits[1]?.body ?? Buffer.alloc(0)),
    );
    expect(okPayload).toMatchObject({ level: 'ok', title: 'shop ist wieder erreichbar' });

    // History has all four results, uptime reflects one success out of four.
    const hist = await t.app.inject({
      url: `/api/checks/${id}/history?range=24h`,
      headers: authHeaders(admin.cookie),
    });
    expect(hist.json<{ points: { ok: boolean }[] }>().points.map((p) => p.ok)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(core.checks.summary(id)?.uptime24h).toBe(25);
  });

  it('crit pushes also during quiet hours, the OK of a crit too', async () => {
    mock = new MockPushService();
    await mock.start();
    t = await makeApp({ pushTransport: mock.transport });
    const admin = await completeSetup(t);
    const core = t.app.hzCore;
    // 23:30 Vienna (22:30 UTC in November).
    t.clock.t = Date.UTC(2026, 10, 25, 22, 30, 0);
    const device = makeDevice('/night');
    await t.app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      headers: authHeaders(admin.cookie),
      payload: { subscription: device.subscription },
    });
    const port = await closedPort();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/checks',
      headers: authHeaders(admin.cookie),
      payload: { kind: 'tcp', name: 'minecraft', host: '127.0.0.1', port },
    });
    const id = checkResponseSchema.parse(res.json()).check.id;
    const step = async (): Promise<void> => {
      await core.scheduler.tick();
      await core.checks.idle();
      await core.push.idle();
    };
    await step();
    t.clock.advance(60_000);
    await step();
    expect(core.alerts.active(`check:${id}:down`)?.level).toBe('crit');
    expect(mock.hits).toHaveLength(1);
    await listenOn(port);
    t.clock.advance(60_000);
    await step();
    expect(mock.hits).toHaveLength(2);
    expect(device.decrypt(mock.hits[1]?.body ?? Buffer.alloc(0))).toMatchObject({ level: 'ok' });
  });
});

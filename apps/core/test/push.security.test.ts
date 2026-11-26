import { afterEach, describe, expect, it } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { readSetting } from '../src/db/settings.js';
import { pushSubscriptions, settings } from '../src/db/schema.js';
import { VAPID_SETTING } from '../src/push/vapid.js';
import { authHeaders, completeSetup, HOST, makeApp, type TestApp } from './helpers.js';
import { makeDevice, MockPushService } from './push-helpers.js';

let t: TestApp | undefined;
let mock: MockPushService | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
  await mock?.stop();
  mock = undefined;
});

const ROUTES = [
  ['GET', '/api/push/vapid'],
  ['GET', '/api/push/subscriptions'],
  ['POST', '/api/push/subscriptions'],
  ['DELETE', '/api/push/subscriptions/:id'],
  ['POST', '/api/push/test'],
  ['GET', '/api/settings/notify'],
  ['PATCH', '/api/settings/notify'],
] as const;

async function setup(env: Record<string, string> = {}) {
  mock = new MockPushService();
  await mock.start();
  t = await makeApp({ pushTransport: mock.transport, captureLogs: true, env });
  const a = await completeSetup(t);
  return { t, mock, cookie: a.cookie, headers: authHeaders(a.cookie) };
}

function payloadFor(method: string, url: string): object | undefined {
  if (url === '/api/push/subscriptions' && method === 'POST') {
    return { subscription: makeDevice('/p').subscription };
  }
  if (method === 'PATCH') return { quietStart: '22:00' };
  return undefined;
}

describe('push routes: auth', () => {
  it('are registered and not public', async () => {
    t = await makeApp();
    const routes = t.app.hzRoutes.map((r) => `${r.method} ${r.url}`);
    for (const [method, url] of ROUTES) {
      expect(routes).toContain(`${method} ${url}`);
      expect(PUBLIC_API_ROUTES).not.toContain(url);
    }
  });

  it('401 without a session or with a forged cookie; nothing is sent or stored', async () => {
    const { t, mock } = await setup();
    for (const cookie of [undefined, `hz_session=${'A'.repeat(43)}`]) {
      const headers = { host: HOST, origin: `https://${HOST}`, ...(cookie ? { cookie } : {}) };
      for (const [method, url] of ROUTES) {
        const payload = payloadFor(method, url);
        const res = await t.app.inject({
          method,
          url: url.replace(':id', 'abcdefghijkl'),
          headers,
          ...(payload ? { payload } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
        expect(res.json()).toEqual({ ok: false, error: 'unauthorized' });
      }
    }
    expect(t.db.db.select().from(pushSubscriptions).all()).toEqual([]);
    expect(mock.hits).toEqual([]);
  });

  it('403 bad_origin for every mutation from a foreign or missing Origin', async () => {
    const { t, mock, cookie } = await setup();
    for (const headers of [
      { host: HOST, cookie: `hz_session=${cookie}`, origin: 'https://evil.example' },
      { host: HOST, cookie: `hz_session=${cookie}` },
    ]) {
      for (const [method, url] of ROUTES.filter(([m]) => m !== 'GET')) {
        const payload = payloadFor(method, url);
        const res = await t.app.inject({
          method,
          url: url.replace(':id', 'abcdefghijkl'),
          headers,
          ...(payload ? { payload } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json()).toEqual({ ok: false, error: 'bad_origin' });
      }
    }
    expect(t.db.db.select().from(pushSubscriptions).all()).toEqual([]);
    expect(readSetting(t.db.db, 'notify')).toBeUndefined();
    expect(mock.hits).toEqual([]);
  });
});

describe('push subscriptions: strict input', () => {
  it('the endpoint must be https; the schema is strict', async () => {
    const { t, headers } = await setup();
    const d = makeDevice('/x');
    const sub = d.subscription;
    const bad: unknown[] = [
      { subscription: { ...sub, endpoint: 'http://push.test/x' } },
      { subscription: { ...sub, endpoint: 'ftp://push.test/x' } },
      { subscription: { ...sub, endpoint: 'javascript:alert(1)' } },
      { subscription: { ...sub, endpoint: 'file:///etc/passwd' } },
      { subscription: { ...sub, endpoint: `https://push.test/${'a'.repeat(2100)}` } },
      { subscription: { ...sub, extra: true } },
      { subscription: { ...sub, keys: { ...sub.keys, extra: 'x' } } },
      { subscription: { ...sub, keys: { p256dh: sub.keys.p256dh } } },
      { subscription: { ...sub, keys: { ...sub.keys, auth: 'bad auth!' } } },
      { subscription: sub, label: 'x'.repeat(61) },
      { subscription: sub, other: 1 },
      {},
    ];
    for (const payload of bad) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/push/subscriptions',
        headers,
        payload: payload as object,
      });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(t.db.db.select().from(pushSubscriptions).all()).toEqual([]);
  });

  it('bad device ids are 400', async () => {
    const { t, headers } = await setup();
    for (const bad of ['a', 'x'.repeat(65), '..%2Fx%2Fyyyyyy', 'abc$defgh1']) {
      const res = await t.app.inject({
        method: 'DELETE',
        url: `/api/push/subscriptions/${bad}`,
        headers,
      });
      expect(res.statusCode, bad).toBe(400);
    }
  });
});

describe('VAPID private key and push endpoints stay secret', () => {
  async function exercise(t: TestApp, headers: Record<string, string>): Promise<string[]> {
    const bodies: string[] = [];
    const d = makeDevice('/secret-endpoint-path-123');
    for (const [method, url, payload] of [
      ['POST', '/api/push/subscriptions', { subscription: d.subscription, label: 'Handy' }],
      ['GET', '/api/push/vapid', undefined],
      ['GET', '/api/push/subscriptions', undefined],
      ['POST', '/api/push/test', undefined],
      ['GET', '/api/settings/notify', undefined],
      ['PATCH', '/api/settings/notify', { warnBundleMinutes: 45 }],
      ['GET', '/api/alerts?state=all', undefined],
      ['GET', '/api/health', undefined],
    ] as const) {
      const res = await t.app.inject({
        method,
        url,
        headers,
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, url).toBe(200);
      bodies.push(res.body, JSON.stringify(res.headers));
    }
    // An alert that triggers a push.
    t.app.hzCore.alerts.raise('test:crit', 'crit', 'x ist offline', 'y', null, 'system');
    await t.app.hzCore.push.idle();
    return bodies;
  }

  it('generated key: never in a response or a log, stored only encrypted', async () => {
    const { t, headers, mock } = await setup();
    const stored = readSetting(t.db.db, VAPID_SETTING) as { privateKeyEnc: string };
    const { privateKey } = (
      t.app.hzCore.push as unknown as { deps: { vapid: { privateKey: string } } }
    ).deps.vapid;
    expect(privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const bodies = await exercise(t, headers);
    expect(mock.hits.length).toBeGreaterThanOrEqual(2);
    for (const b of bodies) expect(b).not.toContain(privateKey);
    const logs = t.logs.join('');
    expect(logs).not.toContain(privateKey);
    // Only the host of an endpoint is logged, never the path (a capability URL).
    expect(logs).toContain('push.test');
    expect(logs).not.toContain('secret-endpoint-path-123');
    expect(JSON.stringify(t.db.db.select().from(settings).all())).not.toContain(privateKey);
    expect(stored.privateKeyEnc).not.toContain(privateKey);
    // The push itself carries the public key only.
    for (const h of mock.hits) expect(JSON.stringify(h.headers)).not.toContain(privateKey);
  });

  it('key from the environment: never in a response or a log', async () => {
    const keys = generateVAPIDKeys();
    const { t, headers } = await setup({
      HZ_VAPID_PUBLIC: keys.publicKey,
      HZ_VAPID_PRIVATE: keys.privateKey,
    });
    const bodies = await exercise(t, headers);
    expect(bodies.some((b) => b.includes(keys.publicKey))).toBe(true);
    for (const b of bodies) expect(b).not.toContain(keys.privateKey);
    expect(t.logs.join('')).not.toContain(keys.privateKey);
  });

  it('a push failure does not log the endpoint or the error message', async () => {
    t = await makeApp({
      captureLogs: true,
      pushTransport: {
        send: (req) => Promise.reject(new Error(`connect failed for ${req.endpoint}`)),
      },
    });
    const a = await completeSetup(t);
    const d = makeDevice('/leaky-path-777');
    await t.app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      headers: authHeaders(a.cookie),
      payload: { subscription: d.subscription },
    });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/push/test',
      headers: authHeaders(a.cookie),
    });
    expect(res.json()).toEqual({ ok: true, sent: 0 });
    expect(t.logs.join('')).toContain('push failed');
    expect(t.logs.join('')).not.toContain('leaky-path-777');
  });
});

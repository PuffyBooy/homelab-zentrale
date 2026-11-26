import { afterEach, describe, expect, it } from 'vitest';
import { wallStateSchema, type ServerSummary } from '@hz/shared';
import { DEVICE_API_ROUTES, PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { fromVienna } from '../src/calendar.js';
import { isNight, maskAddresses, wallSentence } from '../src/wall/service.js';
import {
  WsClient,
  enrollAgent,
  inventoryMsg,
  listen,
  metricsMsg,
  stepUp,
  until,
} from './agent-helpers.js';
import { SAME_ORIGIN, authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.app.close();
  t = undefined;
});

interface Env {
  t: TestApp;
  cookie: string;
  secret: string;
}

async function setup(opts: { captureLogs?: boolean } = {}): Promise<Env> {
  t = await makeApp({ env: { HZ_BASE_URL: 'https://hz.test' }, ...opts });
  const { cookie, secret } = await completeSetup(t);
  return { t, cookie, secret };
}

async function createDevice(
  e: Env,
  name = 'Tablet Flur',
): Promise<{ id: string; token: string; url: string }> {
  await stepUp(e.t, e.secret, e.cookie);
  const res = await e.t.app.inject({
    method: 'POST',
    url: '/api/settings/wall-devices',
    headers: authHeaders(e.cookie),
    payload: { name },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json<{ device: { id: string }; url: string }>();
  const token = new URL(body.url).searchParams.get('t') ?? '';
  return { id: body.device.id, token, url: body.url };
}

function wallCookie(token: string): Record<string, string> {
  return { ...SAME_ORIGIN, cookie: `hz_wall=${token}` };
}

function getState(e: Env, headers: Record<string, string>) {
  return e.t.app.inject({ method: 'GET', url: '/api/wall/state', headers });
}

describe('wall devices (admin)', () => {
  it('create needs a session and step-up; invalid names are 400', async () => {
    const e = await setup();
    const anon = await e.t.app.inject({
      method: 'POST',
      url: '/api/settings/wall-devices',
      headers: SAME_ORIGIN,
      payload: { name: 'x' },
    });
    expect(anon.statusCode).toBe(401);
    e.t.clock.advance(16 * 60_000);
    const noStepUp = await e.t.app.inject({
      method: 'POST',
      url: '/api/settings/wall-devices',
      headers: authHeaders(e.cookie),
      payload: { name: 'Tablet' },
    });
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json()).toMatchObject({ error: 'step_up_required' });
    await stepUp(e.t, e.secret, e.cookie);
    for (const name of ['', ' ', 'x'.repeat(41), '<script>', 'a/b']) {
      const res = await e.t.app.inject({
        method: 'POST',
        url: '/api/settings/wall-devices',
        headers: authHeaders(e.cookie),
        payload: { name },
      });
      expect(res.statusCode, name).toBe(400);
    }
    expect(e.t.db.sqlite.prepare('SELECT COUNT(*) n FROM wall_devices').get()).toEqual({ n: 0 });
  });

  it('shows the token once (in the URL), stores only its hash', async () => {
    const e = await setup();
    const d = await createDevice(e);
    expect(d.url).toBe(`https://hz.test/wall?t=${d.token}`);
    expect(d.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const list = await e.t.app.inject({
      method: 'GET',
      url: '/api/settings/wall-devices',
      headers: authHeaders(e.cookie),
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(d.token);
    expect(list.json()).toEqual({
      devices: [{ id: d.id, name: 'Tablet Flur', createdAt: expect.any(String), lastSeenAt: null }],
    });
    const row = e.t.db.sqlite.prepare('SELECT * FROM wall_devices').get() as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(row)).not.toContain(d.token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const audit = e.t.db.sqlite.prepare('SELECT * FROM audit_log').all();
    expect(JSON.stringify(audit)).not.toContain(d.token);
  });

  it('delete revokes at once; unknown id 404, bad id 400, no session 401', async () => {
    const e = await setup();
    const d = await createDevice(e);
    expect((await getState(e, wallCookie(d.token))).statusCode).toBe(200);
    const del = await e.t.app.inject({
      method: 'DELETE',
      url: `/api/settings/wall-devices/${d.id}`,
      headers: authHeaders(e.cookie),
    });
    expect(del.statusCode).toBe(200);
    expect((await getState(e, wallCookie(d.token))).statusCode).toBe(401);
    const again = await e.t.app.inject({
      method: 'DELETE',
      url: `/api/settings/wall-devices/${d.id}`,
      headers: authHeaders(e.cookie),
    });
    expect(again.statusCode).toBe(404);
    const bad = await e.t.app.inject({
      method: 'DELETE',
      url: '/api/settings/wall-devices/a.b',
      headers: authHeaders(e.cookie),
    });
    expect(bad.statusCode).toBe(400);
    const anon = await e.t.app.inject({
      method: 'DELETE',
      url: `/api/settings/wall-devices/${d.id}`,
      headers: SAME_ORIGIN,
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe('POST /api/wall/session', () => {
  it('swaps the token for a strict httpOnly cookie on /api/wall', async () => {
    const e = await setup();
    const d = await createDevice(e);
    const res = await e.t.app.inject({
      method: 'POST',
      url: '/api/wall/session',
      headers: SAME_ORIGIN,
      payload: { token: d.token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const c = res.cookies.find((x) => x.name === 'hz_wall');
    expect(c).toMatchObject({
      value: d.token,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/api/wall',
    });
    expect(c?.maxAge).toBeGreaterThan(300 * 24 * 3600);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('wrong token 401, malformed 400, foreign Origin 403', async () => {
    const e = await setup();
    await createDevice(e);
    const wrong = await e.t.app.inject({
      method: 'POST',
      url: '/api/wall/session',
      headers: SAME_ORIGIN,
      payload: { token: 'A'.repeat(43) },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.cookies).toEqual([]);
    for (const payload of [{}, { token: 'short' }, { token: 'A'.repeat(43), x: 1 }]) {
      const res = await e.t.app.inject({
        method: 'POST',
        url: '/api/wall/session',
        headers: SAME_ORIGIN,
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    const foreign = await e.t.app.inject({
      method: 'POST',
      url: '/api/wall/session',
      headers: { host: 'hz.test', origin: 'https://evil.example' },
      payload: { token: 'A'.repeat(43) },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('is rate limited to 10 per minute and IP', async () => {
    const e = await setup();
    const d = await createDevice(e);
    const post = (token: string, ip = '100.64.0.9') =>
      e.t.app.inject({
        method: 'POST',
        url: '/api/wall/session',
        headers: { ...SAME_ORIGIN, 'x-forwarded-for': ip },
        remoteAddress: '127.0.0.1',
        payload: { token },
      });
    for (let i = 0; i < 10; i++) expect((await post('B'.repeat(43))).statusCode).toBe(401);
    const limited = await post(d.token);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    // Another IP is not affected.
    expect((await post(d.token, '100.64.0.10')).statusCode).toBe(200);
    e.t.clock.advance(60_000);
    expect((await post(d.token)).statusCode).toBe(200);
  });

  it('never logs the token (also not on the /wall?t= page request)', async () => {
    const e = await setup({ captureLogs: true });
    const d = await createDevice(e);
    await e.t.app.inject({ method: 'GET', url: `/wall?t=${d.token}` });
    await e.t.app.inject({
      method: 'POST',
      url: '/api/wall/session',
      headers: SAME_ORIGIN,
      payload: { token: d.token },
    });
    await getState(e, wallCookie(d.token));
    expect(e.t.logs.join('')).not.toContain(d.token);
  });
});

describe('the wall cookie is read-only', () => {
  it('works for GET /api/wall/state and nothing else under /api', async () => {
    const e = await setup();
    const d = await createDevice(e);
    expect(DEVICE_API_ROUTES).toEqual(['/api/wall/state']);
    expect((await getState(e, wallCookie(d.token))).statusCode).toBe(200);

    const routes = e.t.app.hzRoutes.filter(
      (r) =>
        r.url.startsWith('/api/') &&
        !PUBLIC_API_ROUTES.includes(r.url) &&
        !(DEVICE_API_ROUTES.includes(r.url) && (r.method === 'GET' || r.method === 'HEAD')),
    );
    expect(routes.length).toBeGreaterThan(50);
    for (const r of routes) {
      const url = r.url.replace(/:[A-Za-z]+/g, 'AAAAAAAAAAAAAAAAAAAAAA');
      const res = await e.t.app.inject({
        method: r.method as 'GET',
        url,
        headers: wallCookie(d.token),
        ...(r.method === 'GET' || r.method === 'HEAD' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
    // Unknown paths under /api/wall/ are not public either.
    for (const url of ['/api/wall', '/api/wall/', '/api/wall/state/x', '/api/wall/devices']) {
      const res = await e.t.app.inject({ method: 'GET', url, headers: wallCookie(d.token) });
      expect(res.statusCode, url).toBe(401);
    }
    // POST to the state route with the cookie is not allowed either.
    const post = await e.t.app.inject({
      method: 'POST',
      url: '/api/wall/state',
      headers: wallCookie(d.token),
      payload: {},
    });
    expect(post.statusCode).toBe(401);
  });

  it('opens neither /live nor /console', async () => {
    const e = await setup();
    const d = await createDevice(e);
    const url = await listen(e.t);
    expect(await WsClient.status(`${url}/live`, wallCookie(d.token))).toBe(401);
    expect(await WsClient.status(`${url}/console?serverId=x`, wallCookie(d.token))).toBe(401);
  });

  it('without any cookie the state is 401; an admin session may read it', async () => {
    const e = await setup();
    expect((await getState(e, SAME_ORIGIN)).statusCode).toBe(401);
    expect((await getState(e, wallCookie('A'.repeat(43)))).statusCode).toBe(401);
    expect((await getState(e, wallCookie('not-a-token'))).statusCode).toBe(401);
    expect((await getState(e, authHeaders(e.cookie))).statusCode).toBe(200);
  });

  it('updates lastSeenAt at most once per minute', async () => {
    const e = await setup();
    const d = await createDevice(e);
    const seen = () =>
      (
        e.t.db.sqlite.prepare('SELECT last_seen_at FROM wall_devices').get() as {
          last_seen_at: number | null;
        }
      ).last_seen_at;
    const r1 = await getState(e, wallCookie(d.token));
    const first = seen();
    expect(first).toBe(e.t.clock.t);
    expect(r1.cookies.some((c) => c.name === 'hz_wall')).toBe(true);
    e.t.clock.advance(30_000);
    const r2 = await getState(e, wallCookie(d.token));
    expect(seen()).toBe(first);
    expect(r2.cookies).toEqual([]);
    e.t.clock.advance(30_000);
    await getState(e, wallCookie(d.token));
    expect(seen()).toBe(e.t.clock.t);
    // Admin reads do not count as the device.
    e.t.clock.advance(120_000);
    await getState(e, authHeaders(e.cookie));
    expect(seen()).not.toBe(e.t.clock.t);
  });
});

describe('GET /api/wall/state', () => {
  it('has the five tiles and no internal fields (deep check)', async () => {
    const e = await setup();
    const url = await listen(e.t);
    const { agent, serverId, agentToken } = await enrollAgent(e.t, url, e.cookie);
    clients.push(agent);
    agent.send(inventoryMsg());
    agent.send(metricsMsg({ diskPct: 97 }));
    await until(() => e.t.app.hzCore.servers.summary(serverId)?.cpu !== null);
    e.t.app.hzCore.servers.refreshAll();
    const tsIp = '100.64.0.5';
    e.t.app.hzCore.alerts.raise(
      'test:ip',
      'warn',
      `Check 100.64.0.7:25565 langsam`,
      'x',
      null,
      'check',
    );
    e.t.app.hzCore.servers.refreshAll();
    const d = await createDevice(e);
    const res = await getState(e, wallCookie(d.token));
    expect(res.statusCode).toBe(200);
    const state = wallStateSchema.parse(res.json());
    expect(state.tiles.map((x) => x.id)).toEqual([
      'servers',
      'players',
      'temperature',
      'power',
      'problems',
    ]);
    expect(state.tiles.find((x) => x.id === 'servers')).toMatchObject({
      value: '0/1',
      tone: 'crit',
    });
    const problems = state.tiles.find((x) => x.id === 'problems');
    expect(problems?.tone).toBe('crit');
    expect(state.alerts.length).toBeGreaterThan(0);
    expect(state.alerts[0]?.level).toBe('crit');

    const ids = [
      serverId,
      d.id,
      ...(e.t.db.sqlite.prepare('SELECT id FROM alerts').all() as { id: string }[]).map(
        (r) => r.id,
      ),
    ];
    const forbiddenKeys = new Set([
      'id',
      'serverId',
      'key',
      'tailscaleIp',
      'publicIp',
      'entityId',
      'body',
    ]);
    const walk = (v: unknown, path: string): void => {
      if (typeof v === 'string') {
        for (const id of ids) expect(v, path).not.toContain(id);
        expect(v, path).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
        expect(v, path).not.toContain(agentToken);
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${path}[${i}]`));
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          // Tiles have an `id`, but only one of the fixed names.
          if (k === 'id' && /^\.tiles\[\d+\]$/.test(path)) {
            expect(x).toMatch(/^(servers|players|temperature|power|problems)$/);
            continue;
          }
          expect(forbiddenKeys.has(k), `${path}.${k}`).toBe(false);
          walk(x, `${path}.${k}`);
        }
      }
    };
    walk(res.json(), '');
    expect(res.body).not.toContain(tsIp);
  });

  it('empty hub: tiles are off, sentence "Noch nichts verbunden."', async () => {
    const e = await setup();
    const res = await getState(e, authHeaders(e.cookie));
    const s = wallStateSchema.parse(res.json());
    expect(s.sentence).toBe('Noch nichts verbunden.');
    expect(s.tiles.find((x) => x.id === 'servers')).toMatchObject({ value: '0/0', tone: 'off' });
    expect(s.tiles.find((x) => x.id === 'problems')).toMatchObject({ value: '0', tone: 'ok' });
    expect(s.tiles.find((x) => x.id === 'power')).toMatchObject({ value: '–', tone: 'off' });
  });

  it('night flag follows Vienna time (route)', async () => {
    const e = await setup();
    e.t.clock.t = fromVienna(2026, 11, 26, 22, 0);
    expect(wallStateSchema.parse((await getState(e, authHeaders(e.cookie))).json()).night).toBe(
      true,
    );
    e.t.clock.t = fromVienna(2026, 11, 27, 7, 0);
    const day = await getState(e, authHeaders(e.cookie));
    // The session may have slid; it is still valid (30 days).
    expect(wallStateSchema.parse(day.json()).night).toBe(false);
  });
});

describe('wall helpers', () => {
  it('night is 22:00–06:59 Europe/Vienna, also across DST', () => {
    const cases: [number, number, number, number, number, boolean][] = [
      // winter (CET, UTC+1)
      [2026, 1, 15, 21, 59, false],
      [2026, 1, 15, 22, 0, true],
      [2026, 1, 16, 6, 59, true],
      [2026, 1, 16, 7, 0, false],
      // summer (CEST, UTC+2)
      [2026, 7, 15, 21, 59, false],
      [2026, 7, 15, 22, 0, true],
      [2026, 7, 16, 6, 59, true],
      [2026, 7, 16, 7, 0, false],
      // DST start (29 Mar 2026, 02:00 -> 03:00) and end (25 Oct 2026, 03:00 -> 02:00)
      [2026, 3, 29, 6, 59, true],
      [2026, 3, 29, 7, 0, false],
      [2026, 3, 28, 22, 0, true],
      [2026, 10, 25, 6, 59, true],
      [2026, 10, 25, 7, 0, false],
      [2026, 10, 24, 22, 0, true],
      [2026, 10, 25, 21, 59, false],
    ];
    for (const [y, mo, d, h, mi, night] of cases) {
      expect(isNight(fromVienna(y, mo, d, h, mi)), `${y}-${mo}-${d} ${h}:${mi}`).toBe(night);
    }
    // In UTC terms: 21:00Z is 22:00 in winter but 23:00 in summer.
    expect(isNight(Date.UTC(2026, 0, 15, 20, 59))).toBe(false);
    expect(isNight(Date.UTC(2026, 0, 15, 21, 0))).toBe(true);
    expect(isNight(Date.UTC(2026, 6, 15, 19, 59))).toBe(false);
    expect(isNight(Date.UTC(2026, 6, 15, 20, 0))).toBe(true);
    expect(isNight(Date.UTC(2026, 6, 16, 4, 59))).toBe(true);
    expect(isNight(Date.UTC(2026, 6, 16, 5, 0))).toBe(false);
  });

  it('sentence like the status sentence of the web app', () => {
    const srv = (name: string, status: ServerSummary['status']) =>
      ({ id: name, name, status }) as ServerSummary;
    expect(wallSentence([], [])).toBe('Noch nichts verbunden.');
    expect(wallSentence([srv('a', 'ok'), srv('b', 'ok')], [])).toBe('Alles läuft.');
    expect(wallSentence([srv('a', 'ok'), srv('oracle-a1', 'warn')], [])).toBe(
      '1 Problem auf oracle-a1 · 2 von 2 Servern laufen',
    );
    expect(
      wallSentence(
        [srv('a', 'crit'), srv('b', 'ok'), srv('c', 'ok'), srv('d', 'ok')],
        [{ level: 'crit', serverId: null }],
      ),
    ).toBe('2 Probleme · 3 von 4 Servern laufen');
    expect(wallSentence([srv('a', 'off')], [])).toBe('0 von 1 Server laufen');
    expect(wallSentence([srv('a', 'ok')], [])).toBe('Alles läuft.');
  });

  it('masks IP addresses in alert titles', () => {
    expect(maskAddresses('Check 100.64.0.7:25565 langsam')).toBe('Check … langsam');
    expect(maskAddresses('fd7a:115c:a1e0::1 weg')).toBe('… weg');
    expect(maskAddresses('Backup um 23:04 fertig')).toBe('Backup um 23:04 fertig');
    expect(maskAddresses('Seit 24.11. 23:04:05')).toBe('Seit 24.11. 23:04:05');
    expect(maskAddresses('[2001:db8:0:0:0:0:0:1]:80 weg')).toBe('…:80 weg');
  });
});

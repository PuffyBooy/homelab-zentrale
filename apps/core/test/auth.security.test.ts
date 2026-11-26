import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { requireStepUp } from '../src/auth/index.js';
import { auditLog, users } from '../src/db/schema.js';
import {
  authHeaders,
  completeSetup,
  login,
  makeApp,
  PASSWORD,
  SAME_ORIGIN,
  SETUP_TOKEN,
  totpCode,
  USERNAME,
  type TestApp,
} from './helpers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

const MIN = 60_000;

describe('every /api route needs a session', () => {
  it('answers 401 on every registered route outside the allowlist', async () => {
    t = await makeApp();
    const routes = t.app.hzRoutes.filter(
      (r) => r.url.startsWith('/api/') && !PUBLIC_API_ROUTES.includes(r.url),
    );
    expect(routes.map((r) => `${r.method} ${r.url}`)).toEqual(
      expect.arrayContaining([
        'POST /api/auth/logout',
        'POST /api/auth/step-up',
        'POST /api/auth/recovery-codes',
        'POST /api/auth/password',
        'GET /api/auth/sessions',
        'DELETE /api/auth/sessions/:id',
      ]),
    );
    for (const r of routes) {
      const url = r.url.replace(/:[A-Za-z]+/g, 'AAAAAAAAAAAAAAAAAAAAAA');
      // With and without a valid-looking Origin: auth is checked first.
      for (const headers of [{}, SAME_ORIGIN]) {
        const res = await t.app.inject({
          method: r.method as 'GET',
          url,
          headers,
          ...(r.method === 'GET' || r.method === 'HEAD' ? {} : { payload: {} }),
        });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
        if (r.method !== 'HEAD') {
          expect(res.json(), `${r.method} ${r.url}`).toEqual({
            ok: false,
            error: 'unauthorized',
          });
        }
      }
    }
  });

  it('answers 401 (not 404) on unknown /api paths without session', async () => {
    t = await makeApp();
    for (const url of ['/api', '/api/nope', '/api/servers/1', '/api/auth/state/../sessions']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('only the allowlist is public', () => {
    expect([...PUBLIC_API_ROUTES].sort()).toEqual(
      [
        '/api/auth/login',
        '/api/auth/state',
        '/api/health',
        '/api/onboarding/exchange',
        '/api/setup/confirm',
        '/api/setup/start',
        '/api/wall/session',
      ].sort(),
    );
  });

  it('a forged, malformed or revoked cookie is not a session', async () => {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    for (const value of ['', 'x', 'A'.repeat(43), `${cookie}x`, cookie.toUpperCase()]) {
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/auth/sessions',
        headers: authHeaders(value),
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('answers 404 for unknown /api paths once logged in', async () => {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/nope',
      headers: authHeaders(cookie),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('session cookie', () => {
  it('is httpOnly, Secure, SameSite=Strict, Path=/, 30 days', async () => {
    t = await makeApp();
    const start = await t.app.inject({
      method: 'POST',
      url: '/api/setup/start',
      headers: SAME_ORIGIN,
      payload: { setupToken: SETUP_TOKEN, username: USERNAME, password: PASSWORD },
    });
    const secret = start.json<{ secret: string }>().secret;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/setup/confirm',
      headers: SAME_ORIGIN,
      payload: { setupToken: SETUP_TOKEN, code: totpCode(secret, t.clock.t) },
    });
    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(/^hz_session=[A-Za-z0-9_-]{43};/);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Strict');
    expect(raw).toContain('Path=/');
    expect(raw).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(raw).not.toMatch(/Domain=/i);
  });

  it('stores only a hash of the cookie value', async () => {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    const dump = JSON.stringify(t.db.sqlite.prepare('SELECT * FROM sessions').all());
    expect(dump).not.toContain(cookie);
  });

  it('sets no cookie on a failed login', async () => {
    t = await makeApp();
    await completeSetup(t);
    const res = await login(t, '000000', { password: 'wrong password!' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('setup token', () => {
  it('rejects a wrong setup token', async () => {
    t = await makeApp();
    for (const url of ['/api/setup/start', '/api/setup/confirm']) {
      const res = await t.app.inject({
        method: 'POST',
        url,
        headers: SAME_ORIGIN,
        payload:
          url === '/api/setup/start'
            ? { setupToken: 'wrong-setup-token-0123456789', username: USERNAME, password: PASSWORD }
            : { setupToken: 'wrong-setup-token-0123456789', code: '123456' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'setup_invalid' });
    }
    expect(
      t.db.db
        .select()
        .from(auditLog)
        .all()
        .map((r) => r.action),
    ).toEqual(['setup.failed', 'setup.failed']);
  });

  it('a second setup is refused once the admin exists, also with the old token', async () => {
    t = await makeApp();
    await completeSetup(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/setup/start',
      headers: SAME_ORIGIN,
      payload: { setupToken: SETUP_TOKEN, username: 'eve', password: 'another long password' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: 'setup_done' });
    const confirm = await t.app.inject({
      method: 'POST',
      url: '/api/setup/confirm',
      headers: SAME_ORIGIN,
      payload: { setupToken: SETUP_TOKEN, code: '123456' },
    });
    expect(confirm.statusCode).toBe(409);
    expect(t.db.db.select().from(users).all()).toHaveLength(1);
    expect(t.app.hzAuth.setup.armed).toBe(false);
  });

  it('is not armed after a restart with an existing admin', async () => {
    t = await makeApp();
    await completeSetup(t);
    const { db } = t;
    // Re-use the DB in a fresh app (the old app must not close it).
    const reopened = await makeApp({ db: { ...db, close: () => undefined } });
    try {
      expect(reopened.app.hzAuth.setup.armed).toBe(false);
      const res = await reopened.app.inject({ method: 'GET', url: '/api/auth/state' });
      expect(res.json<{ setupRequired: boolean }>().setupRequired).toBe(false);
    } finally {
      await reopened.app.close();
    }
  });
});

describe('TOTP replay', () => {
  it('a code accepted at login cannot be used again (login or step-up)', async () => {
    t = await makeApp();
    const { secret } = await completeSetup(t);
    const code = totpCode(secret, t.clock.t);
    const first = await login(t, code);
    expect(first.statusCode).toBe(200);
    const cookie = first.cookies.find((c) => c.name === 'hz_session')?.value ?? '';
    expect((await login(t, code)).statusCode).toBe(401);
    const stepUp = await t.app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: authHeaders(cookie),
      payload: { code },
    });
    expect(stepUp.statusCode).toBe(403);
  });

  it('the setup confirmation code cannot be used to log in', async () => {
    t = await makeApp();
    const start = await t.app.inject({
      method: 'POST',
      url: '/api/setup/start',
      headers: SAME_ORIGIN,
      payload: { setupToken: SETUP_TOKEN, username: USERNAME, password: PASSWORD },
    });
    const secret = start.json<{ secret: string }>().secret;
    const code = totpCode(secret, t.clock.t);
    await t.app.inject({
      method: 'POST',
      url: '/api/setup/confirm',
      headers: SAME_ORIGIN,
      payload: { setupToken: SETUP_TOKEN, code },
    });
    expect((await login(t, code)).statusCode).toBe(401);
  });

  it('an older code is rejected after a newer one was used', async () => {
    t = await makeApp();
    const { secret } = await completeSetup(t);
    const older = totpCode(secret, t.clock.t);
    expect((await login(t, totpCode(secret, t.clock.t + 30_000))).statusCode).toBe(200);
    expect((await login(t, older)).statusCode).toBe(401);
  });
});

describe('login rate limit', () => {
  it('blocks the 6th attempt with 429, even with correct credentials', async () => {
    t = await makeApp();
    const { secret } = await completeSetup(t);
    for (let i = 0; i < 5; i++) {
      const res = await login(t, '000000', { password: 'wrong password!' });
      expect(res.statusCode).toBe(401);
    }
    const sixth = await login(t, totpCode(secret, t.clock.t));
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toEqual({ ok: false, error: 'rate_limited', retryAfter: 900 });
    expect(sixth.headers['retry-after']).toBe('900');
    expect(sixth.cookies).toHaveLength(0);
  });

  it('waits longer after each block, and resets after success', async () => {
    const app = await makeApp();
    t = app;
    const { secret } = await completeSetup(t);
    const fail5 = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await login(app, '000000', { password: 'wrong password!' });
    };
    await fail5();
    t.clock.advance(15 * MIN);
    await fail5();
    const second = await login(t, '000000');
    expect(second.json<{ retryAfter: number }>().retryAfter).toBe(30 * 60);
    t.clock.advance(30 * MIN);
    await fail5();
    expect((await login(t, '000000')).json<{ retryAfter: number }>().retryAfter).toBe(60 * 60);
    t.clock.advance(60 * MIN);
    expect((await login(t, totpCode(secret, t.clock.t))).statusCode).toBe(200);
    await fail5();
    expect((await login(t, '000000')).json<{ retryAfter: number }>().retryAfter).toBe(15 * 60);
  });

  it('forgets failures older than 15 minutes', async () => {
    t = await makeApp();
    await completeSetup(t);
    for (let i = 0; i < 4; i++) await login(t, '000000', { password: 'wrong password!' });
    t.clock.advance(15 * MIN);
    for (let i = 0; i < 4; i++) {
      expect((await login(t, '000000', { password: 'wrong password!' })).statusCode).toBe(401);
    }
  });

  it('counts per client IP from X-Forwarded-For behind the loopback proxy', async () => {
    t = await makeApp();
    const { secret } = await completeSetup(t);
    for (let i = 0; i < 5; i++) {
      await login(t, '000000', { password: 'wrong password!', ip: '100.64.0.9' });
    }
    expect((await login(t, '000000', { ip: '100.64.0.9' })).statusCode).toBe(429);
    expect((await login(t, totpCode(secret, t.clock.t), { ip: '100.64.0.10' })).statusCode).toBe(
      200,
    );
  });

  it('ignores X-Forwarded-For from a non-loopback peer', async () => {
    t = await makeApp();
    await completeSetup(t);
    for (let i = 0; i < 5; i++) {
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '192.168.1.50',
        headers: { ...SAME_ORIGIN, 'x-forwarded-for': `10.0.0.${i}` },
        payload: { username: USERNAME, password: 'wrong password!', code: '000000' },
      });
    }
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '192.168.1.50',
      headers: { ...SAME_ORIGIN, 'x-forwarded-for': '10.0.0.99' },
      payload: { username: USERNAME, password: PASSWORD, code: '000000' },
    });
    expect(res.statusCode).toBe(429);
  });

  it('limits wrong setup tokens too', async () => {
    const app = await makeApp();
    t = app;
    const attempt = () =>
      app.app.inject({
        method: 'POST',
        url: '/api/setup/start',
        headers: SAME_ORIGIN,
        payload: {
          setupToken: 'wrong-setup-token-0123456789',
          username: USERNAME,
          password: PASSWORD,
        },
      });
    for (let i = 0; i < 10; i++) expect((await attempt()).statusCode).toBe(403);
    expect((await attempt()).statusCode).toBe(429);
  });
});

describe('step-up', () => {
  it('is required for recovery codes and password change, and lasts 15 minutes', async () => {
    t = await makeApp();
    const { secret, cookie } = await completeSetup(t);
    const protectedCalls = [
      { url: '/api/auth/recovery-codes', payload: {} },
      {
        url: '/api/auth/password',
        payload: { currentPassword: PASSWORD, newPassword: 'another long password' },
      },
    ];

    for (const c of protectedCalls) {
      const res = await t.app.inject({ method: 'POST', headers: authHeaders(cookie), ...c });
      expect(res.statusCode, c.url).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    }

    const up = await t.app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: authHeaders(cookie),
      payload: { code: totpCode(secret, t.clock.t) },
    });
    expect(up.statusCode).toBe(200);
    const until = up.json<{ stepUpUntil: string }>().stepUpUntil;
    expect(Date.parse(until)).toBe(t.clock.t + 15 * MIN);

    const state = await t.app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: authHeaders(cookie),
    });
    expect(state.json<{ stepUpUntil?: string }>().stepUpUntil).toBe(until);

    t.clock.advance(15 * MIN - 1000);
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/auth/recovery-codes',
      headers: authHeaders(cookie),
    });
    expect(ok.statusCode).toBe(200);

    t.clock.advance(1000);
    for (const c of protectedCalls) {
      const res = await t.app.inject({ method: 'POST', headers: authHeaders(cookie), ...c });
      expect(res.statusCode, c.url).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    }
    const expired = await t.app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: authHeaders(cookie),
    });
    expect(expired.json<{ stepUpUntil?: string }>().stepUpUntil).toBeUndefined();
  });

  it('is bound to the session', async () => {
    t = await makeApp();
    const { secret, cookie } = await completeSetup(t);
    const other = (await login(t, totpCode(secret, t.clock.t))).cookies[0]?.value ?? '';
    t.clock.advance(30_000);
    await t.app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: authHeaders(cookie),
      payload: { code: totpCode(secret, t.clock.t) },
    });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/recovery-codes',
      headers: authHeaders(other),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a wrong code, rate-limits, and needs a session', async () => {
    t = await makeApp();
    const { secret, cookie } = await completeSetup(t);
    const good = totpCode(secret, t.clock.t);
    const wrong = good === '000000' ? '111111' : '000000';
    const noSession = await t.app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: SAME_ORIGIN,
      payload: { code: good },
    });
    expect(noSession.statusCode).toBe(401);
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: authHeaders(cookie),
      payload: { code: 'abc' },
    });
    expect(bad.statusCode).toBe(400);
    for (let i = 0; i < 5; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/step-up',
        headers: authHeaders(cookie),
        payload: { code: wrong },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'invalid_credentials' });
    }
    const blocked = await t.app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: authHeaders(cookie),
      payload: { code: good },
    });
    expect(blocked.statusCode).toBe(429);
    const audit = t.db.db
      .select()
      .from(auditLog)
      .all()
      .map((r) => r.action);
    expect(audit.filter((a) => a === 'auth.step_up_failed')).toHaveLength(5);
  });

  it('requireStepUp works as preHandler for later routes', async () => {
    t = await makeApp();
    const clock = t.clock;
    // A fresh instance so the route is registered before ready().
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const { openDatabase } = await import('../src/db/index.js');
    const { KEY, emptyDir } = await import('./helpers.js');
    const app = await buildApp(
      loadConfig({
        HZ_SECRET_KEY: KEY,
        NODE_ENV: 'test',
        HZ_WEB_DIR: emptyDir(),
        HZ_SETUP_TOKEN: SETUP_TOKEN,
      }),
      { db: openDatabase(':memory:'), now: () => clock.t },
    );
    app.post('/api/demo/danger', { preHandler: requireStepUp(() => clock.t) }, async () => ({
      ok: true,
    }));
    await app.ready();
    try {
      const inner: TestApp = { app, db: t.db, clock, logs: [] };
      const { secret, cookie } = await completeSetup(inner);
      const call = () =>
        app.inject({ method: 'POST', url: '/api/demo/danger', headers: authHeaders(cookie) });
      expect(
        (await app.inject({ method: 'POST', url: '/api/demo/danger', headers: SAME_ORIGIN }))
          .statusCode,
      ).toBe(401);
      expect((await call()).statusCode).toBe(403);
      await app.inject({
        method: 'POST',
        url: '/api/auth/step-up',
        headers: authHeaders(cookie),
        payload: { code: totpCode(secret, clock.t) },
      });
      expect((await call()).statusCode).toBe(200);
      clock.advance(15 * MIN);
      expect((await call()).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

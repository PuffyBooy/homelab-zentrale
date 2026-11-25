import { afterEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  completeSetup,
  makeApp,
  PASSWORD,
  SAME_ORIGIN,
  SETUP_TOKEN,
  USERNAME,
  type TestApp,
} from './helpers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

describe('security headers', () => {
  it('sends a strict CSP without inline code or third-party hosts', async () => {
    t = await makeApp();
    for (const url of ['/api/health', '/api/auth/state', '/']) {
      const res = await t.app.inject({ method: 'GET', url });
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("worker-src 'self'");
      expect(csp).toContain("manifest-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).not.toMatch(/googleapis|gstatic|https?:/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
  });

  it('marks API responses as not cacheable', async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('Origin check (CSRF)', () => {
  const body = { username: USERNAME, password: PASSWORD, code: '000000' };

  it('rejects state-changing requests without or with a foreign Origin', async () => {
    t = await makeApp();
    const cases: Record<string, string>[] = [
      { host: 'hz.test' },
      { host: 'hz.test', origin: 'https://evil.test' },
      { host: 'hz.test', origin: 'null' },
      { host: 'hz.test', origin: 'https://hz.test.evil.test' },
      { host: 'hz.test', origin: 'https://evil.test/https://hz.test' },
      { host: 'hz.test', origin: 'file://hz.test' },
      { host: 'hz.test', origin: 'not a url' },
      { host: 'hz.test:8080', origin: 'https://hz.test' },
    ];
    for (const headers of cases) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers,
        payload: body,
      });
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'bad_origin' });
    }
  });

  it('checks DELETE and authenticated POSTs too', async () => {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    const headers = {
      cookie: `hz_session=${cookie}`,
      host: 'hz.test',
      origin: 'https://evil.test',
    };
    for (const [method, url] of [
      ['POST', '/api/auth/logout'],
      ['POST', '/api/auth/step-up'],
      ['DELETE', '/api/auth/sessions/AAAAAAAAAAAAAAAAAAAAAA'],
    ] as const) {
      const res = await t.app.inject({ method, url, headers, payload: {} });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'bad_origin' });
    }
    // Still logged in: the forged logout did nothing.
    const state = await t.app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: authHeaders(cookie),
    });
    expect(state.json<{ authenticated: boolean }>().authenticated).toBe(true);
  });

  it('accepts the same host (also the Vite dev proxy on :5173) and HZ_BASE_URL', async () => {
    t = await makeApp({ env: { HZ_BASE_URL: 'https://heimserver.tail1234.ts.net' } });
    for (const headers of [
      SAME_ORIGIN,
      { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' },
      { host: '127.0.0.1:8080', origin: 'https://heimserver.tail1234.ts.net' },
      { host: 'HZ.TEST', origin: 'https://hz.test' },
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers,
        payload: body,
      });
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
      expect(res.json()).toEqual({ ok: false, error: 'invalid_credentials' });
    }
  });

  it('does not require Origin on GET', async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(res.statusCode).toBe(200);
  });
});

describe('error responses', () => {
  const marker = 'ECHO-MARKER-7f3a';

  it('never echo the input', async () => {
    t = await makeApp();
    const requests = [
      { payload: { username: marker, password: marker, code: marker } },
      { payload: { username: 'alex', password: PASSWORD, code: '000000', extra: marker } },
      { payload: `{"username":"${marker}",`, headers: { 'content-type': 'application/json' } },
      { payload: marker, headers: { 'content-type': 'text/plain' } },
      { payload: { username: ['x'], password: { $ne: marker } } },
    ];
    for (const r of requests) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        ...r,
        headers: { ...SAME_ORIGIN, ...r.headers },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body).not.toContain(marker);
      expect(Object.keys(res.json<object>()).sort()).toEqual(['error', 'ok']);
      expect(res.json<{ error: string }>().error).toBe('invalid_input');
    }
  });

  it('do not reveal whether the setup token was close', async () => {
    t = await makeApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/setup/start',
      headers: SAME_ORIGIN,
      payload: {
        setupToken: `${SETUP_TOKEN.slice(0, -1)}x`,
        username: USERNAME,
        password: PASSWORD,
      },
    });
    expect(res.body).toBe('{"ok":false,"error":"setup_invalid"}');
  });

  it('answer 500 internal without stack or message', async () => {
    t = await makeApp();
    // Break the DB under the running app.
    t.db.sqlite.exec('DROP TABLE users');
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe('{"ok":false,"error":"internal"}');
  });
});

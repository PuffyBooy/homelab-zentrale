import { afterEach, describe, expect, it } from 'vitest';
import { completeSetup, login, makeApp, SAME_ORIGIN, type TestApp } from './helpers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

describe('guard cannot be bypassed with encoded paths', () => {
  const encoded = ['/%61pi/auth/sessions', '/ap%69/auth/sessions', '/%61%70%69/auth/sessions'];

  it.each(encoded)('GET %s without session answers 401', async (url) => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('POST to an encoded protected path without session answers 401', async () => {
    t = await makeApp();
    for (const url of ['/%61pi/auth/password', '/%61pi/auth/recovery-codes']) {
      const res = await t.app.inject({ method: 'POST', url, headers: SAME_ORIGIN, payload: {} });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('origin check applies to encoded public paths', async () => {
    t = await makeApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/%61pi/auth/login',
      headers: { host: SAME_ORIGIN.host, origin: 'https://evil.example' },
      payload: { username: 'alex', password: 'x', code: '000000' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, error: 'bad_origin' });
  });

  it('malformed percent-encoding is rejected', async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/%E0%A4%A/auth/sessions' });
    expect(res.statusCode).toBe(400);
  });

  it('double-encoded paths do not reach /api routes', async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/%2561pi/auth/sessions' });
    expect(res.statusCode).not.toBe(200);
  });
});

describe('login rate limit under parallel load', () => {
  it('parallel failures cannot exceed the limit', async () => {
    t = await makeApp();
    await completeSetup(t);
    const app = t;
    const results = await Promise.all(
      Array.from({ length: 40 }, () => login(app, '000000', { password: 'wrong password!' })),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(35);
    // The block stays at the first level (15 min), it is not driven up by the burst.
    const after = await login(app, '000000', { password: 'wrong password!' });
    expect(after.json()).toMatchObject({ error: 'rate_limited', retryAfter: 900 });
  });
});

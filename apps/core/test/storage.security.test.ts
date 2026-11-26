import { afterEach, describe, expect, it } from 'vitest';
import { completeSetup, authHeaders, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

describe('storage routes (security)', () => {
  it('need an admin session', async () => {
    t = await makeApp();
    await completeSetup(t);
    for (const url of ['/api/storage', '/api/storage/abcdefgh12345678']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('reject malformed server ids and offer no write method', async () => {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/storage/..%2F..%2Fetc',
      headers: authHeaders(cookie),
    });
    expect([400, 404]).toContain(bad.statusCode);
    expect(bad.body).not.toContain('etc');
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const res = await t.app.inject({
        method,
        url: '/api/storage',
        headers: authHeaders(cookie),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INDEX_HTML, SHARE_TOKEN, okStatus, raw, shareHeaders, startHarness } from './helpers.js';
import type { Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  h.setCore(() => ({ body: okStatus }));
});
afterAll(() => h.close());

describe('only allowlisted routes exist', () => {
  it('serves the mini UI for a well-formed token path', async () => {
    const r = await raw(h.url, `/s/${SHARE_TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body).toBe(INDEX_HTML);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it.each([
    '/',
    '/s',
    '/s/',
    '/api',
    '/api/health',
    '/api/share-gateway/status',
    '/admin',
    '/login',
    '/index.html',
    '/s/index.html',
    `/s/${SHARE_TOKEN}/`,
    `/s/${SHARE_TOKEN}/x`,
    `/s/${SHARE_TOKEN.slice(1)}`,
    `/s/${SHARE_TOKEN}a`,
    '/s/assets/',
    '/s/assets',
    '/s/api',
    '/s/api/',
    '/s/api/status/',
    '/s/api/shares',
    '/s/api/../api/status',
    '/favicon.ico',
  ])('GET %s -> 404', async (p) => {
    const r = await raw(h.url, p, { headers: shareHeaders() });
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('Steve');
  });

  it.each([
    ['POST', '/s/api/status'],
    ['GET', '/s/api/action'],
    ['GET', '/s/api/whitelist'],
    ['PUT', '/s/api/console'],
    ['DELETE', '/s/api/console'],
    ['PATCH', '/s/api/action'],
    ['POST', `/s/${SHARE_TOKEN}`],
    ['HEAD', `/s/${SHARE_TOKEN}`],
    ['OPTIONS', '/s/api/status'],
    ['TRACE', '/s/api/status'],
  ])('%s %s -> 404, core not called', async (method, p) => {
    const before = h.coreRequests.length;
    const r = await raw(h.url, p, {
      method,
      headers: shareHeaders({ 'content-type': 'application/json' }),
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
    });
    expect(r.status).toBe(404);
    expect(h.coreRequests.length).toBe(before);
  });

  it('proxies exactly the five API routes to /api/share-gateway/*', async () => {
    h.setCore((req) => {
      if (req.url.startsWith('/api/share-gateway/console') && req.method === 'GET') {
        return { body: { lines: [] } };
      }
      if (req.url === '/api/share-gateway/console' || req.url === '/api/share-gateway/whitelist') {
        return { body: { output: 'ok' } };
      }
      return { body: okStatus };
    });
    const json = shareHeaders({ 'content-type': 'application/json' });
    const calls: [string, string, string | undefined][] = [
      ['GET', '/s/api/status', undefined],
      ['POST', '/s/api/action', '{"action":"start"}'],
      ['GET', '/s/api/console?after=abc', undefined],
      ['POST', '/s/api/console', '{"command":"list"}'],
      ['POST', '/s/api/whitelist', '{"op":"add","player":"Steve_1"}'],
    ];
    const before = h.coreRequests.length;
    for (const [method, p, body] of calls) {
      const r = await raw(h.url, p, { method, headers: json, ...(body ? { body } : {}) });
      expect(r.status, `${method} ${p}`).toBe(200);
    }
    expect(h.coreRequests.slice(before).map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/share-gateway/status',
      'POST /api/share-gateway/action',
      'GET /api/share-gateway/console?after=abc',
      'POST /api/share-gateway/console',
      'POST /api/share-gateway/whitelist',
    ]);
  });
});

describe('assets: no directory traversal', () => {
  it('serves allowlisted files with fixed MIME types', async () => {
    const js = await raw(h.url, '/s/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toContain('immutable');
    const css = await raw(h.url, '/s/assets/app.css');
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it.each([
    '/s/assets/../index.html',
    '/s/assets/..%2findex.html',
    '/s/assets/%2e%2e/%2e%2e/secret.txt',
    '/s/assets/..%2F..%2Fsecret.txt',
    '/s/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/s/assets/....//....//secret.txt',
    '/s/assets/..\\..\\secret.txt',
    '/s/assets/./app.js',
    '/s/assets//app.js',
    '/s/assets/app.js%00.png',
    '/s/assets/app.js.map',
    '/s/assets/.hidden.js',
    '/s/assets/sub/x.js',
    '/s/assets/link.js',
    '/s/assets/outside.js',
    '/s/assets/secret.txt',
    '/s/assets/APP.JS',
    '/s/../secret.txt',
    '//s/assets/app.js',
    '/etc/passwd',
    '/s/assets/%2fetc%2fpasswd',
  ])('GET %s -> 404', async (p) => {
    const r = await raw(h.url, p);
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('TOP-SECRET');
    expect(r.body).not.toContain('nested');
    expect(r.body).not.toBe('secret');
  });
});

describe('security headers', () => {
  const expectHardened = (headers: Record<string, unknown>): void => {
    expect(headers['content-security-policy']).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-robots-tag']).toContain('noindex');
    expect(headers['strict-transport-security']).toMatch(/^max-age=\d{8,}/);
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-powered-by']).toBeUndefined();
    expect(headers['server']).toBeUndefined();
  };

  it('on the page, assets, API answers and 404s', async () => {
    h.setCore(() => ({ body: okStatus, headers: { 'set-cookie': 'a=b', 'x-internal': '1' } }));
    for (const p of [`/s/${SHARE_TOKEN}`, '/s/assets/app.js', '/s/api/status', '/nope']) {
      const r = await raw(h.url, p, { headers: shareHeaders() });
      expectHardened(r.headers);
    }
  });

  it('never forwards core headers', async () => {
    h.setCore(() => ({
      body: okStatus,
      headers: {
        'set-cookie': 'hz=1',
        'x-internal-server': 'heimserver',
        'access-control-allow-origin': '*',
      },
    }));
    const r = await raw(h.url, '/s/api/status', { headers: shareHeaders() });
    expect(r.status).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.headers['x-internal-server']).toBeUndefined();
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
  });
});

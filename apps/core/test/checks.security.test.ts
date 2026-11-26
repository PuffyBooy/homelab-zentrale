import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkResponseSchema } from '@hz/shared';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { auditLog, checks } from '../src/db/schema.js';
import type { WsClient } from './agent-helpers.js';
import { withAgent } from './container-helpers.js';
import { authHeaders, completeSetup, HOST, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  await t?.app.close();
  t = undefined;
});

const ROUTES = [
  ['GET', '/api/checks'],
  ['POST', '/api/checks'],
  ['PUT', '/api/checks/:id'],
  ['DELETE', '/api/checks/:id'],
  ['POST', '/api/checks/:id/run'],
  ['GET', '/api/checks/:id/history'],
] as const;

const VALID = { kind: 'tcp', name: 'mc', host: '127.0.0.1', port: 1 };

async function withCheck() {
  t = await makeApp({ captureLogs: true });
  const a = await completeSetup(t);
  const headers = authHeaders(a.cookie);
  const res = await t.app.inject({ method: 'POST', url: '/api/checks', headers, payload: VALID });
  const id = checkResponseSchema.parse(res.json()).check.id;
  return { t, headers, cookie: a.cookie, id };
}

describe('check routes: auth', () => {
  it('are registered and not public', async () => {
    t = await makeApp();
    const routes = t.app.hzRoutes.map((r) => `${r.method} ${r.url}`);
    for (const [method, url] of ROUTES) {
      expect(routes).toContain(`${method} ${url}`);
      expect(PUBLIC_API_ROUTES).not.toContain(url);
    }
  });

  it('401 without a session or with a forged cookie, nothing changes', async () => {
    const { t, id } = await withCheck();
    for (const cookie of [undefined, `hz_session=${'A'.repeat(43)}`]) {
      const headers = { host: HOST, origin: `https://${HOST}`, ...(cookie ? { cookie } : {}) };
      for (const [method, url] of ROUTES) {
        const res = await t.app.inject({
          method,
          url: url.replace(':id', id),
          headers,
          ...(method === 'POST' || method === 'PUT' ? { payload: VALID } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
        expect(res.json()).toEqual({ ok: false, error: 'unauthorized' });
      }
    }
    expect(t.db.db.select().from(checks).all()).toHaveLength(1);
  });

  it('403 bad_origin for mutations from a foreign or missing Origin', async () => {
    const { t, cookie, id } = await withCheck();
    const mutations = ROUTES.filter(([m]) => m !== 'GET');
    for (const headers of [
      { host: HOST, cookie: `hz_session=${cookie}`, origin: 'https://evil.example' },
      { host: HOST, cookie: `hz_session=${cookie}`, origin: 'null' },
      { host: HOST, cookie: `hz_session=${cookie}` },
    ]) {
      for (const [method, url] of mutations) {
        const res = await t.app.inject({
          method,
          url: url.replace(':id', id),
          headers,
          ...(method !== 'DELETE' ? { payload: VALID } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json()).toEqual({ ok: false, error: 'bad_origin' });
      }
    }
    expect(t.db.db.select().from(checks).all()).toHaveLength(1);
    expect(t.db.db.select().from(checks).get()?.lastCheckedAt).toBeNull();
  });
});

describe('check routes: input', () => {
  it('bad ids are 400 for every :id route, unknown ids 404', async () => {
    const { t, headers } = await withCheck();
    for (const bad of ['a', 'x'.repeat(65), '..%2F..%2Fetc', 'a%20b%20c%20d%20e', 'abc$defgh1']) {
      for (const [method, url] of ROUTES.filter(([, u]) => u.includes(':id'))) {
        const res = await t.app.inject({
          method,
          url: url.replace(':id', bad),
          headers,
          ...(method === 'PUT' ? { payload: VALID } : {}),
        });
        expect(res.statusCode, `${method} ${bad}`).toBe(400);
      }
    }
    for (const [method, url] of ROUTES.filter(([, u]) => u.includes(':id'))) {
      const res = await t.app.inject({
        method,
        url: url.replace(':id', 'unknownid123'),
        headers,
        ...(method === 'PUT' ? { payload: VALID } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('history: unknown range or extra query keys are 400', async () => {
    const { t, headers, id } = await withCheck();
    for (const q of ['range=1y', 'range=24h&x=1', 'range=']) {
      const res = await t.app.inject({ url: `/api/checks/${id}/history?${q}`, headers });
      expect(res.statusCode, q).toBe(400);
    }
  });

  it('URLs with credentials are rejected; the password never reaches DB, audit or logs', async () => {
    const { t, headers } = await withCheck();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/checks',
      headers,
      payload: { kind: 'http', name: 'x', url: 'https://admin:Hunter2Secret@example.com/' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('Hunter2Secret');
    const dump = JSON.stringify([
      t.db.db.select().from(checks).all(),
      t.db.db.select().from(auditLog).all(),
    ]);
    expect(dump).not.toContain('Hunter2Secret');
    expect(t.logs.join('')).not.toContain('Hunter2Secret');
  });
});

describe('check results: no bodies or secrets in alerts, logs or audit', () => {
  it('a failing HTTP check keeps the body and the query token out of alerts and logs', async () => {
    const s = http.createServer((_req, res) => {
      res.statusCode = 503;
      res.end('INTERNAL-BODY-DETAIL stacktrace password=abc');
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    t = await makeApp({ captureLogs: true });
    const a = await completeSetup(t);
    const headers = authHeaders(a.cookie);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/checks',
      headers,
      payload: {
        kind: 'http',
        name: 'api',
        url: `http://127.0.0.1:${port}/health?token=QUERY-SECRET-42`,
      },
    });
    const id = checkResponseSchema.parse(res.json()).check.id;
    for (let i = 0; i < 2; i++) {
      await t.app.hzCore.scheduler.tick();
      await t.app.hzCore.checks.idle();
      t.clock.advance(60_000);
    }
    const alert = t.app.hzCore.alerts.active(`check:${id}:down`);
    expect(alert?.body).toContain('HTTP 503');
    const alertsDump = JSON.stringify(t.app.hzCore.alerts.list({ state: 'all', limit: 100 }));
    const audit = JSON.stringify(t.db.db.select().from(auditLog).all());
    const history = (await t.app.inject({ url: `/api/checks/${id}/history`, headers })).body;
    for (const text of [alertsDump, audit, t.logs.join(''), history]) {
      expect(text).not.toContain('INTERNAL-BODY-DETAIL');
      expect(text).not.toContain('QUERY-SECRET-42');
    }
  });

  it('agent error texts with credentials are cleaned before they reach alerts', async () => {
    const s = await withAgent(clients, {
      reply: (rpc) =>
        rpc.action === 'check.http'
          ? {
              type: 'rpc.result',
              id: rpc.id,
              ok: true,
              data: { ok: false, ms: null, error: 'fetch https://bob:AgentLeak9@10.0.0.1/ failed' },
            }
          : null,
    });
    t = s.t;
    const headers = authHeaders(s.cookie);
    const res = await s.t.app.inject({
      method: 'POST',
      url: '/api/checks',
      headers,
      payload: { kind: 'http', name: 'intern', url: 'https://10.0.0.1/', runFrom: s.serverId },
    });
    const id = checkResponseSchema.parse(res.json()).check.id;
    for (let i = 0; i < 2; i++) {
      await s.t.app.hzCore.scheduler.tick();
      await s.t.app.hzCore.checks.idle();
      s.t.clock.advance(60_000);
    }
    const alert = s.t.app.hzCore.alerts.active(`check:${id}:down`);
    expect(alert?.body).toContain('fetch https://10.0.0.1/ failed');
    const dump = JSON.stringify([
      s.t.app.hzCore.alerts.list({ state: 'all', limit: 100 }),
      s.t.app.hzCore.checks.list(),
    ]);
    expect(dump).not.toContain('AgentLeak9');
  });
});

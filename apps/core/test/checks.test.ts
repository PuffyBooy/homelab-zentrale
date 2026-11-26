import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkHistoryResponseSchema,
  checkListResponseSchema,
  checkResponseSchema,
  checkSummarySchema,
  liveServerMessageSchema,
} from '@hz/shared';
import { nextWallClock } from '../src/calendar.js';
import { httpProbe, MAX_BODY_BYTES, tcpProbe } from '../src/checks/probe.js';
import { auditLog, checkResults } from '../src/db/schema.js';
import { until, WsClient, type Received } from './agent-helpers.js';
import { withAgent } from './container-helpers.js';
import { authHeaders, completeSetup, makeApp, T0, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
const servers: (http.Server | https.Server)[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  await t?.app.close();
  t = undefined;
});

const DAY = 86_400_000;

async function serve(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function admin() {
  t = await makeApp({ liveOptions: { throttleMs: 10 } });
  const a = await completeSetup(t);
  return { t, headers: authHeaders(a.cookie), cookie: a.cookie };
}

async function step(tt: TestApp): Promise<void> {
  await tt.app.hzCore.scheduler.tick();
  await tt.app.hzCore.checks.idle();
}

describe('core probes', () => {
  it('HTTP: status range, contains, redirects (http(s) only), body limit', async () => {
    const big = 'a'.repeat(MAX_BODY_BYTES) + 'NEEDLE';
    const base = await serve((req, res) => {
      switch (req.url) {
        case '/ok':
          res.end('hello world');
          return;
        case '/503':
          res.statusCode = 503;
          res.end('secret body text');
          return;
        case '/hop':
          res.statusCode = 302;
          res.setHeader('location', '/ok');
          res.end();
          return;
        case '/file':
          res.statusCode = 302;
          res.setHeader('location', 'file:///etc/passwd');
          res.end();
          return;
        case '/loop':
          res.statusCode = 302;
          res.setHeader('location', '/loop');
          res.end();
          return;
        case '/big':
          res.end(big);
          return;
        default:
          res.statusCode = 404;
          res.end();
      }
    });
    const p = (path: string, contains?: string) =>
      httpProbe({ url: base + path, expectStatusMin: 200, expectStatusMax: 399, contains });
    expect(await p('/ok')).toMatchObject({ ok: true, code: 200 });
    expect(await p('/ok', 'world')).toMatchObject({ ok: true });
    expect(await p('/ok', 'mars')).toMatchObject({ ok: false, error: 'Erwarteter Text fehlt' });
    const r503 = await p('/503');
    expect(r503).toMatchObject({ ok: false, code: 503, error: 'HTTP 503' });
    expect(JSON.stringify(r503)).not.toContain('secret body');
    expect(await p('/hop', 'hello')).toMatchObject({ ok: true, code: 200 });
    expect(await p('/file')).toMatchObject({ ok: false, error: 'Ungültige Weiterleitung' });
    expect(await p('/loop')).toMatchObject({ ok: false, error: 'Zu viele Weiterleitungen' });
    // Only the first 1 MB is read: the needle behind it is not found.
    expect(await p('/big', 'NEEDLE')).toMatchObject({ ok: false, error: 'Erwarteter Text fehlt' });
    expect(await p('/big', 'aaaa')).toMatchObject({ ok: true });
  });

  it('HTTP: timeout and refused connections give fixed reasons', async () => {
    const base = await serve(() => {
      // never answers
    });
    expect(
      await httpProbe({
        url: `${base}/`,
        expectStatusMin: 200,
        expectStatusMax: 399,
        timeoutMs: 1000,
      }),
    ).toMatchObject({ ok: false, ms: null, error: 'Timeout nach 1 s' });
  });

  it('TCP: connect and refused', async () => {
    const base = await serve((_q, r) => r.end());
    const port = Number(new URL(base).port);
    expect(await tcpProbe('127.0.0.1', port)).toMatchObject({ ok: true });
    const s = servers.pop();
    s?.closeAllConnections();
    await new Promise((r) => s?.close(r));
    expect(await tcpProbe('127.0.0.1', port)).toMatchObject({
      ok: false,
      error: 'Verbindung abgelehnt',
    });
  });

  let hasOpenssl = true;
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    hasOpenssl = false;
  }
  it.skipIf(!hasOpenssl)('HTTPS: a self-signed certificate fails as invalid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hz-tls-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-days',
        '3',
        '-subj',
        '/CN=127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    const s = https.createServer(
      { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) },
      (_q, r) => r.end('ok'),
    );
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    expect(
      await httpProbe({
        url: `https://127.0.0.1:${port}/`,
        expectStatusMin: 200,
        expectStatusMax: 399,
      }),
    ).toMatchObject({ ok: false, error: 'SSL-Zertifikat ungültig' });
  });
});

describe('check routes', () => {
  it('create applies defaults, list, update resets, delete removes and closes alerts; all audited', async () => {
    const { t, headers } = await admin();
    const base = await serve((_q, r) => r.end('ok'));
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/checks',
      headers,
      payload: { kind: 'http', name: 'shop', url: `${base}/` },
    });
    expect(created.statusCode).toBe(200);
    const check = checkResponseSchema.parse(created.json()).check;
    expect(check).toMatchObject({
      status: 'busy',
      uptime24h: null,
      spark: [],
      def: {
        kind: 'http',
        runFrom: 'core',
        intervalS: 60,
        enabled: true,
        expectStatusMin: 200,
        expectStatusMax: 399,
        certCheck: true,
        serverId: null,
      },
    });
    expect(t.app.hzCore.scheduler.has(`check:${check.id}`)).toBe(true);

    await step(t);
    const list = await t.app.inject({ url: '/api/checks', headers });
    const listed = checkListResponseSchema.parse(list.json()).checks;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ status: 'ok', lastCode: 200, uptime24h: 100 });
    expect(listed[0]?.spark).toHaveLength(1);

    // An open alert of the check is closed (not "recovered") when the check changes.
    t.app.hzCore.alerts.raise(`check:${check.id}:down`, 'crit', 'x', 'y', null, 'check');
    const put = await t.app.inject({
      method: 'PUT',
      url: `/api/checks/${check.id}`,
      headers,
      payload: {
        kind: 'tcp',
        name: 'shop-tcp',
        host: '127.0.0.1',
        port: 1,
        intervalS: 120,
        enabled: false,
      },
    });
    expect(put.statusCode).toBe(200);
    expect(checkResponseSchema.parse(put.json()).check).toMatchObject({
      status: 'off',
      reason: null,
      def: { kind: 'tcp', name: 'shop-tcp', intervalS: 120, enabled: false },
    });
    expect(t.app.hzCore.alerts.active(`check:${check.id}:down`)).toBeNull();
    expect(t.app.hzCore.scheduler.has(`check:${check.id}`)).toBe(false);

    const del = await t.app.inject({ method: 'DELETE', url: `/api/checks/${check.id}`, headers });
    expect(del.json()).toEqual({ ok: true });
    expect(t.app.hzCore.checks.list()).toEqual([]);
    expect(t.db.db.select().from(checkResults).all()).toEqual([]);
    const again = await t.app.inject({ method: 'DELETE', url: `/api/checks/${check.id}`, headers });
    expect(again.statusCode).toBe(404);

    const actions = t.db.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.action.startsWith('check.'))
      .map((a) => a.action);
    expect(actions).toEqual(['check.created', 'check.updated', 'check.deleted']);
  });

  it('rejects invalid definitions with 400', async () => {
    const { t, headers } = await admin();
    const bad: unknown[] = [
      { kind: 'http', name: 'x', url: 'ftp://example.com/' },
      { kind: 'http', name: 'x', url: 'https://user:pw@example.com/' },
      {
        kind: 'http',
        name: 'x',
        url: 'https://example.com/',
        expectStatusMin: 400,
        expectStatusMax: 200,
      },
      { kind: 'http', name: 'x', url: 'https://example.com/', runFrom: 'unknown-agent-id' },
      { kind: 'http', name: 'x', url: 'https://example.com/', serverId: 'unknown-server' },
      { kind: 'http', name: 'x', url: 'https://example.com/', extra: 1 },
      { kind: 'ping', name: 'x', host: '1.1.1.1', runFrom: 'core' },
      { kind: 'tcp', name: 'x', host: 'a b', port: 22 },
      { kind: 'tcp', name: 'x', host: 'h', port: 70000 },
      { kind: 'http', name: '', url: 'https://example.com/' },
      { kind: 'http', name: 'x', url: 'https://example.com/', intervalS: 5 },
      { kind: 'dns', name: 'x' },
    ];
    for (const payload of bad) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/checks',
        headers,
        payload: payload as object,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(t.app.hzCore.checks.list()).toEqual([]);
    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/checks/doesnotexist1',
      headers,
      payload: { kind: 'tcp', name: 'x', host: 'h', port: 1 },
    });
    expect(put.statusCode).toBe(404);
  });

  it('POST /run runs now and returns the fresh summary; history by range', async () => {
    const { t, headers } = await admin();
    let code = 200;
    const base = await serve((_q, r) => {
      r.statusCode = code;
      r.end();
    });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/checks',
      headers,
      payload: { kind: 'http', name: 'api', url: `${base}/`, certCheck: false },
    });
    const id = checkResponseSchema.parse(res.json()).check.id;
    code = 500;
    const run = await t.app.inject({ method: 'POST', url: `/api/checks/${id}/run`, headers });
    expect(run.statusCode).toBe(200);
    expect(checkResponseSchema.parse(run.json()).check).toMatchObject({
      status: 'warn',
      lastCode: 500,
      consecutiveFailures: 1,
      reason: 'HTTP 500 · wird erneut geprüft',
    });

    // Synthetic history: one result per hour over 10 days, every 10th fails.
    const now = t.clock.t;
    const rows = Array.from({ length: 240 }, (_, i) => ({
      checkId: id,
      ts: now - (i + 1) * 3_600_000,
      ok: i % 10 !== 0,
      code: 200,
      ms: 100 + i,
      error: null,
    }));
    t.db.db.insert(checkResults).values(rows).run();
    const get = async (range: string) =>
      checkHistoryResponseSchema.parse(
        (await t.app.inject({ url: `/api/checks/${id}/history?range=${range}`, headers })).json(),
      ).points;
    const day = await get('24h');
    expect(day.length).toBe(24 + 1);
    expect(day.at(-1)).toMatchObject({ ok: false, code: 500 });
    const week = await get('7d');
    expect(week.length).toBeGreaterThanOrEqual(168);
    expect(week.length).toBeLessThanOrEqual(170);
    const month = await get('30d');
    expect(month.length).toBeLessThanOrEqual(41);
    expect(month.some((p) => !p.ok)).toBe(true);
    expect((await t.app.inject({ url: `/api/checks/${id}/history`, headers })).statusCode).toBe(
      200,
    );

    const s = t.app.hzCore.checks.summary(id);
    expect(s?.uptime7d).toBeGreaterThan(80);
    expect(s?.uptime7d).toBeLessThan(100);

    // Retention: 30 days of raw results.
    t.db.db
      .insert(checkResults)
      .values({ checkId: id, ts: now - 31 * DAY, ok: true })
      .run();
    t.app.hzCore.checks.prune();
    const oldest = Math.min(
      ...t.db.db
        .select()
        .from(checkResults)
        .all()
        .map((r) => r.ts),
    );
    expect(oldest).toBeGreaterThanOrEqual(now - 30 * DAY);
  });

  it('live topic `checks`: snapshot, then upserts and removals', async () => {
    const { t, headers, cookie } = await admin();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
    const ws = await WsClient.connect(`${url}/live`, {
      cookie: `hz_session=${cookie}`,
      origin: url.replace('ws://', 'http://'),
    });
    clients.push(ws);
    ws.send({ type: 'subscribe', topics: ['checks'] });
    const snap = liveServerMessageSchema.parse(await ws.nextOfType('snapshot'));
    expect(snap).toMatchObject({ topic: 'checks', data: [] });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/checks',
      headers,
      payload: { kind: 'tcp', name: 'mc', host: '127.0.0.1', port: 1 },
    });
    const id = checkResponseSchema.parse(res.json()).check.id;
    const up = (await ws.next((m: Received) => m.type === 'update')) as { upsert?: unknown[] };
    expect(checkSummarySchema.parse(up.upsert?.[0]).id).toBe(id);
    await t.app.inject({ method: 'DELETE', url: `/api/checks/${id}`, headers });
    const rm = await ws.next((m: Received) => m.type === 'update' && Array.isArray(m.remove));
    expect(rm.remove).toEqual([id]);
  });
});

describe('checks from an agent', () => {
  it('sends check.http to the agent; slow and SSL warn/crit alerts from its results', async () => {
    let result: Record<string, unknown> = { ok: true, code: 200, ms: 1200 };
    const s = await withAgent(clients, {
      reply: (rpc) =>
        typeof rpc.action === 'string' && rpc.action.startsWith('check.')
          ? { type: 'rpc.result', id: rpc.id, ok: true, data: result }
          : null,
    });
    t = s.t;
    const headers = authHeaders(s.cookie);
    result = { ...result, tlsExpiresAt: new Date(s.t.clock.t + 3 * DAY + 3_600_000).toISOString() };
    const res = await s.t.app.inject({
      method: 'POST',
      url: '/api/checks',
      headers,
      payload: {
        kind: 'http',
        name: 'sc-ball.at',
        url: 'https://sc-ball.at/',
        runFrom: s.serverId,
      },
    });
    expect(res.statusCode).toBe(200);
    const id = checkResponseSchema.parse(res.json()).check.id;
    await step(s.t);
    const rpc = s.rpcs.find((r) => r.action === 'check.http');
    expect(rpc?.params).toEqual({
      url: 'https://sc-ball.at/',
      method: 'GET',
      expectStatusMin: 200,
      expectStatusMax: 399,
      timeoutMs: 10_000,
    });
    const first = s.t.app.hzCore.checks.summary(id);
    expect(first).toMatchObject({ status: 'crit', reason: 'SSL läuft in 3 Tagen ab' });
    expect(first?.sslExpiresAt).not.toBeNull();
    const ssl = s.t.app.hzCore.alerts.active(`check:${id}:ssl`);
    expect(ssl).toMatchObject({
      level: 'crit',
      title: 'SSL-Zertifikat von sc-ball.at läuft ab',
      serverId: s.serverId,
    });
    expect(s.t.app.hzCore.alerts.active(`check:${id}:slow`)).toBeNull();

    s.t.clock.advance(60_000);
    await step(s.t);
    expect(s.t.app.hzCore.alerts.active(`check:${id}:slow`)).toMatchObject({
      level: 'warn',
      title: 'sc-ball.at antwortet langsam',
    });

    // Certificate renewed and fast again: both resolve with OK entries.
    result = {
      ok: true,
      code: 200,
      ms: 90,
      tlsExpiresAt: new Date(s.t.clock.t + 80 * DAY).toISOString(),
    };
    s.t.clock.advance(60_000);
    await step(s.t);
    expect(s.t.app.hzCore.checks.summary(id)).toMatchObject({ status: 'ok', reason: null });
    expect(s.t.app.hzCore.alerts.active(`check:${id}:ssl`)).toBeNull();
    expect(s.t.app.hzCore.alerts.active(`check:${id}:slow`)).toBeNull();
    const titles = s.t.app.hzCore.alerts
      .list({ state: 'all', limit: 20, source: 'check' })
      .filter((a) => a.level === 'ok')
      .map((a) => a.title)
      .sort();
    expect(titles).toEqual([
      'SSL-Zertifikat von sc-ball.at erneuert',
      'sc-ball.at antwortet wieder schnell',
    ]);
  });

  it('ping and tcp go to the agent; failures count; invalid data and offline agent are off, not crit', async () => {
    let result: unknown = { ok: false, ms: null, error: 'no reply' };
    const s = await withAgent(clients, {
      reply: (rpc) =>
        typeof rpc.action === 'string' && rpc.action.startsWith('check.')
          ? { type: 'rpc.result', id: rpc.id, ok: true, data: result }
          : null,
    });
    t = s.t;
    const headers = authHeaders(s.cookie);
    const res = await s.t.app.inject({
      method: 'POST',
      url: '/api/checks',
      headers,
      payload: { kind: 'ping', name: 'router', host: '192.168.1.1', runFrom: s.serverId },
    });
    const id = checkResponseSchema.parse(res.json()).check.id;
    await step(s.t);
    s.t.clock.advance(60_000);
    await step(s.t);
    expect(s.rpcs.find((r) => r.action === 'check.ping')?.params).toEqual({
      host: '192.168.1.1',
      count: 3,
      timeoutMs: 10_000,
    });
    expect(s.t.app.hzCore.checks.summary(id)).toMatchObject({
      status: 'crit',
      reason: 'Keine Antwort auf Ping',
    });
    const down = s.t.app.hzCore.alerts.active(`check:${id}:down`);
    expect(down?.title).toBe('router ist nicht erreichbar');
    expect(down?.body).toContain('Geprüft von heimserver aus.');

    result = { nonsense: true };
    s.t.clock.advance(60_000);
    await step(s.t);
    expect(s.t.app.hzCore.checks.summary(id)).toMatchObject({
      status: 'off',
      reason: 'Antwort des Agents ungültig',
    });

    // Agent goes away: off with "Agent offline", the crit alert stays as it was, no new result.
    const before = s.t.db.db.select().from(checkResults).all().length;
    s.agent.ws.terminate();
    await until(() => !s.t.app.hzCore.hub.isConnected(s.serverId));
    s.t.clock.advance(60_000);
    await step(s.t);
    expect(s.t.app.hzCore.checks.summary(id)).toMatchObject({
      status: 'off',
      reason: 'Agent offline',
    });
    expect(s.t.db.db.select().from(checkResults).all().length).toBe(before);
    expect(s.t.app.hzCore.alerts.active(`check:${id}:down`)?.id).toBe(down?.id);
  });
});

describe('RDAP domain expiry', () => {
  it('runs on create and daily at 04:00 Vienna; warns < 30 days; skips IPs and tailnet names', async () => {
    const calls: string[] = [];
    let expiry = Date.UTC(2026, 11, 15);
    t = await makeApp({
      rdapFetch: (url) => {
        calls.push(url);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              events: [{ eventAction: 'expiration', eventDate: new Date(expiry).toISOString() }],
            }),
            { status: 200 },
          ),
        );
      },
    });
    const a = await completeSetup(t);
    const headers = authHeaders(a.cookie);
    const core = t.app.hzCore;
    // Registered at build time (T0, 13:00 Vienna): next is tomorrow 04:00 Vienna.
    expect(core.scheduler.nextRunOf('checks.rdap')).toBe(nextWallClock(T0, { hour: 4, minute: 0 }));
    expect(new Date(nextWallClock(T0, { hour: 4, minute: 0 })).toISOString()).toBe(
      '2026-11-26T03:00:00.000Z',
    );
    // The scheduler is not ticked here, so no probe reaches these hosts.
    const app = t.app;
    const mk = async (name: string, url: string) => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/checks',
        headers,
        payload: { kind: 'http', name, url },
      });
      return checkResponseSchema.parse(r.json()).check.id;
    };
    const id = await mk('shop', 'https://shop.sc-ball.at/');
    await mk('ip', 'https://100.64.0.5/');
    await mk('tailnet', 'https://heimserver.tail1234.ts.net/');
    await core.checks.idle();
    expect(calls).toEqual(['https://rdap.org/domain/sc-ball.at']);
    expect(core.checks.summary(id)?.domainExpiresAt).toBe(new Date(expiry).toISOString());
    expect(core.alerts.active(`check:${id}:domain`)).toMatchObject({
      level: 'warn',
      title: 'Domain von shop läuft ab',
    });

    // Daily refresh: renewed domain resolves the warning.
    expiry = Date.UTC(2027, 11, 15);
    await core.checks.refreshDomains();
    expect(calls).toHaveLength(2);
    expect(core.alerts.active(`check:${id}:domain`)).toBeNull();
    expect(core.checks.summary(id)?.domainExpiresAt).toBe(new Date(expiry).toISOString());
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { dnsFilterStatusSchema, integrationSettingsSchema } from '@hz/shared';
import { auditLog } from '../src/db/schema.js';
import {
  FakeServer,
  json,
  SENTINEL,
  withIntegrations,
  type IntegrationSetup,
} from './integrations-helpers.js';

let s: IntegrationSetup | undefined;
const fakes: FakeServer[] = [];
afterEach(async () => {
  await s?.t.app.close();
  s = undefined;
  for (const f of fakes.splice(0)) await f.stop();
});

/** Pi-hole v6: POST /api/auth -> sid; X-FTL-SID on every call; blocking with timer. */
class FakePihole {
  readonly server = new FakeServer();
  sids = new Set<string>();
  blocking: 'enabled' | 'disabled' = 'enabled';
  timer: number | null = null;
  auths = 0;

  constructor() {
    fakes.push(this.server);
    this.server.handler = (q, r) => {
      if (q.method === 'POST' && q.url === '/api/auth') {
        const body = JSON.parse(q.body) as { password?: string };
        if (body.password !== SENTINEL) {
          json(r, 401, { session: { valid: false, sid: null } });
          return;
        }
        this.auths++;
        const sid = `sid-${this.auths}-abcdefghijkl`;
        this.sids.add(sid);
        json(r, 200, { session: { valid: true, sid, validity: 1800 } });
        return;
      }
      const sid = q.headers['x-ftl-sid'];
      if (typeof sid !== 'string' || !this.sids.has(sid)) {
        json(r, 401, { error: { key: 'unauthorized' } });
        return;
      }
      if (q.method === 'GET' && q.url === '/api/stats/summary') {
        json(r, 200, {
          queries: { total: 12345, blocked: 2345, percent_blocked: 18.996 },
          gravity: { domains_being_blocked: 150000 },
        });
        return;
      }
      if (q.url === '/api/dns/blocking') {
        if (q.method === 'POST') {
          const b = JSON.parse(q.body) as { blocking: boolean; timer?: number };
          this.blocking = b.blocking ? 'enabled' : 'disabled';
          this.timer = b.blocking ? null : (b.timer ?? null);
        }
        json(r, 200, { blocking: this.blocking, timer: this.timer });
        return;
      }
      json(r, 404, {});
    };
  }
}

/** AdGuard Home: Basic auth on every call. */
class FakeAdguard {
  readonly server = new FakeServer();
  enabled = true;
  duration = 0;
  constructor() {
    fakes.push(this.server);
    const expected = `Basic ${Buffer.from(`admin:${SENTINEL}`).toString('base64')}`;
    this.server.handler = (q, r) => {
      if (q.headers.authorization !== expected) {
        r.statusCode = 401;
        r.end();
        return;
      }
      if (q.url === '/control/stats') {
        json(r, 200, { num_dns_queries: 1000, num_blocked_filtering: 250 });
      } else if (q.url === '/control/status') {
        json(r, 200, {
          protection_enabled: this.enabled,
          ...(this.enabled ? {} : { protection_disabled_duration: this.duration }),
        });
      } else if (q.url === '/control/filtering/status') {
        json(r, 200, {
          filters: [
            { rules_count: 50000, enabled: true },
            { rules_count: 7, enabled: true },
            { rules_count: 999, enabled: false },
          ],
        });
      } else if (q.url === '/control/protection' && q.method === 'POST') {
        const b = JSON.parse(q.body) as { enabled: boolean; duration?: number };
        this.enabled = b.enabled;
        this.duration = b.duration ?? 0;
        r.end('OK');
      } else {
        json(r, 404, {});
      }
    };
  }
}

describe('Pi-hole v6', () => {
  it('statistics, pause for 15 min with end, resume; sid cached and renewed on 401', async () => {
    const pi = new FakePihole();
    await pi.server.start();
    s = await withIntegrations();
    const put = await s.configure('dnsfilter', {
      url: pi.server.url,
      secret: SENTINEL,
      variant: 'pihole',
    });
    expect(integrationSettingsSchema.parse(put.json())).toMatchObject({
      variant: 'pihole',
      status: 'ok',
      username: null,
    });
    const st = dnsFilterStatusSchema.parse((await s.req('GET', '/api/dnsfilter/status')).json());
    expect(st).toMatchObject({
      variant: 'pihole',
      blocking: true,
      pausedUntil: null,
      queriesToday: 12345,
      blockedToday: 2345,
      percentBlocked: 19,
      domainsOnLists: 150000,
      error: null,
    });
    expect(pi.auths).toBe(1);

    const pause = await s.req('POST', '/api/dnsfilter/blocking', { enabled: false, minutes: 15 });
    expect(pause.statusCode).toBe(200);
    const paused = dnsFilterStatusSchema.parse(pause.json());
    expect(paused.blocking).toBe(false);
    expect(Date.parse(paused.pausedUntil ?? '') - s.t.clock.t).toBe(15 * 60_000);
    const post = pi.server.requests.find(
      (r) => r.method === 'POST' && r.url === '/api/dns/blocking',
    );
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ blocking: false, timer: 900 });

    // Session expired on the Pi-hole side: one new auth, then the call goes through.
    pi.sids.clear();
    const resume = await s.req('POST', '/api/dnsfilter/blocking', { enabled: true });
    expect(dnsFilterStatusSchema.parse(resume.json()).blocking).toBe(true);
    expect(pi.auths).toBe(2);
    expect(pi.blocking).toBe('enabled');
    // The password only went in the auth body, the sid only in the header.
    for (const r of pi.server.requests) {
      if (r.url !== '/api/auth') expect(r.body).not.toContain(SENTINEL);
      expect(r.url).not.toContain('sid');
    }
    const audits = s.t.db.db
      .select()
      .from(auditLog)
      .all()
      .filter((r) => r.action === 'dnsfilter.blocking');
    expect(audits.map((a) => JSON.parse(a.detailsJson ?? '{}'))).toEqual([
      { enabled: false, minutes: 15 },
      { enabled: true },
    ]);
  });

  it('wrong password: status error', async () => {
    const pi = new FakePihole();
    await pi.server.start();
    s = await withIntegrations();
    const put = await s.configure('dnsfilter', { url: pi.server.url, secret: 'wrong-password' });
    expect(integrationSettingsSchema.parse(put.json())).toMatchObject({
      status: 'error',
      error: 'Zugangsdaten ungültig',
    });
  });
});

describe('AdGuard Home', () => {
  it('statistics, pause for 5 min, resume', async () => {
    const ag = new FakeAdguard();
    await ag.server.start();
    s = await withIntegrations();
    const put = await s.configure('dnsfilter', {
      url: ag.server.url,
      username: 'admin',
      secret: SENTINEL,
      variant: 'adguard',
    });
    expect(integrationSettingsSchema.parse(put.json())).toMatchObject({
      status: 'ok',
      variant: 'adguard',
    });
    const st = dnsFilterStatusSchema.parse((await s.req('GET', '/api/dnsfilter/status')).json());
    expect(st).toMatchObject({
      variant: 'adguard',
      blocking: true,
      queriesToday: 1000,
      blockedToday: 250,
      percentBlocked: 25,
      domainsOnLists: 50007,
    });
    const pause = await s.req('POST', '/api/dnsfilter/blocking', { enabled: false, minutes: 5 });
    const paused = dnsFilterStatusSchema.parse(pause.json());
    expect(paused.blocking).toBe(false);
    expect(ag.duration).toBe(5 * 60_000);
    expect(Date.parse(paused.pausedUntil ?? '') - s.t.clock.t).toBe(5 * 60_000);
    const resume = await s.req('POST', '/api/dnsfilter/blocking', { enabled: true });
    expect(dnsFilterStatusSchema.parse(resume.json())).toMatchObject({
      blocking: true,
      pausedUntil: null,
    });
  });

  it('AdGuard without user name stays off', async () => {
    const ag = new FakeAdguard();
    await ag.server.start();
    s = await withIntegrations();
    const put = await s.configure('dnsfilter', {
      url: ag.server.url,
      secret: SENTINEL,
      variant: 'adguard',
    });
    expect(integrationSettingsSchema.parse(put.json()).status).toBe('off');
    expect(ag.server.requests).toHaveLength(0);
    const res = await s.req('POST', '/api/dnsfilter/blocking', { enabled: true });
    expect(res.statusCode).toBe(409);
  });
});

describe('DNS filter input', () => {
  it('a pause without end or with other lengths is refused; no step-up needed', async () => {
    const pi = new FakePihole();
    await pi.server.start();
    s = await withIntegrations();
    await s.configure('dnsfilter', { url: pi.server.url, secret: SENTINEL });
    s.expireStepUp();
    for (const body of [
      { enabled: false },
      { enabled: false, minutes: 0 },
      { enabled: false, minutes: 120 },
      {},
    ]) {
      const res = await s.req('POST', '/api/dnsfilter/blocking', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(
      pi.server.requests.some((r) => r.method === 'POST' && r.url === '/api/dns/blocking'),
    ).toBe(false);
    const ok = await s.req('POST', '/api/dnsfilter/blocking', { enabled: false, minutes: 60 });
    expect(ok.statusCode).toBe(200);
  });
});

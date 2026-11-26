import { X509Certificate } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  Certificate,
  DnsProvider,
  DnsRecord,
  DomainsResponse,
  ErrorResponse,
} from '@hz/shared';
import { certificates, dnsRecords } from '../src/db/schema.js';
import { nextWallClock } from '../src/calendar.js';
import {
  connectAgent,
  enrollAgent,
  inventoryMsg,
  listen,
  until,
  withStepUp,
  type WsClient,
} from './agent-helpers.js';
import {
  CF_TOKEN,
  CF_TOKEN_2,
  DUCK_TOKEN,
  makeDomainsApp,
  type DomainsTestApp,
} from './domains-helpers.js';
import { authHeaders, completeSetup, login, sessionCookie, totpCode } from './helpers.js';

let t: DomainsTestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

const DAY = 86_400_000;

async function setup(opts: Parameters<typeof makeDomainsApp>[0] = {}) {
  t = await makeDomainsApp(opts);
  const { cookie, secret } = await completeSetup(t);
  return { t, cookie, secret, h: authHeaders(cookie) };
}

type T = DomainsTestApp;

function req(
  tt: T,
  h: Record<string, string>,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return tt.app.inject({
    method,
    url,
    headers: h,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function addCloudflare(tt: T, h: Record<string, string>): Promise<DnsProvider> {
  const res = await withStepUp(tt, () =>
    req(tt, h, 'POST', '/api/domains/providers', {
      kind: 'cloudflare',
      label: 'Cloudflare',
      token: CF_TOKEN,
    }),
  );
  expect(res.statusCode).toBe(201);
  return res.json<DnsProvider>();
}

async function addDuck(tt: T, h: Record<string, string>): Promise<DnsProvider> {
  const res = await withStepUp(tt, () =>
    req(tt, h, 'POST', '/api/domains/providers', {
      kind: 'duckdns',
      label: 'DuckDNS',
      token: DUCK_TOKEN,
      subdomains: ['meinheim'],
    }),
  );
  expect(res.statusCode).toBe(201);
  return res.json<DnsProvider>();
}

interface Rpc {
  action: string;
  params: unknown;
}

/** Answers cert.write / cert.remove like the real agent. */
function answerRpcs(agent: WsClient, rpcs: Rpc[]): void {
  const handle = (raw: unknown): void => {
    const m = raw as { type: string; id: string; action: string; params: unknown };
    if (m.type !== 'rpc') return;
    rpcs.push({ action: m.action, params: m.params });
    if (m.action === 'cert.write' || m.action === 'cert.remove') {
      agent.send({
        type: 'rpc.result',
        id: m.id,
        ok: true,
        data: m.action === 'cert.write' ? { path: '/opt/homelab/certs/x/' } : {},
      });
    }
  };
  // Messages that arrived before the listener (right after welcome).
  for (const m of agent.received) handle(m);
  agent.ws.on('message', (data) => handle(JSON.parse(String(data))));
}

/** Sim agent that answers cert.write / cert.remove and reports `publicIp`. */
async function simServer(tt: T, cookie: string, name: string, publicIp: string | undefined) {
  const url = tt.app.server.listening ? null : await listen(tt);
  const base = url ?? `ws://127.0.0.1:${(tt.app.server.address() as { port: number }).port}`;
  const { agent, serverId, agentToken } = await enrollAgent(tt, base, cookie, name);
  const rpcs: Rpc[] = [];
  answerRpcs(agent, rpcs);
  await sendIp(tt, agent, serverId, publicIp);
  return { agent, serverId, agentToken, url: base, name, rpcs };
}

async function sendIp(tt: T, agent: WsClient, serverId: string, ip: string | undefined) {
  const inv = inventoryMsg();
  agent.send({ ...inv, system: { ...inv.system, ...(ip ? { publicIp: ip } : {}) } });
  await until(() => (tt.app.hzCore.servers.row(serverId)?.publicIp ?? undefined) === ip);
}

const service = (tt: T) => tt.app.hzCore.features.domains.service;
const idle = (tt: T) => tt.app.hzCore.features.domains.idle();

async function minuteTick(tt: T): Promise<void> {
  tt.clock.advance(60_000);
  await tt.app.hzCore.scheduler.tick();
  await idle(tt);
}

describe('domains: providers', () => {
  it('creates, tests, updates and deletes providers; GET reads them back', async () => {
    const { t, h } = await setup();
    const cf = await addCloudflare(t, h);
    expect(cf).toMatchObject({
      kind: 'cloudflare',
      tokenHint: CF_TOKEN.slice(-4),
      zones: ['example.com', 'other.org'],
      lastError: null,
    });
    const duck = await addDuck(t, h);
    expect(duck.zones).toEqual(['meinheim.duckdns.org']);
    // The DuckDNS check only clears the TXT value, never an address.
    const check = t.world.duck.updates.at(-1);
    expect(check?.get('clear')).toBe('true');
    expect(check?.has('ip')).toBe(false);

    const test = await req(t, h, 'POST', `/api/domains/providers/${cf.id}/test`);
    expect(test.json()).toEqual({ ok: true, zones: ['example.com', 'other.org'], error: null });

    t.world.cf.tokens.delete(CF_TOKEN);
    const bad = await req(t, h, 'POST', `/api/domains/providers/${cf.id}/test`);
    expect(bad.json()).toMatchObject({ ok: false, error: 'Token ungültig oder ohne Berechtigung' });

    const upd = await withStepUp(t, () =>
      req(t, h, 'PUT', `/api/domains/providers/${cf.id}`, { token: CF_TOKEN_2, label: 'CF neu' }),
    );
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ label: 'CF neu', tokenHint: CF_TOKEN_2.slice(-4) });

    const list = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>();
    expect(list.providers.map((p) => p.id).sort()).toEqual([cf.id, duck.id].sort());
    expect(list.settings).toEqual({ acmeEmail: null });

    const del = await withStepUp(t, () => req(t, h, 'DELETE', `/api/domains/providers/${duck.id}`));
    expect(del.statusCode).toBe(204);
  });

  it('refuses a token the provider rejects and invalid input', async () => {
    const { t, h } = await setup();
    const res = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/providers', {
        kind: 'cloudflare',
        label: 'CF',
        token: ['wrong', 'token', 'value', '0123456789'].join('_'),
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorResponse>().error).toBe('invalid_input');
    const dk = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/providers', {
        kind: 'duckdns',
        label: 'Duck',
        token: DUCK_TOKEN,
        subdomains: ['nichtmeins'],
      }),
    );
    expect(dk.statusCode).toBe(400);
    for (const payload of [
      { kind: 'route53', label: 'x', token: CF_TOKEN },
      { kind: 'cloudflare', label: 'x', token: 'short' },
      { kind: 'cloudflare', label: 'x', token: CF_TOKEN, extra: 1 },
      { kind: 'duckdns', label: 'x', token: DUCK_TOKEN, subdomains: ['Bad_Name'] },
    ]) {
      const r = await withStepUp(t, () => req(t, h, 'POST', '/api/domains/providers', payload));
      expect(r.statusCode).toBe(400);
    }
    expect((await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().providers).toEqual([]);
  });

  it('a provider in use cannot be deleted (409)', async () => {
    const { t, h } = await setup();
    const cf = await addCloudflare(t, h);
    const rec = await req(t, h, 'POST', '/api/domains/records', {
      providerId: cf.id,
      name: 'www.example.com',
      type: 'A',
      target: { kind: 'static', value: '203.0.113.7' },
    });
    expect(rec.statusCode).toBe(201);
    const del = await withStepUp(t, () => req(t, h, 'DELETE', `/api/domains/providers/${cf.id}`));
    expect(del.statusCode).toBe(409);
  });
});

describe('domains: records', () => {
  it('a DuckDNS record follows the public IP of a sim server', async () => {
    const { t, h, cookie } = await setup();
    const duck = await addDuck(t, h);
    const sim = await simServer(t, cookie, 'oracle-a1', '203.0.113.10');
    const res = await req(t, h, 'POST', '/api/domains/records', {
      providerId: duck.id,
      name: 'meinheim.duckdns.org',
      type: 'A',
      target: { kind: 'server', serverId: sim.serverId },
    });
    expect(res.statusCode).toBe(201);
    const rec = res.json<DnsRecord>();
    expect(rec).toMatchObject({ status: 'ok', value: '203.0.113.10', owner: 'admin' });
    expect(t.world.duck.subs.get('meinheim')?.ip).toBe('203.0.113.10');

    // Nothing changed: the minute job does not call DuckDNS.
    const before = t.world.duck.updates.length;
    await minuteTick(t);
    expect(t.world.duck.updates.length).toBe(before);

    // The IP changes: within the next minute the record follows.
    await sendIp(t, sim.agent, sim.serverId, '203.0.113.99');
    await minuteTick(t);
    expect(t.world.duck.subs.get('meinheim')?.ip).toBe('203.0.113.99');
    const after = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().records[0];
    expect(after).toMatchObject({ value: '203.0.113.99', status: 'ok' });

    // At most one push per minute and record.
    await sendIp(t, sim.agent, sim.serverId, '203.0.113.100');
    t.clock.advance(60_000);
    await service(t).syncAll();
    expect(t.world.duck.subs.get('meinheim')?.ip).toBe('203.0.113.100');
    await sendIp(t, sim.agent, sim.serverId, '203.0.113.101');
    t.clock.advance(10_000);
    await service(t).syncAll();
    expect(t.world.duck.subs.get('meinheim')?.ip).toBe('203.0.113.100');
    t.clock.advance(60_000);
    await service(t).syncAll();
    expect(t.world.duck.subs.get('meinheim')?.ip).toBe('203.0.113.101');

    // Delete clears it at DuckDNS too.
    const del = await req(t, h, 'DELETE', `/api/domains/records/${rec.id}`);
    expect(del.statusCode).toBe(204);
    expect(t.world.duck.subs.get('meinheim')?.ip).toBeNull();
    sim.agent.close();
  });

  it('AAAA needs an IPv6 from the inventory; no public IP is an error with a warn alert', async () => {
    const { t, h, cookie } = await setup();
    const duck = await addDuck(t, h);
    const sim = await simServer(t, cookie, 'heimserver', '203.0.113.10');
    const res = await req(t, h, 'POST', '/api/domains/records', {
      providerId: duck.id,
      name: 'meinheim.duckdns.org',
      type: 'AAAA',
      target: { kind: 'server', serverId: sim.serverId },
    });
    expect(res.statusCode).toBe(201);
    const rec = res.json<DnsRecord>();
    expect(rec).toMatchObject({
      status: 'error',
      lastError: 'Server meldet keine öffentliche IPv6',
    });
    expect(t.app.hzCore.alerts.active(`dns:${rec.id}`)?.level).toBe('warn');

    await sendIp(t, sim.agent, sim.serverId, '2001:db8::10');
    await minuteTick(t);
    expect(t.world.duck.subs.get('meinheim')?.ipv6).toBe('2001:db8::10');
    expect(t.app.hzCore.alerts.active(`dns:${rec.id}`)).toBeNull();

    // A tailnet/private address is never published.
    await sendIp(t, sim.agent, sim.serverId, 'fd7a:115c:a1e0::5');
    await minuteTick(t);
    const r2 = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().records[0];
    expect(r2?.status).toBe('error');
    expect(t.world.duck.subs.get('meinheim')?.ipv6).toBe('2001:db8::10');
    sim.agent.close();
  });

  it('Cloudflare: create, update, sync, delete only touch the own record', async () => {
    const { t, h } = await setup();
    const cf = await addCloudflare(t, h);
    const foreign = t.world.cf.addForeign('mail.example.com', 'A', '198.51.100.1');
    const res = await req(t, h, 'POST', '/api/domains/records', {
      providerId: cf.id,
      name: 'app.example.com',
      type: 'A',
      target: { kind: 'static', value: '203.0.113.7' },
      ttl: 120,
    });
    expect(res.statusCode).toBe(201);
    const rec = res.json<DnsRecord>();
    expect(rec).toMatchObject({ status: 'ok', value: '203.0.113.7', ttl: 120, proxied: false });
    const atCf = [...t.world.cf.records.values()].find((r) => r.name === 'app.example.com');
    expect(atCf?.content).toBe('203.0.113.7');

    const upd = await req(t, h, 'PUT', `/api/domains/records/${rec.id}`, {
      target: { kind: 'static', value: '203.0.113.8' },
      proxied: true,
    });
    expect(upd.json()).toMatchObject({ value: '203.0.113.8', proxied: true, status: 'ok' });
    expect(t.world.cf.records.get(atCf?.id ?? '')?.content).toBe('203.0.113.8');

    // Somebody deletes it at Cloudflare: sync recreates it.
    t.world.cf.records.delete(atCf?.id ?? '');
    const sync = await req(t, h, 'POST', `/api/domains/records/${rec.id}/sync`);
    expect(sync.json()).toMatchObject({ status: 'ok' });
    expect([...t.world.cf.records.values()].some((r) => r.name === 'app.example.com')).toBe(true);

    const del = await req(t, h, 'DELETE', `/api/domains/records/${rec.id}`);
    expect(del.statusCode).toBe(204);
    expect([...t.world.cf.records.values()].some((r) => r.name === 'app.example.com')).toBe(false);
    expect(t.world.cf.records.get(foreign.id)?.content).toBe('198.51.100.1');

    const cname = await req(t, h, 'POST', '/api/domains/records', {
      providerId: cf.id,
      name: 'blog.example.com',
      type: 'CNAME',
      target: { kind: 'static', value: 'example.github.io' },
    });
    expect(cname.json()).toMatchObject({ status: 'ok', value: 'example.github.io' });
  });

  it('validates names, types and targets', async () => {
    const { t, h } = await setup();
    const cf = await addCloudflare(t, h);
    const duck = await addDuck(t, h);
    const bad = [
      {
        providerId: cf.id,
        name: 'x.fremd.net',
        type: 'A',
        target: { kind: 'static', value: '203.0.113.1' },
      },
      {
        providerId: cf.id,
        name: '*.example.com',
        type: 'A',
        target: { kind: 'static', value: '203.0.113.1' },
      },
      {
        providerId: cf.id,
        name: 'a.example.com',
        type: 'A',
        target: { kind: 'static', value: '2001:db8::1' },
      },
      {
        providerId: cf.id,
        name: 'a.example.com',
        type: 'CNAME',
        target: { kind: 'server', serverId: 'x' },
      },
      {
        providerId: cf.id,
        name: 'a.example.com',
        type: 'TXT',
        target: { kind: 'static', value: 'x' },
      },
      {
        providerId: cf.id,
        name: 'a.example.com',
        type: 'A',
        target: { kind: 'server', serverId: 'nope' },
      },
      {
        providerId: duck.id,
        name: 'sub.meinheim.duckdns.org',
        type: 'A',
        target: { kind: 'static', value: '203.0.113.1' },
      },
      {
        providerId: duck.id,
        name: 'meinheim.duckdns.org',
        type: 'CNAME',
        target: { kind: 'static', value: 'a.example.com' },
      },
      {
        providerId: duck.id,
        name: 'meinheim.duckdns.org',
        type: 'A',
        proxied: true,
        target: { kind: 'static', value: '203.0.113.1' },
      },
      {
        providerId: cf.id,
        name: 'a.example.com',
        type: 'A',
        target: { kind: 'static', value: '203.0.113.1' },
        extra: true,
      },
    ];
    for (const payload of bad) {
      const r = await req(t, h, 'POST', '/api/domains/records', payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(t.db.db.select().from(dnsRecords).all()).toEqual([]);
    const id = await req(t, h, 'PUT', '/api/domains/records/..%2Fx', { ttl: 300 });
    expect(id.statusCode).toBe(400);
    const missing = await req(t, h, 'PUT', '/api/domains/records/AAAAAAAAAAAA', { ttl: 300 });
    expect(missing.statusCode).toBe(404);
    const empty = await req(t, h, 'PUT', '/api/domains/records/AAAAAAAAAAAA', {});
    expect(empty.statusCode).toBe(400);
  });

  it('settings: acmeEmail is stored and read back', async () => {
    const { t, h } = await setup();
    const r = await req(t, h, 'PUT', '/api/domains/settings', { acmeEmail: 'admin@example.com' });
    expect(r.json()).toEqual({ acmeEmail: 'admin@example.com' });
    const bad = await req(t, h, 'PUT', '/api/domains/settings', { acmeEmail: 'nope' });
    expect(bad.statusCode).toBe(400);
    expect((await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().settings).toEqual({
      acmeEmail: 'admin@example.com',
    });
  });
});

describe('domains: relay interface (DomainService)', () => {
  it('ensureRecord / removeRecord manage relay records; the UI cannot change them', async () => {
    const { t, h, cookie } = await setup();
    const cf = await addCloudflare(t, h);
    const sim = await simServer(t, cookie, 'oracle-a1', '203.0.113.20');
    const svc = service(t);
    const rec = await svc.ensureRecord({
      ownerRef: 'game1',
      providerId: cf.id,
      name: 'mc.example.com',
      type: 'A',
      target: { kind: 'server', serverId: sim.serverId },
    });
    expect(rec).toMatchObject({ owner: 'relay', status: 'ok', value: '203.0.113.20' });
    // Idempotent.
    const again = await svc.ensureRecord({
      ownerRef: 'game1',
      providerId: cf.id,
      name: 'mc.example.com',
      type: 'A',
      target: { kind: 'server', serverId: sim.serverId },
    });
    expect(again.id).toBe(rec.id);

    const put = await req(t, h, 'PUT', `/api/domains/records/${rec.id}`, { ttl: 600 });
    expect(put.statusCode).toBe(403);
    const del = await req(t, h, 'DELETE', `/api/domains/records/${rec.id}`);
    expect(del.statusCode).toBe(403);

    // Rename: the old relay name goes away.
    const renamed = await svc.ensureRecord({
      ownerRef: 'game1',
      providerId: cf.id,
      name: 'minecraft.example.com',
      type: 'A',
      target: { kind: 'server', serverId: sim.serverId },
    });
    const names = [...t.world.cf.records.values()].map((r) => r.name);
    expect(names).toContain('minecraft.example.com');
    expect(names).not.toContain('mc.example.com');

    // A foreign name is refused.
    t.world.cf.addForeign('taken.example.com', 'A', '198.51.100.9');
    await expect(
      svc.ensureRecord({
        ownerRef: 'game2',
        providerId: cf.id,
        name: 'taken.example.com',
        type: 'A',
        target: { kind: 'server', serverId: sim.serverId },
      }),
    ).rejects.toMatchObject({ status: 409 });

    await svc.removeRecord('game1');
    expect(t.db.db.select().from(dnsRecords).all()).toEqual([]);
    expect([...t.world.cf.records.values()].map((r) => r.name)).toEqual(['taken.example.com']);
    expect(renamed.owner).toBe('relay');
    sim.agent.close();
  });
});

describe('domains: certificates', () => {
  async function issueSetup() {
    const s = await setup();
    const cf = await addCloudflare(s.t, s.h);
    const sim = await simServer(s.t, s.cookie, 'oracle-a1', '203.0.113.30');
    return { ...s, cf, sim };
  }

  it('issues against the fake ACME, deploys with cert.write and renews', async () => {
    const { t, h, cf, sim, secret } = await issueSetup();
    await req(t, h, 'PUT', '/api/domains/settings', { acmeEmail: 'admin@example.com' });
    const res = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: cf.id,
        names: ['example.com', '*.example.com'],
        deploy: [{ serverId: sim.serverId, name: 'example-com' }],
      }),
    );
    expect(res.statusCode).toBe(201);
    const created = res.json<Certificate>();
    expect(created.status).toBe('pending');
    await idle(t);

    const cert = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().certificates[0];
    expect(cert).toMatchObject({ status: 'valid', lastError: null, nextAttemptAt: null });
    expect(cert?.notAfter).toBe(Math.floor((t.clock.t + 90 * DAY) / 1000) * 1000);
    expect(cert?.deploy[0]).toMatchObject({
      serverId: sim.serverId,
      name: 'example-com',
      lastError: null,
    });
    expect(cert?.deploy[0]?.deployedAt).not.toBeNull();

    // CSR: valid signature, all names; openssl agrees when it is installed.
    expect(t.world.acme.csrs).toHaveLength(1);
    expect(t.world.acme.opensslResults.every((r) => r !== false)).toBe(true);
    expect(t.world.acme.verified).toBeGreaterThan(5);
    const acct = [...t.world.acme.accounts.values()][0];
    expect(acct?.contact).toEqual(['mailto:admin@example.com']);
    // TXT records were removed afterwards.
    expect([...t.world.cf.records.values()].filter((r) => r.type === 'TXT')).toEqual([]);

    const write = sim.rpcs.find((r) => r.action === 'cert.write');
    const params = write?.params as { name: string; fullchainPem: string; privkeyPem: string };
    expect(params.name).toBe('example-com');
    expect(params.privkeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    const x = new X509Certificate(params.fullchainPem);
    expect(x.subjectAltName).toBe('DNS:example.com, DNS:*.example.com');
    expect(
      x.checkPrivateKey(
        await import('node:crypto').then((c) => c.createPrivateKey(params.privkeyPem)),
      ),
    ).toBe(true);
    const firstKey = params.privkeyPem;

    // Renewal: daily at 04:00 once <= 30 days are left; new key, deployed again.
    t.world.acme.validityMs = 90 * DAY;
    const target = nextWallClock(t.clock.t + 61 * DAY, { hour: 4, minute: 0 });
    t.clock.t = target + 1000;
    // The agent stays alive across the jump (heartbeat) and the admin logs in again.
    await sendIp(t, sim.agent, sim.serverId, '203.0.113.30');
    const h2 = authHeaders(sessionCookie(await login(t, totpCode(secret, t.clock.t))));
    await t.app.hzCore.scheduler.tick();
    await idle(t);
    const renewed = (await req(t, h2, 'GET', '/api/domains')).json<DomainsResponse>()
      .certificates[0];
    expect(renewed?.status).toBe('valid');
    expect(renewed?.issuedAt).toBe(t.clock.t);
    expect(renewed?.notAfter).toBeGreaterThan(cert?.notAfter ?? 0);
    const writes = sim.rpcs.filter((r) => r.action === 'cert.write');
    expect(writes).toHaveLength(2);
    expect((writes[1]?.params as { privkeyPem: string }).privkeyPem).not.toBe(firstKey);
    // One ACME account for both runs.
    expect(t.world.acme.accounts.size).toBe(1);

    // Delete: cert.remove on the server, row gone.
    const del = await withStepUp(t, () =>
      req(t, h2, 'DELETE', `/api/domains/certificates/${created.id}`),
    );
    expect(del.statusCode).toBe(204);
    await until(() => sim.rpcs.some((r) => r.action === 'cert.remove'));
    expect(t.db.db.select().from(certificates).all()).toEqual([]);
    sim.agent.close();
  });

  it('DuckDNS certificate with wildcard (one TXT value at a time)', async () => {
    const { t, h, cookie } = await setup();
    const duck = await addDuck(t, h);
    void cookie;
    const res = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: duck.id,
        names: ['meinheim.duckdns.org', '*.meinheim.duckdns.org'],
        ca: 'letsencrypt-staging',
      }),
    );
    expect(res.statusCode).toBe(201);
    await idle(t);
    const cert = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().certificates[0];
    expect(cert).toMatchObject({ status: 'valid', ca: 'letsencrypt-staging' });
    expect(t.world.duck.subs.get('meinheim')?.txt).toBeNull();
    // Name outside the provider is refused.
    const out = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: duck.id,
        names: ['anders.duckdns.org'],
      }),
    );
    expect(out.statusCode).toBe(400);
  });

  it('failures back off 1 h / 6 h / 24 h and the second one raises a crit alert', async () => {
    const { t, h, cf } = await issueSetup();
    t.world.acme.failChallenges = true;
    const res = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: cf.id,
        names: ['app.example.com'],
      }),
    );
    const id = res.json<Certificate>().id;
    await idle(t);
    let c = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().certificates[0];
    expect(c).toMatchObject({ status: 'error' });
    expect(c?.lastError).toMatch(/Autorisierung/);
    const t1 = t.clock.t;
    expect(c?.nextAttemptAt).toBe(t1 + 3_600_000);
    expect(t.app.hzCore.alerts.active(`cert:${id}`)).toBeNull();

    // Not before the backoff.
    await minuteTick(t);
    expect(t.world.acme.csrs).toHaveLength(0);
    t.clock.t = t1 + 3_600_000;
    await minuteTick(t);
    c = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().certificates[0];
    expect(c?.nextAttemptAt).toBe(t.clock.t + 6 * 3_600_000);
    expect(t.app.hzCore.alerts.active(`cert:${id}`)?.level).toBe('crit');

    // Renew now works; the alert resolves.
    t.world.acme.failChallenges = false;
    const renew = await req(t, h, 'POST', `/api/domains/certificates/${id}/renew`);
    expect(renew.statusCode).toBe(202);
    await idle(t);
    c = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().certificates[0];
    expect(c).toMatchObject({ status: 'valid', lastError: null });
    expect(t.app.hzCore.alerts.active(`cert:${id}`)).toBeNull();
  });

  it('expiry alerts: warn at 14 days, crit at 3 days', async () => {
    const { t, h, cf } = await issueSetup();
    t.world.acme.validityMs = 20 * DAY;
    const res = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: cf.id,
        names: ['app.example.com'],
        autoRenew: false,
      }),
    );
    const id = res.json<Certificate>().id;
    await idle(t);
    t.clock.t = nextWallClock(t.clock.t + 7 * DAY, { hour: 4, minute: 0 });
    await t.app.hzCore.scheduler.tick();
    expect(t.app.hzCore.alerts.active(`cert:${id}`)?.level).toBe('warn');
    t.clock.t = nextWallClock(t.clock.t + 10 * DAY, { hour: 4, minute: 0 });
    await t.app.hzCore.scheduler.tick();
    expect(t.app.hzCore.alerts.active(`cert:${id}`)?.level).toBe('crit');
    // autoRenew off: no renewal was attempted.
    expect(t.world.acme.csrs).toHaveLength(1);
  });

  it('a server that was offline gets the certificate when it comes back', async () => {
    const { t, h, cf, sim } = await issueSetup();
    sim.agent.close();
    await until(() => !t.app.hzCore.hub.isConnected(sim.serverId));
    const res = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: cf.id,
        names: ['app.example.com'],
        deploy: [{ serverId: sim.serverId, name: 'app-example-com' }],
      }),
    );
    expect(res.statusCode).toBe(201);
    await idle(t);
    let c = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().certificates[0];
    expect(c?.status).toBe('valid');
    expect(c?.deploy[0]).toMatchObject({ deployedAt: null, lastError: 'Server offline' });

    const agent = await connectAgent(sim.url, sim.agentToken, sim.name);
    const rpcs: Rpc[] = [];
    answerRpcs(agent, rpcs);
    await until(() => rpcs.some((r) => r.action === 'cert.write'));
    await idle(t);
    c = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().certificates[0];
    expect(c?.deploy[0]?.deployedAt).not.toBeNull();
    expect(c?.deploy[0]?.lastError).toBeNull();
    // Already deployed: a further reconnect writes nothing.
    agent.close();
    await until(() => !t.app.hzCore.hub.isConnected(sim.serverId));
    const again = await connectAgent(sim.url, sim.agentToken, sim.name);
    const rpcs2: Rpc[] = [];
    answerRpcs(again, rpcs2);
    await idle(t);
    expect(rpcs2).toEqual([]);
    again.close();
  });

  it('adding a deploy target deploys there; removing one sends cert.remove', async () => {
    const { t, h, cookie, cf, sim } = await issueSetup();
    const res = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: cf.id,
        names: ['app.example.com'],
      }),
    );
    const id = res.json<Certificate>().id;
    await idle(t);
    const sim2 = await simServer(t, cookie, 'pi', '203.0.113.31');
    const upd = await withStepUp(t, () =>
      req(t, h, 'PUT', `/api/domains/certificates/${id}`, {
        deploy: [
          { serverId: sim.serverId, name: 'app-example-com' },
          { serverId: sim2.serverId, name: 'app-example-com' },
        ],
      }),
    );
    expect(upd.statusCode).toBe(200);
    await idle(t);
    const c = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().certificates[0];
    expect(c?.deploy.every((d) => d.deployedAt !== null)).toBe(true);
    const off = await req(t, h, 'PUT', `/api/domains/certificates/${id}`, {
      deploy: [{ serverId: sim.serverId, name: 'app-example-com' }],
    });
    expect(off.statusCode).toBe(200);
    await idle(t);
    expect(sim2.rpcs.map((r) => r.action)).toEqual(['cert.write', 'cert.remove']);
    sim.agent.close();
    sim2.agent.close();
  });

  it('validates certificate input', async () => {
    const { t, h, cf, sim } = await issueSetup();
    const bad = [
      { providerId: cf.id, names: [] },
      { providerId: cf.id, names: ['a.example.com', 'a.example.com'] },
      { providerId: cf.id, names: ['fremd.net'] },
      { providerId: cf.id, names: ['a.example.com'], ca: 'zerossl' },
      {
        providerId: cf.id,
        names: ['a.example.com'],
        deploy: [{ serverId: sim.serverId, name: '../etc' }],
      },
      {
        providerId: cf.id,
        names: ['a.example.com'],
        deploy: [{ serverId: 'unknown-server', name: 'x1' }],
      },
      { providerId: cf.id, names: ['A.EXAMPLE.COM'] },
    ];
    for (const payload of bad) {
      const r = await withStepUp(t, () => req(t, h, 'POST', '/api/domains/certificates', payload));
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(t.db.db.select().from(certificates).all()).toEqual([]);
    sim.agent.close();
  });
});

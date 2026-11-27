import { afterEach, describe, expect, it } from 'vitest';
import {
  DOMAINS_ALLOWED_HOSTS,
  type Certificate,
  type DnsProvider,
  type DnsRecord,
  type DomainsResponse,
} from '@hz/shared';
import { certificates, dnsProviders, settings } from '../src/db/schema.js';
import { checkUrl, DomainsHttp, DomainsHttpError } from '../src/domains/http.js';
import { enrollAgent, inventoryMsg, listen, until, withStepUp } from './agent-helpers.js';
import {
  CF_TOKEN,
  CF_TOKEN_2,
  DUCK_TOKEN,
  makeDomainsApp,
  type DomainsTestApp,
} from './domains-helpers.js';
import { authHeaders, completeSetup, SAME_ORIGIN } from './helpers.js';

let t: DomainsTestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

type T = DomainsTestApp;

async function setup(opts: Parameters<typeof makeDomainsApp>[0] = {}) {
  t = await makeDomainsApp(opts);
  const { cookie, secret } = await completeSetup(t);
  return { t, cookie, secret, h: authHeaders(cookie) };
}

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
      label: 'CF',
      token: CF_TOKEN,
    }),
  );
  expect(res.statusCode).toBe(201);
  return res.json<DnsProvider>();
}

const ID = 'AAAAAAAAAAAAAAAA';
const ROUTES: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; payload?: unknown }[] = [
  { method: 'GET', url: '/api/domains' },
  { method: 'PUT', url: '/api/domains/settings', payload: { acmeEmail: null } },
  {
    method: 'POST',
    url: '/api/domains/providers',
    payload: { kind: 'cloudflare', label: 'x', token: CF_TOKEN },
  },
  { method: 'PUT', url: `/api/domains/providers/${ID}`, payload: { label: 'x' } },
  { method: 'DELETE', url: `/api/domains/providers/${ID}` },
  { method: 'POST', url: `/api/domains/providers/${ID}/test` },
  { method: 'POST', url: '/api/domains/records', payload: {} },
  { method: 'PUT', url: `/api/domains/records/${ID}`, payload: { ttl: 300 } },
  { method: 'DELETE', url: `/api/domains/records/${ID}` },
  { method: 'POST', url: `/api/domains/records/${ID}/sync` },
  { method: 'POST', url: '/api/domains/certificates', payload: {} },
  { method: 'PUT', url: `/api/domains/certificates/${ID}`, payload: { autoRenew: false } },
  { method: 'POST', url: `/api/domains/certificates/${ID}/renew` },
  { method: 'DELETE', url: `/api/domains/certificates/${ID}` },
];

describe('domains security: auth, module gate, step-up', () => {
  it('every domains route is in the list above', async () => {
    t = await makeDomainsApp();
    const registered = t.app.hzRoutes
      .filter((r) => r.url.startsWith('/api/domains') && r.method !== 'HEAD')
      .map((r) => `${r.method} ${r.url.replace(/:id/g, ID)}`)
      .sort();
    expect(registered).toEqual(ROUTES.map((r) => `${r.method} ${r.url}`).sort());
  });

  it('401 without a session on every route', async () => {
    t = await makeDomainsApp();
    for (const r of ROUTES) {
      const res = await req(t, SAME_ORIGIN, r.method, r.url, r.payload);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
    expect(t.world.calls).toEqual([]);
  });

  it('404 module_disabled while the module is off; no jobs, no outgoing requests', async () => {
    const { t, h } = await setup({ domainsOn: false });
    for (const r of ROUTES) {
      const res = await withStepUp(t, () => req(t, h, r.method, r.url, r.payload));
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
      expect(res.json()).toMatchObject({ error: 'module_disabled' });
    }
    expect(t.app.hzCore.scheduler.has('domains.dns')).toBe(false);
    expect(t.app.hzCore.scheduler.has('domains.renew')).toBe(false);
    await expect(
      t.app.hzCore.features.domains.service.ensureRecord({
        ownerRef: 'g',
        providerId: ID,
        name: 'a.example.com',
        type: 'A',
        target: { kind: 'static', value: '203.0.113.1' },
      }),
    ).rejects.toMatchObject({ status: 404 });
    t.app.hzCore.modules.set({ domains: true });
    expect(t.app.hzCore.scheduler.has('domains.dns')).toBe(true);
    t.app.hzCore.modules.set({ domains: false });
    expect(t.app.hzCore.scheduler.has('domains.certs')).toBe(false);
    expect(t.world.calls).toEqual([]);
  });

  it('step-up for providers, certificates and adopting a foreign record', async () => {
    const { t, h } = await setup();
    const cf = await addCloudflare(t, h);
    const before = t.world.calls.length;
    const needs: { method: 'POST' | 'PUT' | 'DELETE'; url: string; payload?: unknown }[] = [
      {
        method: 'POST',
        url: '/api/domains/providers',
        payload: { kind: 'cloudflare', label: 'x', token: CF_TOKEN },
      },
      { method: 'PUT', url: `/api/domains/providers/${cf.id}`, payload: { token: CF_TOKEN_2 } },
      { method: 'DELETE', url: `/api/domains/providers/${cf.id}` },
      {
        method: 'POST',
        url: '/api/domains/certificates',
        payload: { providerId: cf.id, names: ['a.example.com'] },
      },
      { method: 'DELETE', url: `/api/domains/certificates/${ID}` },
      {
        method: 'POST',
        url: '/api/domains/records',
        payload: {
          providerId: cf.id,
          name: 'a.example.com',
          type: 'A',
          target: { kind: 'static', value: '203.0.113.1' },
          adopt: true,
        },
      },
    ];
    for (const r of needs) {
      const res = await req(t, h, r.method, r.url, r.payload);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(res.json()).toMatchObject({ error: 'step_up_required' });
    }
    // Nothing reached a provider, nothing changed.
    expect(t.world.calls.length).toBe(before);
    const list = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>();
    expect(list.providers).toHaveLength(1);
    expect(list.providers[0]?.tokenHint).toBe(CF_TOKEN.slice(-4));
    expect(list.certificates).toEqual([]);
    expect(list.records).toEqual([]);
  });

  it('a token change needs a successful test; the old token stays otherwise', async () => {
    const { t, h } = await setup();
    const cf = await addCloudflare(t, h);
    const bad = ['bad', 'token', 'value', 'abcdefghij'].join('_');
    const res = await withStepUp(t, () =>
      req(t, h, 'PUT', `/api/domains/providers/${cf.id}`, { token: bad }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(bad);
    const row = t.db.db.select().from(dnsProviders).get();
    expect(t.app.hzCore.features.domains.service.provider(cf.id).tokenHint).toBe(
      CF_TOKEN.slice(-4),
    );
    expect(row?.tokenEnc).not.toContain(CF_TOKEN);
  });
});

describe('domains security: outgoing requests', () => {
  const hosts = new Set<string>(DOMAINS_ALLOWED_HOSTS);

  it('checkUrl allows only https to the allowlisted hosts', () => {
    for (const ok of [
      'https://api.cloudflare.com/client/v4/zones',
      'https://www.duckdns.org/update?domains=x',
      'https://acme-v02.api.letsencrypt.org/directory',
      'https://ACME-STAGING-V02.api.letsencrypt.org/directory',
    ])
      expect(() => checkUrl(ok, hosts)).not.toThrow();
    for (const bad of [
      'http://api.cloudflare.com/client/v4',
      'https://api.cloudflare.com:8443/',
      'https://user:pw@api.cloudflare.com/',
      'https://api.cloudflare.com.evil.example/',
      'https://evil.example/',
      'https://127.0.0.1/',
      'ftp://www.duckdns.org/',
      'not a url',
    ])
      expect(() => checkUrl(bad, hosts), bad).toThrow(DomainsHttpError);
  });

  it('never follows redirects, limits size, never puts the URL into an error', async () => {
    const seen: RequestInit[] = [];
    const http = (res: () => Response) =>
      new DomainsHttp({
        allowedHosts: hosts,
        maxBytes: 1024,
        fetch: (_url, init) => {
          seen.push(init);
          return Promise.resolve(res());
        },
      });
    const secretUrl = `https://www.duckdns.org/update?token=${DUCK_TOKEN}`;
    const redirect = http(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    );
    const err = await redirect.request(secretUrl, { method: 'GET' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainsHttpError);
    expect((err as DomainsHttpError).kind).toBe('redirect');
    expect(String((err as Error).message) + (err as DomainsHttpError).reason).not.toContain(
      DUCK_TOKEN,
    );
    expect(seen.every((i) => i.redirect === 'manual')).toBe(true);
    const big = http(() => new Response('x'.repeat(5000)));
    await expect(big.request(secretUrl, { method: 'GET' })).rejects.toMatchObject({
      kind: 'too_large',
    });
    const down = new DomainsHttp({
      allowedHosts: hosts,
      fetch: () => Promise.reject(new TypeError(`fetch failed ${secretUrl}`)),
    });
    const e2 = await down.request(secretUrl, { method: 'GET' }).catch((e: unknown) => e);
    expect((e2 as DomainsHttpError).kind).toBe('network');
    expect(JSON.stringify(e2) + String(e2)).not.toContain(DUCK_TOKEN);
    let called = false;
    const evil = new DomainsHttp({
      allowedHosts: hosts,
      fetch: () => {
        called = true;
        return Promise.resolve(new Response('ok'));
      },
    });
    await expect(evil.request('https://evil.example/', { method: 'GET' })).rejects.toMatchObject({
      kind: 'host',
    });
    expect(called).toBe(false);
  });

  it('a provider that redirects is refused', async () => {
    const { t, h } = await setup();
    t.world.extra.set(
      'api.cloudflare.com',
      () =>
        new Response(null, { status: 301, headers: { location: 'https://evil.example/steal' } }),
    );
    const res = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/providers', {
        kind: 'cloudflare',
        label: 'CF',
        token: CF_TOKEN,
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ message: 'Token-Prüfung: Weiterleitung abgelehnt' });
    expect(t.world.calls.every((c) => new URL(c.url).hostname !== 'evil.example')).toBe(true);
  });

  for (const evil of ['authz', 'finalize', 'location'] as const) {
    it(`ACME URLs on another host are refused (${evil})`, async () => {
      const { t, h } = await setup();
      const cf = await addCloudflare(t, h);
      t.world.acme.evil = evil;
      await withStepUp(t, () =>
        req(t, h, 'POST', '/api/domains/certificates', {
          providerId: cf.id,
          names: ['a.example.com'],
        }),
      );
      await t.app.hzCore.features.domains.idle();
      const c = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().certificates[0];
      expect(c?.status).toBe('error');
      expect(c?.lastError).toBe('ACME-Adresse auf fremdem Host abgelehnt');
      expect(t.world.calls.some((x) => new URL(x.url).hostname === 'evil.example')).toBe(false);
      // Refused before any TXT record was set.
      expect([...t.world.cf.records.values()].filter((r) => r.type === 'TXT')).toEqual([]);
    });
  }

  it('without a test override only the Let’s Encrypt hosts are used', async () => {
    const { t, h } = await setup({ deps: () => ({ acmeDirectories: {} }) });
    const cf = await addCloudflare(t, h);
    await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: cf.id,
        names: ['a.example.com'],
        ca: 'letsencrypt-staging',
      }),
    );
    await t.app.hzCore.features.domains.idle();
    const acmeCalls = t.world.calls.filter((c) => c.url.includes('letsencrypt'));
    expect(acmeCalls[0]?.url).toBe('https://acme-staging-v02.api.letsencrypt.org/directory');
    for (const c of t.world.calls) {
      expect(DOMAINS_ALLOWED_HOSTS as readonly string[]).toContain(new URL(c.url).hostname);
      expect(c.redirect).toBe('manual');
    }
  });

  it('badNonce is retried; a bounded DNS wait fails cleanly', async () => {
    const { t, h } = await setup();
    const cf = await addCloudflare(t, h);
    t.world.acme.badNonces = 2;
    await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: cf.id,
        names: ['a.example.com'],
      }),
    );
    await t.app.hzCore.features.domains.idle();
    let c = (await req(t, h, 'GET', '/api/domains')).json<DomainsResponse>().certificates[0];
    expect(c?.status).toBe('valid');

    t.world.dns.silent = true;
    const r = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: cf.id,
        names: ['b.example.com'],
      }),
    );
    const id = r.json<Certificate>().id;
    await t.app.hzCore.features.domains.idle();
    c = (await req(t, h, 'GET', '/api/domains'))
      .json<DomainsResponse>()
      .certificates.find((x) => x.id === id);
    expect(c).toMatchObject({
      status: 'error',
      lastError: 'TXT-Eintrag wurde im DNS nicht sichtbar',
    });
    expect(t.world.dns.lookups.filter((n) => n === '_acme-challenge.b.example.com')).toHaveLength(
      3,
    );
    expect([...t.world.cf.records.values()].filter((x) => x.type === 'TXT')).toEqual([]);
  });
});

describe('domains security: deploy targets', () => {
  it('adding a deploy target needs step-up; autoRenew and removing do not', async () => {
    const { t, h, cookie } = await setup();
    const cf = await addCloudflare(t, h);
    const url = await listen(t);
    const a = await enrollAgent(t, url, cookie, 'oracle-a1');
    const b = await enrollAgent(t, url, cookie, 'pi');
    const writes: string[] = [];
    for (const [agent, sid] of [
      [a.agent, a.serverId],
      [b.agent, b.serverId],
    ] as const) {
      agent.ws.on('message', (data) => {
        const m = JSON.parse(String(data)) as { type: string; id: string; action: string };
        if (m.type !== 'rpc') return;
        writes.push(`${sid}:${m.action}`);
        agent.send({
          type: 'rpc.result',
          id: m.id,
          ok: true,
          data: { path: '/opt/homelab/certs/x/' },
        });
      });
    }
    const res = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: cf.id,
        names: ['a.example.com'],
        deploy: [{ serverId: a.serverId, name: 'a-example-com' }],
      }),
    );
    const id = res.json<Certificate>().id;
    await t.app.hzCore.features.domains.idle();
    expect(writes).toEqual([`${a.serverId}:cert.write`]);

    const both = [
      { serverId: a.serverId, name: 'a-example-com' },
      { serverId: b.serverId, name: 'a-example-com' },
    ];
    // New target without step-up: refused, nothing sent, nothing stored.
    const add = await req(t, h, 'PUT', `/api/domains/certificates/${id}`, { deploy: both });
    expect(add.statusCode).toBe(403);
    expect(add.json()).toMatchObject({ error: 'step_up_required' });
    // Same with a new folder name on the same server and together with autoRenew.
    const rename = await req(t, h, 'PUT', `/api/domains/certificates/${id}`, {
      autoRenew: false,
      deploy: [{ serverId: a.serverId, name: 'other-folder' }],
    });
    expect(rename.statusCode).toBe(403);
    await t.app.hzCore.features.domains.idle();
    expect(writes).toEqual([`${a.serverId}:cert.write`]);
    let c = t.app.hzCore.features.domains.service.certificate(id);
    expect(c.deploy.map((d) => d.serverId)).toEqual([a.serverId]);
    expect(c.autoRenew).toBe(true);

    // autoRenew alone and the unchanged list need no step-up.
    const ar = await req(t, h, 'PUT', `/api/domains/certificates/${id}`, {
      autoRenew: false,
      deploy: [{ serverId: a.serverId, name: 'a-example-com' }],
    });
    expect(ar.statusCode).toBe(200);

    // With step-up the target is added and gets the certificate.
    const ok = await withStepUp(t, () =>
      req(t, h, 'PUT', `/api/domains/certificates/${id}`, { deploy: both }),
    );
    expect(ok.statusCode).toBe(200);
    await t.app.hzCore.features.domains.idle();
    expect(writes).toContain(`${b.serverId}:cert.write`);

    // Removing a target works without step-up.
    const rm = await req(t, h, 'PUT', `/api/domains/certificates/${id}`, {
      deploy: [{ serverId: a.serverId, name: 'a-example-com' }],
    });
    expect(rm.statusCode).toBe(200);
    await t.app.hzCore.features.domains.idle();
    expect(writes).toContain(`${b.serverId}:cert.remove`);
    c = t.app.hzCore.features.domains.service.certificate(id);
    expect(c.deploy.map((d) => d.serverId)).toEqual([a.serverId]);
    a.agent.close();
    b.agent.close();
  });
});

describe('domains security: error codes', () => {
  it('409 exists for existing names, 409 in_use for providers and folders in use', async () => {
    const { t, h, cookie } = await setup();
    const cf = await addCloudflare(t, h);
    const rec = {
      providerId: cf.id,
      name: 'app.example.com',
      type: 'A',
      target: { kind: 'static', value: '203.0.113.5' },
    };
    expect((await req(t, h, 'POST', '/api/domains/records', rec)).statusCode).toBe(201);
    // Same name as an own record (also a CNAME next to it).
    const dup = await req(t, h, 'POST', '/api/domains/records', rec);
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: 'exists' });
    const cname = await req(t, h, 'POST', '/api/domains/records', {
      ...rec,
      type: 'CNAME',
      target: { kind: 'static', value: 'x.example.org' },
    });
    expect(cname.json()).toMatchObject({ error: 'exists' });
    // Relay: a name that is an admin record or foreign at the provider.
    const svc = t.app.hzCore.features.domains.service;
    await expect(
      svc.ensureRecord({
        ownerRef: 'game1',
        providerId: cf.id,
        name: 'app.example.com',
        type: 'A',
        target: { kind: 'static', value: '203.0.113.6' },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'exists' });
    t.world.cf.addForeign('taken.example.com', 'A', '198.51.100.9');
    await expect(
      svc.ensureRecord({
        ownerRef: 'game1',
        providerId: cf.id,
        name: 'taken.example.com',
        type: 'A',
        target: { kind: 'static', value: '203.0.113.6' },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'exists' });

    // A provider used only by a certificate cannot be deleted.
    const duck = (
      await withStepUp(t, () =>
        req(t, h, 'POST', '/api/domains/providers', {
          kind: 'duckdns',
          label: 'Duck',
          token: DUCK_TOKEN,
          subdomains: ['meinheim'],
        }),
      )
    ).json<DnsProvider>();
    const url = await listen(t);
    const { agent, serverId } = await enrollAgent(t, url, cookie, 'oracle-a1');
    agent.ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as { type: string; id: string };
      if (m.type === 'rpc')
        agent.send({ type: 'rpc.result', id: m.id, ok: true, data: { path: '/x/' } });
    });
    const cert = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: duck.id,
        names: ['meinheim.duckdns.org'],
        deploy: [{ serverId, name: 'meinheim' }],
      }),
    );
    expect(cert.statusCode).toBe(201);
    await t.app.hzCore.features.domains.idle();
    const del = await withStepUp(t, () => req(t, h, 'DELETE', `/api/domains/providers/${duck.id}`));
    expect(del.statusCode).toBe(409);
    expect(del.json()).toMatchObject({ error: 'in_use' });
    // Dropping the subdomain the certificate uses.
    t.world.duck.subs.set('zweite', { ip: null, ipv6: null, txt: null });
    const sub = await withStepUp(t, () =>
      req(t, h, 'PUT', `/api/domains/providers/${duck.id}`, { subdomains: ['zweite'] }),
    );
    expect(sub.statusCode).toBe(409);
    expect(sub.json()).toMatchObject({ error: 'in_use' });
    // Another certificate on the same server folder.
    const other = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/certificates', {
        providerId: cf.id,
        names: ['b.example.com'],
        deploy: [{ serverId, name: 'meinheim' }],
      }),
    );
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: 'in_use' });
    agent.close();
  });
});

describe('domains security: foreign records and zones', () => {
  it('never overwrites a record the hub did not create', async () => {
    const { t, h } = await setup();
    const cf = await addCloudflare(t, h);
    const foreign = t.world.cf.addForeign('mail.example.com', 'A', '198.51.100.1');
    const payload = {
      providerId: cf.id,
      name: 'mail.example.com',
      type: 'A',
      target: { kind: 'static', value: '203.0.113.5' },
    };
    const res = await req(t, h, 'POST', '/api/domains/records', payload);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'exists' });
    expect(t.world.cf.records.get(foreign.id)?.content).toBe('198.51.100.1');
    expect(
      t.world.calls.some(
        (c) => c.method === 'PUT' || (c.method === 'POST' && c.url.includes('dns_records')),
      ),
    ).toBe(false);

    // With adopt (step-up) it is taken over on purpose.
    const adopt = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/records', { ...payload, adopt: true }),
    );
    expect(adopt.statusCode).toBe(201);
    expect(t.world.cf.records.get(foreign.id)?.content).toBe('203.0.113.5');
  });

  it('a record vanished at the provider and re-created by someone else is not overwritten', async () => {
    const { t, h } = await setup();
    const cf = await addCloudflare(t, h);
    const rec = (
      await req(t, h, 'POST', '/api/domains/records', {
        providerId: cf.id,
        name: 'app.example.com',
        type: 'A',
        target: { kind: 'static', value: '203.0.113.5' },
      })
    ).json<DnsRecord>();
    const own = [...t.world.cf.records.values()].find((r) => r.name === 'app.example.com');
    t.world.cf.records.delete(own?.id ?? '');
    const foreign = t.world.cf.addForeign('app.example.com', 'A', '198.51.100.7');
    const sync = await req(t, h, 'POST', `/api/domains/records/${rec.id}/sync`);
    expect(sync.json()).toMatchObject({ status: 'error' });
    expect(t.world.cf.records.get(foreign.id)?.content).toBe('198.51.100.7');
    expect(t.app.hzCore.alerts.active(`dns:${rec.id}`)?.level).toBe('warn');
  });

  it('names outside the provider zones are refused (records and certificates)', async () => {
    const { t, h } = await setup();
    const cf = await addCloudflare(t, h);
    for (const name of ['example.net', 'evilexample.com', 'example.com.evil.org']) {
      const r = await req(t, h, 'POST', '/api/domains/records', {
        providerId: cf.id,
        name,
        type: 'A',
        target: { kind: 'static', value: '203.0.113.5' },
      });
      expect(r.statusCode, name).toBe(400);
      const c = await withStepUp(t, () =>
        req(t, h, 'POST', '/api/domains/certificates', {
          providerId: cf.id,
          names: ['a.example.com', name],
        }),
      );
      expect(c.statusCode, name).toBe(400);
    }
    expect(t.db.db.select().from(certificates).all()).toEqual([]);
  });
});

describe('domains security: secrets', () => {
  it('tokens and private keys appear in no response and no log', async () => {
    const { t, h, cookie } = await setup({ captureLogs: true });
    const bodies: string[] = [];
    const url = await listen(t);
    const { agent, serverId } = await enrollAgent(t, url, cookie, 'oracle-a1');
    const keys: string[] = [];
    agent.ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as {
        type: string;
        id: string;
        action: string;
        params: { privkeyPem?: string };
      };
      if (m.type !== 'rpc') return;
      if (m.params.privkeyPem) keys.push(m.params.privkeyPem);
      agent.send({
        type: 'rpc.result',
        id: m.id,
        ok: true,
        data: { path: '/opt/homelab/certs/x/' },
      });
    });
    const inv = inventoryMsg();
    agent.send({ ...inv, system: { ...inv.system, publicIp: '203.0.113.44' } });
    await until(() => t.app.hzCore.servers.row(serverId)?.publicIp === '203.0.113.44');

    const cfRes = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/providers', {
        kind: 'cloudflare',
        label: 'CF',
        token: CF_TOKEN,
      }),
    );
    bodies.push(cfRes.body);
    const cf = cfRes.json<DnsProvider>();
    const duckRes = await withStepUp(t, () =>
      req(t, h, 'POST', '/api/domains/providers', {
        kind: 'duckdns',
        label: 'Duck',
        token: DUCK_TOKEN,
        subdomains: ['meinheim'],
      }),
    );
    bodies.push(duckRes.body);
    const duck = duckRes.json<DnsProvider>();
    bodies.push(
      (
        await req(t, h, 'POST', '/api/domains/records', {
          providerId: duck.id,
          name: 'meinheim.duckdns.org',
          type: 'A',
          target: { kind: 'server', serverId },
        })
      ).body,
    );
    bodies.push(
      (
        await withStepUp(t, () =>
          req(t, h, 'POST', '/api/domains/certificates', {
            providerId: cf.id,
            names: ['example.com', '*.example.com'],
            deploy: [{ serverId, name: 'example-com' }],
          }),
        )
      ).body,
    );
    await t.app.hzCore.features.domains.idle();
    // Failing calls: DuckDNS answers KO, Cloudflare rejects the token.
    t.world.duck.token = 'other';
    t.world.cf.tokens.clear();
    bodies.push((await req(t, h, 'POST', `/api/domains/providers/${duck.id}/test`)).body);
    bodies.push((await req(t, h, 'POST', `/api/domains/providers/${cf.id}/test`)).body);
    t.clock.advance(120_000);
    await t.app.hzCore.features.domains.service.syncAll();
    bodies.push(
      (
        await withStepUp(t, () =>
          req(t, h, 'PUT', `/api/domains/providers/${cf.id}`, { token: CF_TOKEN_2 }),
        )
      ).body,
    );
    // Malformed body containing a token.
    bodies.push(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/domains/records',
          headers: { ...h, 'content-type': 'application/json' },
          payload: `{"token":"${CF_TOKEN}"`,
        })
      ).body,
    );
    bodies.push((await req(t, h, 'GET', '/api/domains')).body);
    bodies.push((await req(t, h, 'GET', '/api/alerts')).body);
    bodies.push((await req(t, h, 'GET', '/api/audit')).body);

    expect(keys.length).toBeGreaterThan(0);
    const keyBodies = keys.map((k) => k.split('\n')[1] ?? 'missing');
    const secrets = [CF_TOKEN, CF_TOKEN_2, DUCK_TOKEN, ...keyBodies, 'PRIVATE KEY'];
    const logText = t.logs.join('\n');
    expect(logText.length).toBeGreaterThan(0);
    for (const s of secrets) {
      for (const b of bodies) expect(b).not.toContain(s);
      expect(logText).not.toContain(s);
    }
    // At rest: tokens and keys only encrypted.
    const dump = JSON.stringify([
      t.db.db.select().from(dnsProviders).all(),
      t.db.db.select().from(certificates).all(),
      t.db.db.select().from(settings).all(),
    ]);
    for (const s of secrets) expect(dump).not.toContain(s);
    const list = JSON.parse(bodies.at(-3) ?? '{}') as DomainsResponse;
    expect(list.certificates[0]?.status).toBe('valid');
    agent.close();
  });
});

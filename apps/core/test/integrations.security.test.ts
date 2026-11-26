import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { INTEGRATIONS, integrationSettingsSchema } from '@hz/shared';
import { PUBLIC_API_ROUTES } from '../src/auth/guard.js';
import { auditLog, settings } from '../src/db/schema.js';
import { writeSetting } from '../src/db/settings.js';
import { moduleOfPath } from '../src/modules/service.js';
import { HOST } from './helpers.js';
import {
  FakeServer,
  json,
  OTHER_SECRET,
  PVE_TOKEN_ID,
  SENTINEL,
  tickIntegrations,
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

async function fake(handler: FakeServer['handler']): Promise<FakeServer> {
  const f = new FakeServer();
  fakes.push(f);
  return f.start(handler);
}

/** Answers everything with the received credentials echoed back (a hostile host). */
const echo: FakeServer['handler'] = (q, r) =>
  json(r, 500, { echo: q.headers.authorization ?? null, body: q.body, msg: SENTINEL });

const ROUTES = [
  ...INTEGRATIONS.flatMap(
    (id) =>
      [
        ['GET', `/api/${id}/settings`],
        ['PUT', `/api/${id}/settings`],
        ['DELETE', `/api/${id}/settings`],
        ['POST', `/api/${id}/test`],
      ] as const,
  ),
  ['GET', '/api/proxmox/guests'],
  ['POST', '/api/proxmox/guests/:node/:type/:vmid/:action'],
  ['GET', '/api/dnsfilter/status'],
  ['POST', '/api/dnsfilter/blocking'],
  ['GET', '/api/fritzbox/status'],
  ['POST', '/api/fritzbox/reboot'],
  ['GET', '/api/uptimekuma/monitors'],
  ['POST', '/api/uptimekuma/import'],
] as const;

const sample = (url: string) =>
  url
    .replace(':node', 'pve')
    .replace(':type', 'qemu')
    .replace(':vmid', '101')
    .replace(':action', 'start');

describe('integration routes: session, module gate', () => {
  it('registers exactly these routes, all need a session', async () => {
    s = await withIntegrations();
    const registered = s.t.app.hzRoutes
      .filter((r) => INTEGRATIONS.some((id) => r.url.startsWith(`/api/${id}/`)))
      .filter((r) => r.method !== 'HEAD')
      .map((r) => `${r.method} ${r.url}`);
    expect(registered.sort()).toEqual(ROUTES.map(([m, u]) => `${m} ${u}`).sort());
    for (const [method, url] of ROUTES) {
      expect(PUBLIC_API_ROUTES).not.toContain(url);
      const res = await s.t.app.inject({
        method,
        url: sample(url),
        headers: { host: HOST, origin: `https://${HOST}` },
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('a disabled module answers 404 module_disabled on every route', async () => {
    s = await withIntegrations({
      modules: { proxmox: false, dnsfilter: false, fritzbox: false, uptimekuma: false },
    });
    for (const [method, url] of ROUTES) {
      expect(moduleOfPath(url)).not.toBeNull();
      const res = await s.req(method, sample(url), method === 'GET' ? undefined : {});
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toEqual({ ok: false, error: 'module_disabled' });
    }
  });

  it('enabling an integration module needs step-up', async () => {
    s = await withIntegrations({
      modules: { proxmox: false, dnsfilter: false, fritzbox: false, uptimekuma: false },
    });
    s.expireStepUp();
    for (const id of INTEGRATIONS) {
      const res = await s.req('PUT', '/api/settings/modules', { [id]: true });
      expect(res.statusCode, id).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    }
    expect(s.t.app.hzCore.modules.get()).toMatchObject({
      proxmox: false,
      dnsfilter: false,
      fritzbox: false,
      uptimekuma: false,
    });
    await s.stepUp();
    expect((await s.req('PUT', '/api/settings/modules', { proxmox: true })).statusCode).toBe(200);
    // Switching off needs none.
    s.expireStepUp();
    expect((await s.req('PUT', '/api/settings/modules', { proxmox: false })).statusCode).toBe(200);
  });
});

describe('settings changes', () => {
  it('url, username, secret, CA and variant each need step-up', async () => {
    s = await withIntegrations();
    s.expireStepUp();
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ==\n-----END CERTIFICATE-----\n';
    for (const [id, body] of [
      ['proxmox', { url: 'https://pve.lan:8006' }],
      ['proxmox', { username: PVE_TOKEN_ID }],
      ['fritzbox', { username: null }],
      ['uptimekuma', { secret: SENTINEL }],
      ['proxmox', { caCert: pem }],
      ['proxmox', { caCert: null }],
      ['dnsfilter', { variant: 'adguard' }],
    ] as const) {
      const res = await s.req('PUT', `/api/${id}/settings`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    }
    for (const id of INTEGRATIONS) {
      expect((await s.req('DELETE', `/api/${id}/settings`)).statusCode).toBe(403);
      const st = integrationSettingsSchema.parse(
        (await s.req('GET', `/api/${id}/settings`)).json(),
      );
      expect(st).toMatchObject({ url: null, secretSet: false, caSet: false });
    }
  });

  it('link-local URLs (cloud metadata) and URLs with credentials or query are refused', async () => {
    s = await withIntegrations();
    await s.stepUp();
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://[fe80::1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://user:pw@127.0.0.1:1/',
      'http://127.0.0.1:1/?token=x',
      'file:///etc/passwd',
    ]) {
      const res = await s.req('PUT', '/api/proxmox/settings', { url });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it('a redirect is never followed', async () => {
    const other = await fake((_q, r) => json(r, 200, { data: [] }));
    const pve = await fake((_q, r) => {
      r.statusCode = 302;
      r.setHeader('location', `${other.url}/api2/json/cluster/resources`);
      r.end();
    });
    s = await withIntegrations();
    const res = await s.configure('proxmox', {
      url: pve.url,
      username: PVE_TOKEN_ID,
      secret: SENTINEL,
    });
    expect(integrationSettingsSchema.parse(res.json())).toMatchObject({
      status: 'error',
      error: 'Weiterleitung nicht erlaubt',
    });
    await s.req('GET', '/api/proxmox/guests');
    await s.req('POST', '/api/proxmox/test', {});
    expect(pve.requests.length).toBeGreaterThan(0);
    expect(other.requests).toHaveLength(0);
  });

  it('a new URL origin without a new secret drops the secret: the token never reaches the new host', async () => {
    const pveHandler: FakeServer['handler'] = (_q, r) => json(r, 200, { data: [] });
    const first = await fake(pveHandler);
    const second = await fake(pveHandler);
    s = await withIntegrations();
    expect(
      (
        await s.configure('proxmox', { url: first.url, username: PVE_TOKEN_ID, secret: SENTINEL })
      ).json(),
    ).toMatchObject({ status: 'ok', secretSet: true });
    expect(first.requests[0]?.headers.authorization).toBe(
      `PVEAPIToken=${PVE_TOKEN_ID}=${SENTINEL}`,
    );

    // Same origin, other path: the secret stays.
    const samePath = await s.configure('proxmox', { url: `${first.url}/` });
    expect(integrationSettingsSchema.parse(samePath.json()).secretSet).toBe(true);

    const moved = await s.configure('proxmox', { url: second.url });
    expect(integrationSettingsSchema.parse(moved.json())).toMatchObject({
      url: second.url,
      secretSet: false,
      status: 'off',
    });
    await s.req('POST', '/api/proxmox/test', {});
    await s.req('GET', '/api/proxmox/guests');
    await s.req('POST', '/api/proxmox/guests/pve/qemu/101/start', {});
    s.t.clock.advance(60_000);
    await tickIntegrations(s.t);
    expect(second.requests.filter((r) => r.headers.authorization !== undefined)).toHaveLength(0);
    const audit = s.t.db.db
      .select()
      .from(auditLog)
      .all()
      .filter((r) => r.action === 'proxmox.settings')
      .map((r) => JSON.parse(r.detailsJson ?? '{}') as Record<string, unknown>);
    expect(audit.at(-1)).toMatchObject({
      urlChanged: true,
      secretChanged: false,
      secretDropped: true,
    });

    // A new secret in the same request as the new URL is kept and only that one is sent.
    await s.configure('proxmox', { url: first.url, secret: OTHER_SECRET });
    const auths = [...first.requests, ...second.requests].map((r) => r.headers.authorization ?? '');
    expect(auths.at(-1)).toBe(`PVEAPIToken=${PVE_TOKEN_ID}=${OTHER_SECRET}`);
    expect(second.requests.map((r) => r.headers.authorization ?? '').join('')).not.toContain(
      SENTINEL,
    );
  });

  it('an undecryptable secret shows an error and is never sent', async () => {
    const pve = await fake((_q, r) => json(r, 200, { data: [] }));
    s = await withIntegrations();
    await s.configure('proxmox', { url: pve.url, username: PVE_TOKEN_ID, secret: SENTINEL });
    const n = pve.requests.length;
    writeSetting(s.t.db.db, 'integration.proxmox.secret', 'v1:AAAA:BBBB', s.t.clock.t);
    const st = integrationSettingsSchema.parse(
      (await s.req('GET', '/api/proxmox/settings')).json(),
    );
    expect(st).toMatchObject({
      secretSet: true,
      status: 'error',
      error: 'Zugangsdaten nicht lesbar, bitte neu eintragen',
    });
    await s.req('POST', '/api/proxmox/test', {});
    expect(pve.requests.length).toBe(n);
  });

  it('secrets are stored encrypted with a per-integration AAD', async () => {
    const pve = await fake((_q, r) => json(r, 200, { data: [] }));
    s = await withIntegrations();
    await s.configure('proxmox', { url: pve.url, username: PVE_TOKEN_ID, secret: SENTINEL });
    const row = s.t.db.db
      .select()
      .from(settings)
      .where(eq(settings.key, 'integration.proxmox.secret'))
      .get();
    expect(row?.valueJson).toMatch(/^"v1:/);
    expect(row?.valueJson).not.toContain(SENTINEL);
    // Moved to another integration's key, it does not decrypt.
    s.t.db.db
      .insert(settings)
      .values({
        key: 'integration.uptimekuma.secret',
        valueJson: row?.valueJson ?? '',
        updatedAt: 0,
      })
      .run();
    const kuma = integrationSettingsSchema.parse(
      (await s.req('GET', '/api/uptimekuma/settings')).json(),
    );
    expect(kuma.error).toBe('Zugangsdaten nicht lesbar, bitte neu eintragen');
  });
});

describe('secrets never leave the core', () => {
  it('not in any API response, error text, audit entry or log line', async () => {
    const hostile = await fake(echo);
    s = await withIntegrations({ captureLogs: true });
    const bodies: string[] = [];
    const keep = async (p: ReturnType<IntegrationSetup['req']>): Promise<void> => {
      const res = await p;
      bodies.push(res.body);
    };
    const configs = {
      proxmox: { url: hostile.url, username: PVE_TOKEN_ID, secret: SENTINEL },
      dnsfilter: { url: hostile.url, secret: SENTINEL, variant: 'pihole' },
      fritzbox: { url: hostile.url, username: 'hz', secret: SENTINEL },
      uptimekuma: { url: hostile.url, secret: SENTINEL },
    } as const;
    for (const id of INTEGRATIONS) {
      await keep(s.configure(id, configs[id]));
      await keep(s.req('GET', `/api/${id}/settings`));
      await keep(s.req('POST', `/api/${id}/test`, {}));
    }
    // AdGuard sends Basic auth.
    await keep(s.configure('dnsfilter', { variant: 'adguard', username: 'admin' }));
    await keep(s.req('GET', '/api/proxmox/guests'));
    await keep(s.req('POST', '/api/proxmox/guests/pve/qemu/101/start', {}));
    await keep(s.req('GET', '/api/dnsfilter/status'));
    await keep(s.req('POST', '/api/dnsfilter/blocking', { enabled: false, minutes: 5 }));
    await keep(s.req('GET', '/api/fritzbox/status'));
    await keep(s.req('POST', '/api/fritzbox/reboot', { confirm: true }));
    await keep(s.req('GET', '/api/uptimekuma/monitors'));
    await keep(s.req('POST', '/api/uptimekuma/import', { names: ['x'] }));
    for (let i = 0; i < 12; i++) {
      s.t.clock.advance(30_000);
      await tickIntegrations(s.t);
    }
    await keep(s.req('GET', '/api/alerts'));
    // The hostile host did get credentials (proving the sentinel was in play) ...
    expect(
      hostile.requests.some(
        (r) => (r.headers.authorization ?? '').includes(SENTINEL) || r.body.includes(SENTINEL),
      ),
    ).toBe(true);
    // ... but nothing of it came back.
    const basic = Buffer.from(`:${SENTINEL}`).toString('base64');
    for (const b of bodies) {
      expect(b).not.toContain(SENTINEL);
      expect(b).not.toContain(basic);
      expect(b).not.toContain('echo');
    }
    const logs = s.t.logs.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(SENTINEL);
    expect(logs).not.toContain(basic);
    const audit = JSON.stringify(s.t.db.db.select().from(auditLog).all());
    expect(audit).not.toContain(SENTINEL);
    expect(s.t.app.hzCore.alerts.active('integration:proxmox:unreachable')).not.toBeNull();
  });

  it('an oversized response is aborted', async () => {
    const big = await fake((_q, r) => {
      r.setHeader('content-type', 'application/json');
      const chunk = 'x'.repeat(256 * 1024);
      for (let i = 0; i < 20; i++) r.write(chunk);
      r.end();
    });
    s = await withIntegrations();
    const res = await s.configure('uptimekuma', { url: big.url, secret: SENTINEL });
    expect(integrationSettingsSchema.parse(res.json())).toMatchObject({
      status: 'error',
      error: 'Antwort zu groß',
    });
  });
});

describe('actions', () => {
  it('Proxmox: unknown guest 404, stop/shutdown/reboot without step-up 403', async () => {
    const pve = await fake((q, r) => {
      if (q.method === 'GET') {
        json(r, 200, {
          data: [
            { type: 'qemu', node: 'pve', vmid: 101, name: 'vm', status: 'running', template: 0 },
          ],
        });
      } else {
        json(r, 200, { data: 'UPID:pve:1:2:3:x:101:y:' });
      }
    });
    s = await withIntegrations();
    await s.configure('proxmox', { url: pve.url, username: PVE_TOKEN_ID, secret: SENTINEL });
    s.expireStepUp();
    const unknown = await s.req('POST', '/api/proxmox/guests/pve/qemu/102/start', {});
    expect(unknown.statusCode).toBe(404);
    for (const a of ['stop', 'shutdown', 'reboot']) {
      const res = await s.req('POST', `/api/proxmox/guests/pve/qemu/101/${a}`, { confirm: true });
      expect(res.statusCode, a).toBe(403);
    }
    expect(pve.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('DNS filter: a pause without minutes is refused', async () => {
    s = await withIntegrations();
    for (const body of [
      { enabled: false },
      { enabled: false, minutes: null },
      { enabled: false, minutes: 10 },
    ]) {
      expect((await s.req('POST', '/api/dnsfilter/blocking', body)).statusCode).toBe(400);
    }
  });

  it('foreign Origin is refused on mutating routes', async () => {
    s = await withIntegrations();
    const res = await s.t.app.inject({
      method: 'POST',
      url: '/api/dnsfilter/blocking',
      headers: { host: HOST, origin: 'https://evil.example', cookie: `hz_session=${s.cookie}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
  });
});

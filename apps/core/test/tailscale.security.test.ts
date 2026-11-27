import { afterEach, describe, expect, it } from 'vitest';
import { onboardingCreateResponseSchema, tailscaleSettingsSchema } from '@hz/shared';
import { tailscaleApiBase, TAILSCALE_API } from '../src/servers/tailscale.js';
import { withStepUp } from './agent-helpers.js';
import { authHeaders, type TestApp } from './helpers.js';
import { createOnboardingRaw, onboardingApp } from './onboarding-helpers.js';

/*
 * M11b: Tailscale OAuth client of the hub and the single-use auth key per onboarding.
 * The Tailscale API is a fake; secrets are built at run time (gitleaks).
 */

const CLIENT_ID = 'kAbC123CNTRL';
const SECRET = ['tskey', 'client', 'kAbC123CNTRL-SeCrEtSeCrEt0123456789'].join('-');
const ACCESS = 'access-token-0123456789abcdef';
const MINTED = ['tskey', 'auth', 'kMinted1CNTRL-KeYKeYKeY0123456789'].join('-');

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: string;
}

function fakeTailscale(init: { tokenStatus?: number; keyStatus?: number } = {}) {
  const opts = { ...init };
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({
      method: init.method ?? 'GET',
      path: u.pathname,
      auth: headers.get('authorization'),
      body,
    });
    if (u.pathname === '/api/v2/oauth/token') {
      if (opts.tokenStatus && opts.tokenStatus !== 200)
        return new Response('{"message":"invalid client <b>x</b>"}', { status: opts.tokenStatus });
      return Response.json({ access_token: ACCESS, token_type: 'Bearer', expires_in: 3600 });
    }
    if (u.pathname === '/api/v2/tailnet/-/keys' && init.method === 'POST') {
      if (opts.keyStatus && opts.keyStatus !== 200)
        return new Response('{"message":"tag not permitted"}', { status: opts.keyStatus });
      return Response.json({ id: 'kMinted1CNTRL', key: MINTED, expires: '2026-01-01T00:00:00Z' });
    }
    if (u.pathname.startsWith('/api/v2/tailnet/-/keys/') && init.method === 'DELETE') {
      return new Response(null, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return { calls, fetch, opts };
}

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

async function setup(fake = fakeTailscale()) {
  const s = await onboardingApp({ tailscaleFetch: fake.fetch, captureLogs: true });
  t = s.t;
  return { ...s, fake };
}

function put(app: TestApp, cookie: string, payload: object, stepUp = true) {
  const req = () =>
    app.app.inject({ method: 'PUT', url: '/api/tailscale', headers: authHeaders(cookie), payload });
  return stepUp ? withStepUp(app, req) : req();
}

/** Every text cell of every table (secrets must not be in the DB in plain form). */
function dbDump(app: TestApp): string {
  const tables = app.db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return tables
    .map((r) => JSON.stringify(app.db.sqlite.prepare(`SELECT * FROM "${r.name}"`).all()))
    .join('\n');
}

describe('Tailscale settings', () => {
  it('need a session; saving and removing need step-up', async () => {
    const s = await setup();
    for (const [method, url] of [
      ['GET', '/api/tailscale'],
      ['PUT', '/api/tailscale'],
      ['POST', '/api/tailscale/test'],
      ['DELETE', '/api/tailscale'],
    ] as const) {
      const res = await s.t.app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    const noStepUp = await put(s.t, s.cookie, { clientId: CLIENT_ID, clientSecret: SECRET }, false);
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json()).toMatchObject({ error: 'step_up_required' });
    const del = await s.t.app.inject({
      method: 'DELETE',
      url: '/api/tailscale',
      headers: authHeaders(s.cookie),
    });
    expect(del.json()).toMatchObject({ error: 'step_up_required' });
    expect(s.fake.calls).toEqual([]);
  });

  it('stores the secret encrypted, never returns or logs it, checks right away', async () => {
    const s = await setup();
    const res = await put(s.t, s.cookie, { clientId: CLIENT_ID, clientSecret: SECRET });
    expect(res.statusCode).toBe(200);
    const view = tailscaleSettingsSchema.parse(res.json());
    expect(view).toMatchObject({
      clientId: CLIENT_ID,
      secretSet: true,
      tag: 'tag:homelab-server',
      status: 'ok',
      error: null,
    });
    expect(res.body).not.toContain(SECRET);
    // The check minted a key and deleted it again.
    expect(s.fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v2/oauth/token',
      'POST /api/v2/tailnet/-/keys',
      'POST /api/v2/oauth/token',
      'DELETE /api/v2/tailnet/-/keys/kMinted1CNTRL',
    ]);
    const get = await s.t.app.inject({
      method: 'GET',
      url: '/api/tailscale',
      headers: authHeaders(s.cookie),
    });
    expect(get.body).not.toContain(SECRET);
    for (const text of [dbDump(s.t), s.t.logs.join('\n')]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(SECRET.slice('tskey-client-'.length));
      expect(text).not.toContain(MINTED);
      expect(text).not.toContain(ACCESS);
    }
    const audit = s.t.db.sqlite
      .prepare("SELECT details_json d FROM audit_log WHERE action = 'tailscale.settings_changed'")
      .all() as { d: string }[];
    expect(audit).toEqual([{ d: JSON.stringify({ fields: ['clientId', 'clientSecret'] }) }]);
  });

  it('a new client id without a new secret drops the stored secret', async () => {
    const s = await setup();
    await put(s.t, s.cookie, { clientId: CLIENT_ID, clientSecret: SECRET });
    const res = await put(s.t, s.cookie, { clientId: 'kOther9CNTRL' });
    expect(res.json()).toMatchObject({ clientId: 'kOther9CNTRL', secretSet: false, status: 'off' });
  });

  it('refuses malformed values (no quotes, no shell, only tags)', async () => {
    const s = await setup();
    for (const payload of [
      { clientId: "k'; id;'" },
      { clientSecret: 'tskey-auth-abcdefghijkl' },
      { clientSecret: `${SECRET}$(id)` },
      { tag: 'homelab' },
      { tag: 'tag:a b' },
      { tag: 'tag:x', extra: 1 },
    ]) {
      const res = await put(s.t, s.cookie, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('an API refusal shows a fixed German text, never the API message', async () => {
    const s = await setup(fakeTailscale({ tokenStatus: 401 }));
    const res = await put(s.t, s.cookie, { clientId: CLIENT_ID, clientSecret: SECRET });
    expect(res.json()).toMatchObject({ status: 'error', error: 'Client-ID oder Secret falsch' });
    expect(res.body).not.toContain('<b>');
  });

  it('the API base can only be overridden with HZ_DEMO=1 and loopback', () => {
    expect(tailscaleApiBase({ demo: false, tailscaleApiOverride: 'http://127.0.0.1:9' })).toBe(
      TAILSCALE_API,
    );
    expect(tailscaleApiBase({ demo: true, tailscaleApiOverride: 'http://evil.example:80' })).toBe(
      TAILSCALE_API,
    );
    expect(tailscaleApiBase({ demo: true, tailscaleApiOverride: 'http://127.0.0.1:9' })).toBe(
      'http://127.0.0.1:9',
    );
  });
});

describe('onboarding with a Tailscale client', () => {
  it('mints one single-use, preauthorized, tagged key per code; shown once, never stored', async () => {
    const s = await setup();
    await put(s.t, s.cookie, { clientId: CLIENT_ID, clientSecret: SECRET, tag: 'tag:servers' });
    s.fake.calls.length = 0;
    const res = await createOnboardingRaw(s.t, s.cookie, { name: 'oracle', location: 'Cloud' });
    expect(res.statusCode).toBe(201);
    const o = onboardingCreateResponseSchema.parse(res.json());
    expect(o.tailscale).toBe('auto');
    expect(o.tailscaleNote).toBeNull();
    expect(o.oneLiner).toContain(`tailscale up --auth-key=${MINTED} --hostname=oracle ||`);
    expect(o.oneLiner.split(MINTED).length).toBe(2);
    expect(o.plainOneLiner).not.toContain(MINTED);

    const token = s.fake.calls[0];
    expect(token?.path).toBe('/api/v2/oauth/token');
    expect(new URLSearchParams(token?.body).get('grant_type')).toBe('client_credentials');
    const mint = s.fake.calls[1];
    expect(mint?.auth).toBe(`Bearer ${ACCESS}`);
    expect(JSON.parse(mint?.body ?? '{}')).toEqual({
      capabilities: {
        devices: {
          create: { reusable: false, ephemeral: false, preauthorized: true, tags: ['tag:servers'] },
        },
      },
      expirySeconds: 15 * 60,
      description: 'homelab-zentrale oracle',
    });

    for (const text of [dbDump(s.t), s.t.logs.join('\n')]) {
      expect(text).not.toContain(MINTED);
      expect(text).not.toContain(SECRET);
    }
    const audit = s.t.db.sqlite
      .prepare("SELECT details_json d FROM audit_log WHERE action = 'server.onboarding_created'")
      .all() as { d: string }[];
    expect(audit.at(-1)?.d).toBe(
      JSON.stringify({ name: 'oracle', location: 'Cloud', tailscale: 'auto' }),
    );

    // Cancelling the waiting code revokes its unused key.
    s.fake.calls.length = 0;
    const del = await s.t.app.inject({
      method: 'DELETE',
      url: `/api/servers/onboarding/${o.id}`,
      headers: authHeaders(s.cookie),
    });
    expect(del.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.fake.calls.map((c) => `${c.method} ${c.path}`)).toContain(
      'DELETE /api/v2/tailnet/-/keys/kMinted1CNTRL',
    );
  });

  it('falls back to the login link with a German note when minting fails', async () => {
    const fake = fakeTailscale();
    const s = await setup(fake);
    await put(s.t, s.cookie, { clientId: CLIENT_ID, clientSecret: SECRET });
    // From now on the tag is refused.
    fake.opts.keyStatus = 403;
    const res = await createOnboardingRaw(s.t, s.cookie, { name: 'pi', location: 'home' });
    expect(res.statusCode).toBe(201);
    const o = onboardingCreateResponseSchema.parse(res.json());
    expect(o.tailscale).toBe('login');
    expect(o.tailscaleNote).toBe(
      'Tailscale-Schlüssel ging nicht: Keine Berechtigung für Auth-Keys oder diesen Tag',
    );
    expect(o.oneLiner).toContain('tailscale up --hostname=pi ||');
    expect(o.oneLiner).not.toContain('--auth-key');
  });
});

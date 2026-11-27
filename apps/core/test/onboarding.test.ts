import { afterEach, describe, expect, it } from 'vitest';
import {
  INSTALL_SCRIPT_CONTENT_TYPE,
  ONBOARDING_MAX_PENDING,
  onboardingCreateResponseSchema,
  parseOnboardingEnv,
} from '@hz/shared';
import { helloMsg, listen, until, WsClient } from './agent-helpers.js';
import { authHeaders, makeApp, completeSetup, type TestApp } from './helpers.js';
import {
  createOnboarding,
  createOnboardingRaw,
  exchange,
  HUB,
  onboardingApp,
  onboardingState,
} from './onboarding-helpers.js';

let t: TestApp | undefined;
const agents: WsClient[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) a.close();
  await t?.app.close();
  t = undefined;
});

const MIN = 60_000;

describe('POST /api/servers/onboarding', () => {
  it('creates a code with one-liner and expiry, audited without the code', async () => {
    const s = await onboardingApp();
    t = s.t;
    const res = await createOnboardingRaw(t, s.cookie, { name: 'pi', location: 'Keller' });
    expect(res.statusCode).toBe(201);
    const body = onboardingCreateResponseSchema.parse(res.json());
    expect(body.name).toBe('pi');
    expect(body.plainOneLiner).toBe(`curl -fsSL ${HUB}/install.sh | sudo sh -s -- ${body.code}`);
    // No Tailscale client stored: the command joins with the interactive login.
    expect(body.tailscale).toBe('login');
    expect(body.oneLiner).toContain('tailscale up --hostname=pi ||');
    expect(body.oneLiner).not.toContain('--auth-key');
    expect(body.oneLiner.endsWith(`sh "$f" ${body.code}; r=$?; rm -f "$f"; exit $r'`)).toBe(true);
    expect(Date.parse(body.expiresAt) - t.clock.t).toBe(15 * MIN);
    const audit = t.db.sqlite
      .prepare(
        "SELECT target, details_json d FROM audit_log WHERE action = 'server.onboarding_created'",
      )
      .all() as { target: string; d: string }[];
    expect(audit).toEqual([
      {
        target: body.id,
        d: JSON.stringify({ name: 'pi', location: 'Keller', tailscale: 'login' }),
      },
    ]);
    const all = JSON.stringify(t.db.sqlite.prepare('SELECT * FROM onboarding_codes').all());
    expect(all).not.toContain(body.code);
    expect(all).not.toContain(body.code.replace('-', ''));
  });

  it('rejects invalid input with 400', async () => {
    const s = await onboardingApp();
    t = s.t;
    for (const payload of [
      {},
      { name: 'Pi!', location: '' },
      { name: 'pi', location: 'x', extra: 1 },
    ]) {
      const res = await createOnboardingRaw(t, s.cookie, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ ok: false, error: 'invalid_input' });
    }
  });

  it('409 when the name is busy or taken, or too many codes are open', async () => {
    const s = await onboardingApp();
    t = s.t;
    await createOnboarding(t, s.cookie, 'pi');
    expect((await createOnboardingRaw(t, s.cookie, { name: 'pi', location: '' })).statusCode).toBe(
      409,
    );
    for (let i = 1; i < ONBOARDING_MAX_PENDING; i++)
      await createOnboarding(t, s.cookie, `srv-${i}`);
    const full = await createOnboardingRaw(t, s.cookie, { name: 'one-more', location: '' });
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ error: 'conflict' });
    // Expired codes no longer count.
    t.clock.advance(15 * MIN + 1);
    expect(
      (await createOnboardingRaw(t, s.cookie, { name: 'one-more', location: '' })).statusCode,
    ).toBe(201);
  });

  it('without HZ_BASE_URL outside production: the local core on 127.0.0.1', async () => {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    // Production refuses instead (onboarding.security.test.ts, onboardingHub).
    const res = await createOnboardingRaw(t, cookie);
    expect(res.statusCode).toBe(201);
    expect(res.json<{ oneLiner: string }>().oneLiner).toContain('http://127.0.0.1:8080/install.sh');
  });
});

describe('GET/DELETE /api/servers/onboarding/:id', () => {
  it('waiting -> expired after 15 min; unknown id 404; bad id 400', async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    expect(await onboardingState(t, s.cookie, o.id)).toMatchObject({
      state: 'waiting',
      serverId: null,
    });
    t.clock.advance(15 * MIN);
    expect((await onboardingState(t, s.cookie, o.id)).state).toBe('expired');
    const missing = await t.app.inject({
      method: 'GET',
      url: '/api/servers/onboarding/AAAAAAAAAAAAAAAA',
      headers: authHeaders(s.cookie),
    });
    expect(missing.statusCode).toBe(404);
    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/servers/onboarding/x',
      headers: authHeaders(s.cookie),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('cancel makes the code and the enrollment token useless', async () => {
    const s = await onboardingApp();
    t = s.t;
    const a = await createOnboarding(t, s.cookie, 'pi');
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/servers/onboarding/${a.id}`,
      headers: authHeaders(s.cookie),
    });
    expect(del.json()).toEqual({ ok: true });
    expect((await onboardingState(t, s.cookie, a.id)).state).toBe('expired');
    expect((await exchange(t, a.code, '100.64.0.1')).statusCode).toBe(400);

    // Cancel while installing: the agent can no longer enroll.
    const b = await createOnboarding(t, s.cookie, 'pi2');
    const env = parseOnboardingEnv((await exchange(t, b.code, '100.64.0.2')).body);
    expect(env).not.toBeNull();
    expect((await onboardingState(t, s.cookie, b.id)).state).toBe('installing');
    await t.app.inject({
      method: 'DELETE',
      url: `/api/servers/onboarding/${b.id}`,
      headers: authHeaders(s.cookie),
    });
    expect((await onboardingState(t, s.cookie, b.id)).state).toBe('expired');
    const url = await listen(t);
    const agent = await WsClient.connect(`${url}/agent`);
    agents.push(agent);
    agent.send(helloMsg(env?.enrollToken ?? '', { name: 'pi2' }));
    await agent.closed;
    expect(t.app.hzCore.servers.list()).toEqual([]);
    expect(
      t.db.sqlite
        .prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'server.onboarding_cancelled'")
        .get(),
    ).toEqual({ n: 2 });
  });

  it('DELETE without Origin is refused (CSRF), without session 401', async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    const noOrigin = await t.app.inject({
      method: 'DELETE',
      url: `/api/servers/onboarding/${o.id}`,
      headers: { host: 'hz.test', cookie: `hz_session=${s.cookie}` },
    });
    expect(noOrigin.statusCode).toBe(403);
    const anon = await t.app.inject({ method: 'GET', url: `/api/servers/onboarding/${o.id}` });
    expect(anon.statusCode).toBe(401);
  });
});

describe('GET /install.sh', () => {
  it('serves the script with the configured hub URL', async () => {
    const s = await onboardingApp();
    t = s.t;
    const res = await t.app.inject({ method: 'GET', url: '/install.sh' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(INSTALL_SCRIPT_CONTENT_TYPE);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.startsWith('#!/bin/sh\n')).toBe(true);
    expect(res.body).toContain(`HUB='${HUB}'`);
    expect(res.body).toContain("EXCHANGE_PATH='/api/onboarding/exchange'");
    expect(res.body).toContain('set -eu');
    expect(res.body).not.toContain('@@');
  });
});

describe('end to end with the fake agent', () => {
  it('code -> exchange -> hello with the enroll token -> online -> connected', async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie, 'pi');
    const res = await exchange(t, o.code.toLowerCase());
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    const env = parseOnboardingEnv(res.body);
    expect(env).toMatchObject({
      hubUrl: 'wss://hz.test/agent',
      name: 'pi',
      agentImage: 'ghcr.io/puffybooy/homelab-agent:latest',
    });
    expect(await onboardingState(t, s.cookie, o.id)).toMatchObject({
      state: 'installing',
      serverId: null,
    });

    const url = await listen(t);
    const agent = await WsClient.connect(`${url}/agent`);
    agents.push(agent);
    agent.send(helloMsg(env?.enrollToken ?? '', { name: 'pi' }));
    const enrolled = await agent.nextOfType('enrolled');
    await agent.nextOfType('welcome');
    const serverId = enrolled.serverId as string;
    await until(() => t?.app.hzCore.servers.isConnected(serverId) === true);
    const st = await onboardingState(t, s.cookie, o.id);
    expect(st).toMatchObject({ state: 'connected', serverId });
    const server = await t.app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}`,
      headers: authHeaders(s.cookie),
    });
    expect(server.json()).toMatchObject({
      server: { name: 'pi', location: 'home', connected: true },
    });
    const actions = (
      t.db.sqlite.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'server.onboarding_created',
        'server.onboarding_exchanged',
        'server.enrolled',
      ]),
    );
  });
});

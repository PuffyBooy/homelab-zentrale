import { afterEach, describe, expect, it } from 'vitest';
import {
  authStateSchema,
  MODULE_DEFAULTS,
  recoveryCodesResponseSchema,
  sessionListResponseSchema,
  setupStartResponseSchema,
} from '@hz/shared';
import { auditLog, recoveryCodes, sessions, users } from '../src/db/schema.js';
import {
  authHeaders,
  completeSetup,
  login,
  makeApp,
  PASSWORD,
  SAME_ORIGIN,
  SETUP_TOKEN,
  sessionCookie,
  totpCode,
  USERNAME,
  type TestApp,
} from './helpers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

function actions(t: TestApp): string[] {
  return t.db.db
    .select()
    .from(auditLog)
    .all()
    .map((r) => r.action);
}

describe('setup', () => {
  it('reports setupRequired before the first admin exists', async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(res.statusCode).toBe(200);
    expect(authStateSchema.parse(res.json())).toEqual({
      setupRequired: true,
      authenticated: false,
    });
  });

  it('creates the admin with argon2id, encrypted TOTP and 10 hashed recovery codes', async () => {
    t = await makeApp();
    const start = await t.app.inject({
      method: 'POST',
      url: '/api/setup/start',
      headers: SAME_ORIGIN,
      payload: { setupToken: SETUP_TOKEN, username: 'Admin', password: PASSWORD },
    });
    expect(start.statusCode).toBe(200);
    const s = setupStartResponseSchema.parse(start.json());
    expect(s.otpauthUri).toContain('issuer=Homelab-Zentrale');
    expect(s.otpauthUri).toContain('algorithm=SHA1');
    expect(s.otpauthUri).toContain('digits=6');
    expect(s.otpauthUri).toContain('period=30');
    expect(s.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(s.qrSvg).not.toMatch(/<script|style=/i);
    // Nothing is stored before the TOTP is confirmed.
    expect(t.db.db.select().from(users).all()).toHaveLength(0);

    const confirm = await t.app.inject({
      method: 'POST',
      url: '/api/setup/confirm',
      headers: SAME_ORIGIN,
      payload: { setupToken: SETUP_TOKEN, code: totpCode(s.secret, t.clock.t) },
    });
    expect(confirm.statusCode).toBe(200);
    const { recoveryCodes: codes } = recoveryCodesResponseSchema.parse(confirm.json());
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);

    const [user] = t.db.db.select().from(users).all();
    expect(user?.username).toBe('admin');
    expect(user?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(user?.totpSecretEnc).toMatch(/^v1:/);
    expect(user?.totpSecretEnc).not.toContain(s.secret);
    const stored = t.db.db.select().from(recoveryCodes).all();
    expect(stored).toHaveLength(10);
    for (const r of stored) {
      expect(r.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(codes.some((c) => r.codeHash.includes(c.replace('-', '')))).toBe(false);
    }

    // Logged in right away.
    const state = await t.app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: authHeaders(sessionCookie(confirm)),
    });
    expect(state.json()).toEqual({
      setupRequired: false,
      authenticated: true,
      username: USERNAME,
      modules: {
        ...MODULE_DEFAULTS,
        github: true,
        homeassistant: true,
        games: true,
        storage: true,
      },
      timeZone: 'Europe/Vienna',
    });
    expect(actions(t)).toContain('setup.complete');
  });

  it('requires setup/start before confirm', async () => {
    t = await makeApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/setup/confirm',
      headers: SAME_ORIGIN,
      payload: { setupToken: SETUP_TOKEN, code: '123456' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: 'setup_invalid' });
  });

  it('rejects a wrong TOTP code on confirm', async () => {
    t = await makeApp();
    const start = await t.app.inject({
      method: 'POST',
      url: '/api/setup/start',
      headers: SAME_ORIGIN,
      payload: { setupToken: SETUP_TOKEN, username: USERNAME, password: PASSWORD },
    });
    const secret = start.json<{ secret: string }>().secret;
    const good = totpCode(secret, t.clock.t);
    const bad = good === '000000' ? '111111' : '000000';
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/setup/confirm',
      headers: SAME_ORIGIN,
      payload: { setupToken: SETUP_TOKEN, code: bad },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, error: 'invalid_credentials' });
    expect(t.db.db.select().from(users).all()).toHaveLength(0);
  });

  it('rejects a short password', async () => {
    t = await makeApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/setup/start',
      headers: SAME_ORIGIN,
      payload: { setupToken: SETUP_TOKEN, username: USERNAME, password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: 'invalid_input' });
  });
});

describe('login', () => {
  it('logs in with password + TOTP and returns the auth state', async () => {
    t = await makeApp();
    const { secret } = await completeSetup(t);
    const res = await login(t, totpCode(secret, t.clock.t));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      setupRequired: false,
      authenticated: true,
      username: USERNAME,
      modules: {
        ...MODULE_DEFAULTS,
        github: true,
        homeassistant: true,
        games: true,
        storage: true,
      },
      timeZone: 'Europe/Vienna',
    });
    const cookie = sessionCookie(res);
    const state = await t.app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: authHeaders(cookie),
    });
    expect(state.json<{ authenticated: boolean }>().authenticated).toBe(true);
    expect(actions(t)).toContain('auth.login');
  });

  it('accepts the username case-insensitively', async () => {
    t = await makeApp();
    const { secret } = await completeSetup(t);
    const res = await login(t, totpCode(secret, t.clock.t), { username: 'ADMIN' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong password, a wrong TOTP and an unknown user with the same answer', async () => {
    t = await makeApp();
    const { secret } = await completeSetup(t);
    const code = totpCode(secret, t.clock.t);
    const wrongCode = code === '000000' ? '111111' : '000000';
    for (const res of [
      await login(t, code, { password: 'wrong password!!' }),
      await login(t, wrongCode),
      await login(t, code, { username: 'mallory' }),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ ok: false, error: 'invalid_credentials' });
      expect(res.cookies).toHaveLength(0);
    }
    expect(actions(t).filter((a) => a === 'auth.login_failed')).toHaveLength(3);
  });

  it('accepts a code from the previous and next 30 s window, not further', async () => {
    t = await makeApp();
    const { secret } = await completeSetup(t);
    t.clock.advance(120_000);
    expect((await login(t, totpCode(secret, t.clock.t - 30_000))).statusCode).toBe(200);
    t.clock.advance(60_000);
    expect((await login(t, totpCode(secret, t.clock.t + 30_000))).statusCode).toBe(200);
    t.clock.advance(120_000);
    expect((await login(t, totpCode(secret, t.clock.t - 60_000))).statusCode).toBe(401);
  });

  it('logs in once with a recovery code, then the code is used up', async () => {
    t = await makeApp();
    const { recoveryCodes: codes } = await completeSetup(t);
    const code = codes[0] ?? '';
    const ok = await login(t, code.toUpperCase());
    expect(ok.statusCode).toBe(200);
    const again = await login(t, code);
    expect(again.statusCode).toBe(401);
    // Without the dash works too (other code).
    expect((await login(t, (codes[1] ?? '').replace('-', ''))).statusCode).toBe(200);
    const used = t.db.db
      .select()
      .from(recoveryCodes)
      .all()
      .filter((r) => r.usedAt !== null);
    expect(used).toHaveLength(2);
  });
});

describe('sessions', () => {
  it('logout revokes the session and clears the cookie', async () => {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: authHeaders(cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const cleared = res.cookies.find((c) => c.name === 'hz_session');
    expect(cleared?.value).toBe('');
    expect(cleared?.maxAge).toBe(0);
    const after = await t.app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: authHeaders(cookie),
    });
    expect(after.statusCode).toBe(401);
    expect(actions(t)).toContain('auth.logout');
  });

  it('lists sessions without secrets and revokes another session', async () => {
    t = await makeApp();
    const { secret, cookie } = await completeSetup(t);
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { ...SAME_ORIGIN, 'user-agent': 'Tablet' },
      payload: { username: USERNAME, password: PASSWORD, code: totpCode(secret, t.clock.t) },
    });
    const cookie2 = sessionCookie(second);

    const list = await t.app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: authHeaders(cookie),
    });
    expect(list.statusCode).toBe(200);
    const parsed = sessionListResponseSchema.parse(list.json());
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.sessions.filter((s) => s.current)).toHaveLength(1);
    expect(list.body).not.toContain(cookie);
    expect(list.body).not.toContain(cookie2);
    const hashes = t.db.db
      .select()
      .from(sessions)
      .all()
      .map((s) => s.tokenHash);
    for (const h of hashes) expect(list.body).not.toContain(h);

    const other = parsed.sessions.find((s) => !s.current);
    expect(other?.userAgent).toBe('Tablet');
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${other?.id ?? ''}`,
      headers: authHeaders(cookie),
    });
    expect(del.statusCode).toBe(200);
    expect(actions(t)).toContain('auth.session_revoked');

    const revoked = await t.app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: authHeaders(cookie2),
    });
    expect(revoked.json<{ authenticated: boolean }>().authenticated).toBe(false);
  });

  it('revoking an unknown or malformed id gives 404 / 400', async () => {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    const missing = await t.app.inject({
      method: 'DELETE',
      url: '/api/auth/sessions/AAAAAAAAAAAAAAAAAAAAAA',
      headers: authHeaders(cookie),
    });
    expect(missing.statusCode).toBe(404);
    const bad = await t.app.inject({
      method: 'DELETE',
      url: '/api/auth/sessions/x',
      headers: authHeaders(cookie),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ ok: false, error: 'invalid_input' });
  });

  it('slides the expiry, writing at most once per minute', async () => {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    const before = t.db.db.select().from(sessions).get();
    t.clock.advance(10_000);
    const r1 = await t.app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: authHeaders(cookie),
    });
    expect(r1.cookies).toHaveLength(0);
    expect(t.db.db.select().from(sessions).get()?.expiresAt).toBe(before?.expiresAt);
    t.clock.advance(60_000);
    const r2 = await t.app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: authHeaders(cookie),
    });
    expect(r2.cookies.find((c) => c.name === 'hz_session')?.value).toBe(cookie);
    expect(t.db.db.select().from(sessions).get()?.expiresAt).toBe(t.clock.t + 30 * 86_400_000);
  });

  it('expires after 30 days without use', async () => {
    t = await makeApp();
    const { cookie } = await completeSetup(t);
    t.clock.advance(30 * 86_400_000 + 1000);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: authHeaders(cookie),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('step-up protected account changes', () => {
  async function stepUp(t: TestApp, secret: string, cookie: string): Promise<void> {
    t.clock.advance(30_000);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: authHeaders(cookie),
      payload: { code: totpCode(secret, t.clock.t) },
    });
    expect(res.statusCode).toBe(200);
  }

  it('regenerates recovery codes, old ones stop working', async () => {
    t = await makeApp();
    const { secret, cookie, recoveryCodes: old } = await completeSetup(t);
    await stepUp(t, secret, cookie);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/recovery-codes',
      headers: authHeaders(cookie),
    });
    expect(res.statusCode).toBe(200);
    const { recoveryCodes: fresh } = recoveryCodesResponseSchema.parse(res.json());
    expect(fresh.some((c) => old.includes(c))).toBe(false);
    expect((await login(t, old[0] ?? '')).statusCode).toBe(401);
    expect((await login(t, fresh[0] ?? '')).statusCode).toBe(200);
    expect(actions(t)).toContain('auth.recovery_codes_regenerated');
  });

  it('changes the password and revokes the other sessions', async () => {
    t = await makeApp();
    const { secret, cookie } = await completeSetup(t);
    const other = sessionCookie(await login(t, totpCode(secret, t.clock.t)));
    await stepUp(t, secret, cookie);

    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: authHeaders(cookie),
      payload: { currentPassword: 'not my password', newPassword: 'a brand new passphrase' },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ ok: false, error: 'invalid_credentials' });

    const short = await t.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: authHeaders(cookie),
      payload: { currentPassword: PASSWORD, newPassword: 'short' },
    });
    expect(short.statusCode).toBe(400);

    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: authHeaders(cookie),
      payload: { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' },
    });
    expect(ok.statusCode).toBe(200);
    expect(actions(t)).toContain('auth.password_changed');

    const otherState = await t.app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: authHeaders(other),
    });
    expect(otherState.json<{ authenticated: boolean }>().authenticated).toBe(false);

    t.clock.advance(30_000);
    expect((await login(t, totpCode(secret, t.clock.t))).statusCode).toBe(401);
    expect(
      (await login(t, totpCode(secret, t.clock.t), { password: 'a brand new passphrase' }))
        .statusCode,
    ).toBe(200);
  });
});

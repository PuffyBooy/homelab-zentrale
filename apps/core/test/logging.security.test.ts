import { afterEach, describe, expect, it } from 'vitest';
import { auditLog, users } from '../src/db/schema.js';
import { createSecretBox } from '../src/crypto.js';
import {
  authHeaders,
  completeSetup,
  KEY,
  login,
  makeApp,
  PASSWORD,
  SAME_ORIGIN,
  SETUP_TOKEN,
  totpCode,
  type TestApp,
} from './helpers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

/** Runs every auth flow and returns everything secret that was involved. */
async function runAllFlows(t: TestApp): Promise<{ secrets: string[]; bodies: string[] }> {
  const bodies: string[] = [];
  const { secret, cookie, recoveryCodes } = await completeSetup(t);
  const l = await login(t, totpCode(secret, t.clock.t));
  bodies.push(l.body);
  const cookie2 = l.cookies[0]?.value ?? '';
  await login(t, '000000', { password: 'wrong-password-in-log?' });
  await login(t, recoveryCodes[0] ?? '');
  t.clock.advance(30_000);
  const stepUpCode = totpCode(secret, t.clock.t);
  bodies.push(
    (
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/step-up',
        headers: authHeaders(cookie),
        payload: { code: stepUpCode },
      })
    ).body,
  );
  const regen = await t.app.inject({
    method: 'POST',
    url: '/api/auth/recovery-codes',
    headers: authHeaders(cookie),
  });
  const fresh = regen.json<{ recoveryCodes: string[] }>().recoveryCodes;
  await t.app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: authHeaders(cookie),
    payload: { currentPassword: PASSWORD, newPassword: 'the new secret passphrase' },
  });
  for (const url of ['/api/auth/state', '/api/auth/sessions']) {
    bodies.push((await t.app.inject({ method: 'GET', url, headers: authHeaders(cookie) })).body);
  }
  // Malformed body with a password inside.
  bodies.push(
    (
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
        payload: `{"password":"${PASSWORD}"`,
      })
    ).body,
  );
  const user = t.db.db.select().from(users).get();
  return {
    secrets: [
      PASSWORD,
      'the new secret passphrase',
      'wrong-password-in-log?',
      secret,
      stepUpCode,
      cookie,
      cookie2,
      SETUP_TOKEN,
      KEY,
      user?.passwordHash ?? 'missing',
      user?.totpSecretEnc ?? 'missing',
      ...recoveryCodes,
      ...recoveryCodes.map((c) => c.replace('-', '')),
      ...fresh,
    ],
    bodies,
  };
}

describe('secrets stay out of logs, responses and the audit log', () => {
  it('logs contain no password, TOTP secret, code, session id or recovery code', async () => {
    t = await makeApp({ captureLogs: true });
    const { secrets } = await runAllFlows(t);
    const log = t.logs.join('');
    expect(log.length).toBeGreaterThan(0);
    expect(log).toContain('incoming request');
    for (const s of secrets) {
      // A 6-digit TOTP code can show up by chance inside numbers (responseTime
      // 1.0000023); a leaked code would be a JSON string, so look for that form.
      const needle = /^\d{6}$/.test(s) ? `"${s}"` : s;
      expect(log, `log leaks ${s.slice(0, 4)}...`).not.toContain(needle);
    }
    expect(log).not.toMatch(/hz_session=/);
  });

  it('responses contain no secret outside the one-time setup and regeneration answers', async () => {
    t = await makeApp();
    const { secrets, bodies } = await runAllFlows(t);
    for (const body of bodies) {
      for (const s of secrets) expect(body).not.toContain(s);
    }
  });

  it('the audit log records every change without secrets', async () => {
    t = await makeApp();
    const { secrets } = await runAllFlows(t);
    const rows = t.db.db.select().from(auditLog).all();
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'setup.complete',
        'auth.login',
        'auth.login_failed',
        'auth.step_up',
        'auth.recovery_codes_regenerated',
        'auth.password_changed',
      ]),
    );
    const dump = JSON.stringify(rows);
    for (const s of secrets) expect(dump).not.toContain(s);
  });

  it('the TOTP secret is stored encrypted under the configured key', async () => {
    t = await makeApp();
    const { secret } = await completeSetup(t);
    const enc = t.db.db.select().from(users).get()?.totpSecretEnc ?? '';
    const box = createSecretBox(Buffer.from(KEY, 'base64'));
    expect(box.decrypt(enc, 'users.totp_secret')).toBe(secret);
    const dump = JSON.stringify(t.db.sqlite.prepare('SELECT * FROM users').all());
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(PASSWORD);
  });
});

describe('setup link', () => {
  it('is logged once with a random token that works; HZ_SETUP_TOKEN is not logged', async () => {
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const { openDatabase } = await import('../src/db/index.js');
    const { Writable } = await import('node:stream');
    const { emptyDir } = await import('./helpers.js');
    const logs: string[] = [];
    const app = await buildApp(
      loadConfig({
        HZ_SECRET_KEY: KEY,
        NODE_ENV: 'test',
        HZ_WEB_DIR: emptyDir(),
        HZ_PORT: '8097',
      }),
      {
        db: openDatabase(':memory:'),
        logStream: new Writable({
          write(c: Buffer, _e, cb) {
            logs.push(c.toString());
            cb();
          },
        }),
      },
    );
    try {
      const matches = logs
        .join('')
        .match(/http:\/\/127\.0\.0\.1:8097\/setup#token=([A-Za-z0-9_-]{43})/g);
      expect(matches).toHaveLength(1);
      const token = (matches?.[0] ?? '').split('#token=')[1] ?? '';
      const res = await app.inject({
        method: 'POST',
        url: '/api/setup/start',
        headers: SAME_ORIGIN,
        payload: { setupToken: token, username: 'admin', password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    t = await makeApp({ captureLogs: true });
    expect(t.logs.join('')).not.toContain(SETUP_TOKEN);
    expect(t.logs.join('')).toContain('HZ_SETUP_TOKEN');
  });

  it('uses HZ_BASE_URL for the link', async () => {
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const { openDatabase } = await import('../src/db/index.js');
    const { Writable } = await import('node:stream');
    const { emptyDir } = await import('./helpers.js');
    const logs: string[] = [];
    const app = await buildApp(
      loadConfig({
        HZ_SECRET_KEY: KEY,
        NODE_ENV: 'test',
        HZ_WEB_DIR: emptyDir(),
        HZ_BASE_URL: 'https://heimserver.tail1234.ts.net/',
      }),
      {
        db: openDatabase(':memory:'),
        logStream: new Writable({
          write(c: Buffer, _e, cb) {
            logs.push(c.toString());
            cb();
          },
        }),
      },
    );
    await app.close();
    expect(logs.join('')).toMatch(/https:\/\/heimserver\.tail1234\.ts\.net\/setup#token=/);
  });
});

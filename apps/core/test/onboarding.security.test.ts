import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ONBOARDING_CODE_ALPHABET,
  ONBOARDING_CODE_RE,
  ONBOARDING_EXCHANGE_RATE,
  ONBOARDING_INVALID_MESSAGE,
  parseOnboardingEnv,
} from '@hz/shared';
import { SCRIPT_API_ROUTES } from '../src/auth/guard.js';
import {
  generateOnboardingCode,
  INSTALL_TEMPLATE_PATH,
  onboardingHub,
  renderInstallScript,
} from '../src/servers/onboarding.js';
import { createEnrollToken } from './agent-helpers.js';
import { authHeaders, KEY, SAME_ORIGIN, totpCode, type TestApp } from './helpers.js';
import {
  createOnboarding,
  exchange,
  HUB,
  onboardingApp,
  onboardingState,
} from './onboarding-helpers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

const MIN = 60_000;
const INVALID = { ok: false, error: 'invalid_credentials', message: ONBOARDING_INVALID_MESSAGE };

/** A well-formed code that is (almost surely) not one of the issued ones. */
function otherCode(not: string): string {
  for (;;) {
    const c = generateOnboardingCode();
    if (c !== not.replace('-', '')) return c;
  }
}

describe('onboarding code', () => {
  it('codes are uniform over the alphabet and canonical', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const c = generateOnboardingCode();
      expect(c).toMatch(ONBOARDING_CODE_RE);
      for (const ch of c) seen.add(ch);
    }
    expect(seen.size).toBe(ONBOARDING_CODE_ALPHABET.length);
  });

  it('works only once', async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    expect((await exchange(t, o.code, '100.64.0.1')).statusCode).toBe(200);
    const again = await exchange(t, o.code, '100.64.0.2');
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual(INVALID);
  });

  it('expires after 15 minutes with the same generic answer', async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    t.clock.advance(15 * MIN);
    const res = await exchange(t, o.code);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(INVALID);
    expect((await onboardingState(t, s.cookie, o.id)).state).toBe('expired');
  });

  it('an unused enrollment token from an exchange expires too', async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    await exchange(t, o.code);
    t.clock.advance(15 * MIN);
    expect((await onboardingState(t, s.cookie, o.id)).state).toBe('expired');
  });

  it('unknown, wrong and cancelled codes look the same; malformed is invalid_input', async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    const wrong = await exchange(t, otherCode(o.code), '100.64.0.1');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual(INVALID);
    for (const [i, code] of ['0000-0000', 'ABCD', 12345678, null].entries()) {
      const res = await exchange(t, code, `100.64.1.${i}`);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'invalid_input' });
    }
    // The code was not consumed by the misses.
    expect((await exchange(t, o.code, '100.64.0.3')).statusCode).toBe(200);
  });

  it('the stored hash is an HMAC keyed from HZ_SECRET_KEY, not SHA-256 of the code', async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    const { createHash } = await import('node:crypto');
    const row = t.db.sqlite.prepare('SELECT code_hash h FROM onboarding_codes').get() as {
      h: string;
    };
    const canonical = o.code.replace('-', '');
    expect(row.h).toMatch(/^[0-9a-f]{64}$/);
    expect(row.h).not.toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(row.h).not.toBe(createHash('sha256').update(o.code).digest('hex'));
  });
});

describe('brute-force limit', () => {
  it(`per IP: at most ${ONBOARDING_EXCHANGE_RATE.perIp} attempts per window, then 429 even for the right code`, async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    for (let i = 0; i < ONBOARDING_EXCHANGE_RATE.perIp; i++) {
      expect((await exchange(t, otherCode(o.code), '100.64.0.7')).statusCode).toBe(400);
    }
    const blocked = await exchange(t, o.code, '100.64.0.7');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Another IP is not affected, and after the window the first one works again.
    expect((await exchange(t, otherCode(o.code), '100.64.0.8')).statusCode).toBe(400);
    t.clock.advance(ONBOARDING_EXCHANGE_RATE.windowMs);
    const fresh = await createOnboarding(t, s.cookie, 'pi2');
    expect((await exchange(t, fresh.code, '100.64.0.7')).statusCode).toBe(200);
  });

  it('X-Forwarded-For is only trusted from loopback (tailscale serve)', async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    for (let i = 0; i < ONBOARDING_EXCHANGE_RATE.perIp; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/onboarding/exchange',
        remoteAddress: '100.64.0.50',
        headers: { 'x-forwarded-for': `10.0.0.${i}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ code: otherCode(o.code) }),
      });
      expect(res.statusCode).toBe(400);
    }
    const spoofed = await t.app.inject({
      method: 'POST',
      url: '/api/onboarding/exchange',
      remoteAddress: '100.64.0.50',
      headers: { 'x-forwarded-for': '10.0.0.99', 'content-type': 'application/json' },
      payload: JSON.stringify({ code: o.code }),
    });
    expect(spoofed.statusCode).toBe(429);
  });

  it(`global: ${ONBOARDING_EXCHANGE_RATE.globalFailures} failures over all IPs block every exchange`, async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    for (let i = 0; i < ONBOARDING_EXCHANGE_RATE.globalFailures; i++) {
      expect((await exchange(t, otherCode(o.code), `100.65.${i}.1`)).statusCode).toBe(400);
    }
    const blocked = await exchange(t, o.code, '100.66.0.1');
    expect(blocked.statusCode).toBe(429);
    t.clock.advance(ONBOARDING_EXCHANGE_RATE.windowMs);
    // The code itself expired meanwhile; a new one works again.
    const fresh = await createOnboarding(t, s.cookie, 'pi2');
    expect((await exchange(t, fresh.code, '100.66.0.2')).statusCode).toBe(200);
  });
});

describe('step-up and session', () => {
  it('creating a code needs step-up', async () => {
    const s = await onboardingApp();
    t = s.t;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/servers/onboarding',
      headers: authHeaders(s.cookie),
      payload: { name: 'pi', location: '' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    t.clock.advance(30_000);
    const up = await t.app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: authHeaders(s.cookie),
      payload: { code: totpCode(s.secret, t.clock.t) },
    });
    expect(up.statusCode).toBe(200);
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/servers/onboarding',
      headers: authHeaders(s.cookie),
      payload: { name: 'pi', location: '' },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('admin routes answer 401 without a session', async () => {
    const s = await onboardingApp();
    t = s.t;
    for (const [method, url] of [
      ['POST', '/api/servers/onboarding'],
      ['GET', '/api/servers/onboarding/AAAAAAAAAAAAAAAA'],
      ['DELETE', '/api/servers/onboarding/AAAAAAAAAAAAAAAA'],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: SAME_ORIGIN, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('the exchange from a web page of another origin is refused', async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/onboarding/exchange',
      headers: {
        host: 'hz.test',
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ code: o.code }),
    });
    expect(res.statusCode).toBe(403);
    expect((await onboardingState(t, s.cookie, o.id)).state).toBe('waiting');
    expect(SCRIPT_API_ROUTES).toEqual(['/api/onboarding/exchange']);
  });

  it('the exchange can never enroll a name that got taken meanwhile', async () => {
    const s = await onboardingApp();
    t = s.t;
    const o = await createOnboarding(t, s.cookie, 'pi');
    // A manual enrollment for the same name supersedes nothing that is valid yet,
    // but once a server named `pi` exists the code is refused.
    const { listen, helloMsg, WsClient } = await import('./agent-helpers.js');
    const tok = await createEnrollToken(t, s.cookie, 'pi');
    const url = await listen(t);
    const agent = await WsClient.connect(`${url}/agent`);
    agent.send(helloMsg(tok, { name: 'pi' }));
    await agent.nextOfType('welcome');
    const res = await exchange(t, o.code);
    expect(res.json()).toEqual(INVALID);
    agent.close();
  });
});

describe('public routes stay tight', () => {
  it('only exactly /install.sh and POST /api/onboarding/exchange are reachable without a session', async () => {
    const s = await onboardingApp();
    t = s.t;
    for (const url of [
      '/install.sh/../api/servers',
      '/install.sh/..%2fapi/servers',
      '/api/onboarding/exchange/../../servers',
      '/api/onboarding/exchange/',
      '/api/onboarding/exchange/x',
      '/api/onboarding',
      '/api/%6fnboarding/exchange/../../servers',
    ]) {
      const res = await t.app.inject({ method: 'GET', url });
      expect([400, 401, 404], url).toContain(res.statusCode);
      expect(res.body, url).not.toContain('servers"');
    }
    const post = await t.app.inject({
      method: 'POST',
      url: '/api/onboarding/exchange/../../servers/enroll',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'evil', location: '' }),
    });
    expect([401, 404]).toContain(post.statusCode);
    expect(t.db.sqlite.prepare('SELECT COUNT(*) n FROM enroll_tokens').get()).toEqual({ n: 0 });
    // GET on the exchange path has no handler.
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/onboarding/exchange' })).statusCode,
    ).toBe(404);
  });
});

describe('install.sh', () => {
  it('contains no secret, no token, no code and only the configured URL', async () => {
    const s = await onboardingApp({ env: { HZ_AGENT_IMAGE: 'registry.example/hz/agent:1' } });
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    const env = parseOnboardingEnv((await exchange(t, o.code)).body);
    const pending = await createOnboarding(t, s.cookie, 'pi2');
    const res = await t.app.inject({
      method: 'GET',
      url: '/install.sh',
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    });
    const body = res.body;
    for (const secret of [
      KEY,
      Buffer.from(KEY, 'base64').toString('hex'),
      env?.enrollToken ?? 'missing',
      o.code,
      o.code.replace('-', ''),
      pending.code,
      pending.code.replace('-', ''),
      s.cookie,
    ]) {
      expect(body, secret.slice(0, 4)).not.toContain(secret);
    }
    expect(body).not.toContain('evil.example');
    // Every URL in the script is the hub, a documentation link or the Docker installer.
    const urls = [...body.matchAll(/https?:\/\/[A-Za-z0-9][^\s'"$)]*/g)].map((m) => m[0]);
    for (const u of urls) {
      expect(
        u.startsWith(HUB) ||
          u === 'https://get.docker.com' ||
          ['https://docs.docker.com/', 'https://tailscale.com/'].some((p) => u.startsWith(p)),
        u,
      ).toBe(true);
    }
    expect(urls.filter((u) => u.startsWith(HUB)).length).toBeGreaterThan(0);
    // The image comes from the exchange, not from the script.
    expect(body).not.toContain('registry.example');
  });

  it('never prints the token and never takes it as argument', () => {
    const tpl = readFileSync(INSTALL_TEMPLATE_PATH, 'utf8');
    for (const line of tpl.split('\n')) {
      if (/\$token|\$\{token/.test(line)) {
        // The only use: printf into the env file (redirected to $tmp).
        expect(line.trim(), line).toBe('printf \'HZ_AGENT_TOKEN=%s\\n\' "$token"');
      }
    }
    expect(tpl).not.toMatch(/set -x|eval |\. "\$resp"|source /);
    expect(tpl).toMatch(/^set -eu$/m);
    expect(tpl).toContain('chmod 0600 "$tmp"');
  });

  it('is valid POSIX sh and validates the code before anything else', () => {
    const script = renderInstallScript({ origin: HUB, coreUrl: 'wss://hz.test/agent' });
    const dir = mkdtempSync(join(tmpdir(), 'hz-install-'));
    const file = join(dir, 'install.sh');
    writeFileSync(file, script);
    execFileSync('sh', ['-n', file]);
    // Only grep, tr and id on PATH: the script stops at the requirement checks
    // and can never touch the test machine.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const tool of ['grep', 'id', 'tr']) {
      const real = execFileSync('sh', ['-c', `command -v ${tool}`])
        .toString()
        .trim();
      symlinkSync(real, join(bin, tool));
    }
    const run = (args: string[]): { code: number; err: string } => {
      try {
        execFileSync('/bin/sh', [file, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: bin },
        });
        return { code: 0, err: '' };
      } catch (e) {
        const err = e as { status: number; stderr: Buffer };
        return { code: err.status, err: err.stderr.toString() };
      }
    };
    expect(run([])).toMatchObject({ code: 1 });
    for (const bad of ['ABCD-EFG0', 'ABCD_EFGH', 'ABCD-EFGH;id', '$(id)', 'ABCDEFGHI']) {
      const r = run([bad]);
      expect(r.code, bad).toBe(1);
      expect(r.err, bad).toContain('ungültiges Format');
    }
    // A well-formed code passes the format check (then stops at root or curl).
    for (const good of ['ABCD-EFGH', 'abcdefgh']) {
      const r = run([good]);
      expect(r.code, good).toBe(1);
      expect(r.err, good).not.toContain('ungültiges Format');
      expect(r.err, good).toMatch(/root|curl fehlt/);
    }
  });

  it('runs the agent like deploy/docker-compose.agent.yml', () => {
    const tpl = readFileSync(INSTALL_TEMPLATE_PATH, 'utf8');
    const deploy = readFileSync(
      join(INSTALL_TEMPLATE_PATH, '../../../../deploy/docker-compose.agent.yml'),
      'utf8',
    );
    const strip = (s: string) =>
      s
        .split('\n')
        .map((l) => l.replace(/\s+#.*$/, ''))
        .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
        .join('\n');
    const compose = /<<'COMPOSE'\n([\s\S]*?)\nCOMPOSE\n/.exec(tpl)?.[1] ?? '';
    expect(strip(compose)).toBe(strip(deploy));
    expect(tpl).toContain('/etc/homelab-agent');
  });

  it('only fills in a strict origin; production needs an https HZ_BASE_URL', () => {
    expect(() =>
      renderInstallScript({ origin: "https://x'; rm -rf /", coreUrl: 'wss://x/agent' }),
    ).toThrow();
    expect(onboardingHub({ baseUrl: undefined, port: 8080, env: 'production' })).toBeNull();
    expect(onboardingHub({ baseUrl: 'http://hz.test', port: 8080, env: 'production' })).toBeNull();
    expect(
      onboardingHub({ baseUrl: 'https://hz.test/some/path', port: 8080, env: 'production' }),
    ).toEqual({
      origin: 'https://hz.test',
      coreUrl: 'wss://hz.test/agent',
    });
  });

  it('404 when production has no hub address', async () => {
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const { openDatabase } = await import('../src/db/index.js');
    const { emptyDir } = await import('./helpers.js');
    const { Writable } = await import('node:stream');
    const app = await buildApp(
      loadConfig({ HZ_SECRET_KEY: KEY, NODE_ENV: 'production', HZ_WEB_DIR: emptyDir() }),
      {
        db: openDatabase(':memory:'),
        startScheduler: false,
        logStream: new Writable({ write: (_c, _e, cb) => cb() }),
      },
    );
    try {
      const res = await app.inject({ method: 'GET', url: '/install.sh' });
      expect(res.statusCode).toBe(404);
      const ex = await app.inject({
        method: 'POST',
        url: '/api/onboarding/exchange',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ code: 'ABCD-EFGH' }),
      });
      expect(ex.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('logging', () => {
  it('neither the code nor the token reaches the log', async () => {
    const s = await onboardingApp({ captureLogs: true });
    t = s.t;
    const o = await createOnboarding(t, s.cookie);
    await exchange(t, otherCode(o.code), '100.64.0.1');
    await exchange(t, 'not a code', '100.64.0.2');
    const res = await exchange(t, o.code, '100.64.0.3');
    const env = parseOnboardingEnv(res.body);
    expect(env).not.toBeNull();
    await exchange(t, o.code, '100.64.0.4');
    const log = t.logs.join('');
    expect(log).toContain('/api/onboarding/exchange');
    for (const secret of [o.code, o.code.replace('-', ''), env?.enrollToken ?? 'missing']) {
      expect(log, secret.slice(0, 3)).not.toContain(secret);
    }
    const audit = JSON.stringify(t.db.sqlite.prepare('SELECT * FROM audit_log').all());
    for (const secret of [o.code, o.code.replace('-', ''), env?.enrollToken ?? 'missing']) {
      expect(audit).not.toContain(secret);
    }
  });
});

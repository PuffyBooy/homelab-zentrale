import { spawn, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderInstallScript } from '../src/servers/onboarding.js';
import { helloMsg, until, WsClient } from './agent-helpers.js';
import { completeSetup, makeApp, type TestApp } from './helpers.js';
import { createOnboarding, onboardingState } from './onboarding-helpers.js';

/*
 * install.sh end to end: the script is fetched with the real curl from the
 * live test app (http on 127.0.0.1, which only a non-production core offers)
 * and run with sh. id, docker and tailscale are PATH stubs; the install paths
 * point into a temp dir via HZ_TEST_CONF_DIR/HZ_TEST_HOMELAB_DIR, which only a
 * core in NODE_ENV=test renders as overridable.
 */

let t: TestApp | undefined;
const agents: WsClient[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) a.close();
  await t?.app.close();
  t = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Live app whose hub address (http://127.0.0.1:<port>) is the port it listens on. */
async function liveApp(): Promise<{ t: TestApp; cookie: string; origin: string }> {
  const port = await freePort();
  const app = await makeApp({ env: { HZ_PORT: String(port) } });
  await app.app.listen({ host: '127.0.0.1', port });
  const { cookie } = await completeSetup(app);
  return { t: app, cookie, origin: `http://127.0.0.1:${port}` };
}

interface Sandbox {
  dir: string;
  conf: string;
  homelab: string;
  log: string;
  env: Record<string, string>;
}

const real = (tool: string): string =>
  execFileSync('sh', ['-c', `command -v ${tool}`])
    .toString()
    .trim();

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'hz-install-e2e-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (name: string, body: string): void => {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  stub('id', 'echo 0');
  stub('tailscale', 'exit 0');
  stub(
    'docker',
    [
      'printf "%s|%s\\n" "$PWD" "$*" >>"$HZ_STUB_LOG"',
      'case "$1 ${2:-}" in',
      '  "info "*) exit 0 ;;',
      '  "inspect "*) exit 1 ;;',
      '  "compose version") exit 0 ;;',
      '  "compose pull" | "compose up")',
      '    [ -f docker-compose.yml ] || exit 3',
      '    [ "${HZ_STUB_FAIL:-}" != "$2" ] || { echo "stub: $2 failed" >&2; exit 1; }',
      '    exit 0 ;;',
      'esac',
      'exit 2',
    ].join('\n'),
  );
  // chmod fails on request, to abort the script between mktemp and mv.
  stub('chmod', `[ "\${HZ_STUB_FAIL:-}" != chmod ] || exit 1\nexec ${real('chmod')} "$@"`);
  const conf = join(dir, 'etc', 'homelab-agent');
  const homelab = join(dir, 'opt', 'homelab');
  const log = join(dir, 'docker.log');
  writeFileSync(log, '');
  return {
    dir,
    conf,
    homelab,
    log,
    // Minimal environment: no proxy variables, nothing from the test runner.
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: dir,
      HZ_TEST_CONF_DIR: conf,
      HZ_TEST_HOMELAB_DIR: homelab,
      HZ_STUB_LOG: log,
    },
  };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0] ?? 'sh', cmd.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The one-liner from the UI, without sudo (the id stub says root). */
function runOneLiner(oneLiner: string, sb: Sandbox): Promise<Run> {
  const cmd = oneLiner.replace('| sudo sh -s --', '| sh -s --');
  expect(cmd).not.toContain('sudo');
  return run(['sh', '-c', cmd], sb.env);
}

function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

const leftovers = (conf: string): string[] =>
  existsSync(conf) ? readdirSync(conf).filter((f) => /^\.(onboarding|agent\.env)\./.test(f)) : [];

describe('install.sh end to end (real curl + sh against the live app)', () => {
  it('one-liner -> agent.env 0600 -> compose pull/up -> hello -> connected; the code works once', async () => {
    const live = await liveApp();
    t = live.t;
    const o = await createOnboarding(t, live.cookie, 'pi');
    expect(o.oneLiner).toBe(`curl -fsSL ${live.origin}/install.sh | sudo sh -s -- ${o.code}`);
    const sb = sandbox();
    const r = await runOneLiner(o.oneLiner, sb);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Agent "pi" läuft.');

    const envFile = join(sb.conf, 'agent.env');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(statSync(sb.conf).mode & 0o777).toBe(0o700);
    expect(existsSync(sb.homelab)).toBe(true);
    const env = readEnv(envFile);
    expect(Object.keys(env).sort()).toEqual([
      'HZ_AGENT_ALLOW_TERMINAL',
      'HZ_AGENT_NAME',
      'HZ_AGENT_TOKEN',
      'HZ_CORE_URL',
    ]);
    expect(env).toMatchObject({
      HZ_CORE_URL: `${live.origin.replace('http:', 'ws:')}/agent`,
      HZ_AGENT_NAME: 'pi',
      HZ_AGENT_ALLOW_TERMINAL: '0',
    });
    const token = env.HZ_AGENT_TOKEN ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(leftovers(sb.conf)).toEqual([]);

    // Compose: interpolation file without secrets, pull and up in CONF_DIR.
    expect(readFileSync(join(sb.conf, '.env'), 'utf8')).toBe(
      `HZ_AGENT_IMAGE=ghcr.io/puffybooy/homelab-agent:latest\nHZ_AGENT_ENV_FILE=${envFile}\nCOMPOSE_FILE=docker-compose.yml\n`,
    );
    expect(readFileSync(join(sb.conf, 'docker-compose.yml'), 'utf8')).toContain(
      'container_name: homelab-agent',
    );
    const calls = readFileSync(sb.log, 'utf8').trim().split('\n');
    expect(calls).toEqual(
      expect.arrayContaining([
        `${sb.conf}|compose pull agent`,
        `${sb.conf}|compose up -d --no-build --force-recreate agent`,
      ]),
    );
    expect(calls.indexOf(`${sb.conf}|compose pull agent`)).toBeLessThan(
      calls.indexOf(`${sb.conf}|compose up -d --no-build --force-recreate agent`),
    );

    // The token is in no output, no argument and no file but agent.env.
    for (const text of [
      r.stdout,
      r.stderr,
      readFileSync(sb.log, 'utf8'),
      readFileSync(join(sb.conf, '.env'), 'utf8'),
      readFileSync(join(sb.conf, 'docker-compose.yml'), 'utf8'),
    ]) {
      expect(text).not.toContain(token);
    }
    expect(r.stdout + r.stderr).not.toContain(o.code);

    // Second run with the same code (fresh machine): generic refusal, nothing written.
    const sb2 = sandbox();
    const r2 = await runOneLiner(o.oneLiner, sb2);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toBe(
      'Fehler: Code ungültig oder abgelaufen. Bitte in der Zentrale einen neuen Code erzeugen.\n',
    );
    expect(existsSync(join(sb2.conf, 'agent.env'))).toBe(false);
    expect(leftovers(sb2.conf)).toEqual([]);
    expect(readFileSync(sb2.log, 'utf8')).not.toContain('compose pull');

    // A fake agent with the values from agent.env comes online.
    expect(await onboardingState(t, live.cookie, o.id)).toMatchObject({ state: 'installing' });
    const agent = await WsClient.connect(env.HZ_CORE_URL ?? '');
    agents.push(agent);
    agent.send(helloMsg(token, { name: env.HZ_AGENT_NAME }));
    const enrolled = await agent.nextOfType('enrolled');
    await agent.nextOfType('welcome');
    const serverId = enrolled.serverId as string;
    await until(() => t?.app.hzCore.servers.isConnected(serverId) === true);
    expect(await onboardingState(t, live.cookie, o.id)).toMatchObject({
      state: 'connected',
      serverId,
    });
  });

  it('a multi-line argument with a valid first line is refused before anything runs', async () => {
    const live = await liveApp();
    t = live.t;
    const o = await createOnboarding(t, live.cookie, 'pi');
    const sb = sandbox();
    const file = join(sb.dir, 'install.sh');
    const script = await fetch(`${live.origin}/install.sh`).then((res) => res.text());
    writeFileSync(file, script);
    for (const bad of [`${o.code}\nABCD-EFGH`, `${o.code}\n`, `${o.code}\n$(id)`, `${o.code}x`]) {
      const r = await run(['sh', file, bad], sb.env);
      expect(r.code, JSON.stringify(bad)).toBe(1);
      expect(r.stderr, JSON.stringify(bad)).toContain('ungültiges Format');
    }
    // Nothing was checked, created or sent: the code still works.
    expect(readFileSync(sb.log, 'utf8')).toBe('');
    expect(existsSync(sb.conf)).toBe(false);
    expect(await onboardingState(t, live.cookie, o.id)).toMatchObject({ state: 'waiting' });
  });

  it('an abort between mktemp and mv leaves no temp file with the token', async () => {
    const live = await liveApp();
    t = live.t;
    const o = await createOnboarding(t, live.cookie, 'pi');
    const sb = sandbox();
    const r = await runOneLiner(o.oneLiner, { ...sb, env: { ...sb.env, HZ_STUB_FAIL: 'chmod' } });
    expect(r.code).not.toBe(0);
    expect(readdirSync(sb.conf)).toEqual([]);
    expect(readFileSync(sb.log, 'utf8')).not.toContain('compose pull');
  });

  for (const step of ['pull', 'up'] as const) {
    it(`docker compose ${step} failing: German hint to delete agent.env and use a new code`, async () => {
      const live = await liveApp();
      t = live.t;
      const o = await createOnboarding(t, live.cookie, 'pi');
      const sb = sandbox();
      const r = await runOneLiner(o.oneLiner, { ...sb, env: { ...sb.env, HZ_STUB_FAIL: step } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        `Fehler: Der Agent konnte nicht geladen oder gestartet werden (siehe oben). Bitte ${sb.conf}/agent.env löschen und mit einem neuen Code aus der Zentrale erneut versuchen.`,
      );
      expect(r.stdout).not.toContain('läuft');
      const token = readEnv(join(sb.conf, 'agent.env')).HZ_AGENT_TOKEN ?? 'missing';
      expect(r.stdout + r.stderr).not.toContain(token);
      expect(leftovers(sb.conf)).toEqual([]);
      const calls = readFileSync(sb.log, 'utf8');
      if (step === 'pull') expect(calls).not.toContain('compose up');
      else expect(calls).toContain('compose up');
    });
  }
});

describe('install.sh paths', () => {
  const hub = { origin: 'https://hz.test', coreUrl: 'wss://hz.test/agent' };

  it('production rendering hardcodes the paths; only test rendering reads HZ_TEST_*', () => {
    const prod = renderInstallScript(hub);
    expect(prod).toMatch(/^CONF_DIR=\/etc\/homelab-agent$/m);
    expect(prod).toMatch(/^HOMELAB_DIR=\/opt\/homelab$/m);
    expect(prod).not.toContain('${HZ_TEST_');
    const test = renderInstallScript(hub, { testPaths: true });
    expect(test).toMatch(/^CONF_DIR=\$\{HZ_TEST_CONF_DIR:-\/etc\/homelab-agent\}$/m);
    expect(test).toMatch(/^HOMELAB_DIR=\$\{HZ_TEST_HOMELAB_DIR:-\/opt\/homelab\}$/m);
  });

  it('a production core serves install.sh without the test overrides', async () => {
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const { openDatabase } = await import('../src/db/index.js');
    const { emptyDir, KEY } = await import('./helpers.js');
    const { Writable } = await import('node:stream');
    const app = await buildApp(
      loadConfig({
        HZ_SECRET_KEY: KEY,
        NODE_ENV: 'production',
        HZ_WEB_DIR: emptyDir(),
        HZ_BASE_URL: 'https://hz.test',
      }),
      {
        db: openDatabase(':memory:'),
        startScheduler: false,
        logStream: new Writable({ write: (_c, _e, cb) => cb() }),
      },
    );
    try {
      const res = await app.inject({ method: 'GET', url: '/install.sh' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/^CONF_DIR=\/etc\/homelab-agent$/m);
      expect(res.body).not.toContain('${HZ_TEST_');
    } finally {
      await app.close();
    }
  });
});

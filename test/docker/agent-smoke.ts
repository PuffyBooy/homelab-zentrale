/**
 * Docker smoke test for M2 (docs/ROADMAP.md): core image + agent image.
 *
 *   docker build -f deploy/Dockerfile.core -t homelab-zentrale/core:local .
 *   docker build -f apps/agent/Dockerfile -t homelab-zentrale/agent:local .
 *   pnpm exec tsx test/docker/agent-smoke.ts
 *
 * 1. starts the core (NODE_ENV=test, fixed HZ_SETUP_TOKEN) on 127.0.0.1:18080,
 * 2. runs the setup through the API (password + TOTP), keeps the session cookie,
 * 3. POST /api/servers/enroll {name: "ci-agent"},
 * 4. starts the agent with deploy/docker-compose.agent.yml and the enrollment token,
 * 5. waits until GET /api/servers shows ci-agent as connected (with metrics),
 * 6. stops the agent, waits until the server is crit (<= 100 s) and
 *    GET /api/alerts shows an open crit alert for it.
 * Cleans up containers and volumes in every case.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Secret, TOTP } from 'otpauth';
import { alertListResponseSchema } from '../../packages/shared/src/api/alerts.js';
import { setupStartResponseSchema } from '../../packages/shared/src/api/auth.js';
import {
  enrollResponseSchema,
  serverListResponseSchema,
  type ServerSummary,
} from '../../packages/shared/src/api/servers.js';

const CORE_IMAGE = process.env.HZ_SMOKE_CORE_IMAGE ?? 'homelab-zentrale/core:local';
const AGENT_IMAGE = process.env.HZ_SMOKE_AGENT_IMAGE ?? 'homelab-zentrale/agent:local';
const PORT = Number(process.env.HZ_SMOKE_PORT ?? 18080);
const BASE = `http://127.0.0.1:${PORT}`;
const CORE_NAME = 'hz-smoke-core';
const AGENT_PROJECT = 'hz-smoke-agent';
const AGENT_NAME = 'ci-agent';
const CRIT_WITHIN_S = 100;

const setupToken = randomBytes(24).toString('base64url');
const secretKey = randomBytes(32).toString('base64');
const password = randomBytes(18).toString('base64url');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hz-smoke-'));
const envFile = path.join(tmp, 'agent.env');
const repo = path.resolve(import.meta.dirname, '..', '..');
const composeFile = path.join(repo, 'deploy', 'docker-compose.agent.yml');

let cookie = '';

function log(msg: string): void {
  process.stdout.write(`[smoke ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

/** docker CLI, argument array, no shell. */
function docker(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  // Only the docker CLI, argument array, no shell.
  // nosemgrep
  return execFileSync('docker', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

const composeEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HZ_AGENT_IMAGE: AGENT_IMAGE,
  HZ_AGENT_ENV_FILE: envFile,
});
const compose = (args: string[]) =>
  docker(['compose', '-p', AGENT_PROJECT, '-f', composeFile, ...args], composeEnv());

async function api(method: string, p: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { origin: BASE };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${BASE}${p}`, init);
}

async function json(res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as unknown;
}

async function waitFor<T>(what: string, timeoutS: number, fn: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + timeoutS * 1000;
  let lastErr = '';
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== null) return v;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout (${timeoutS} s) waiting for ${what}${lastErr ? `: ${lastErr}` : ''}`);
}

async function findServer(): Promise<ServerSummary | null> {
  const list = serverListResponseSchema.parse(
    await json(await api('GET', '/api/servers'), 'servers'),
  );
  return list.servers.find((s) => s.name === AGENT_NAME) ?? null;
}

function cleanup(): void {
  try {
    compose(['down', '-v', '--timeout', '5']);
  } catch {
    // not started
  }
  try {
    docker(['rm', '-f', '-v', CORE_NAME]);
  } catch {
    // not started
  }
  rmSync(tmp, { recursive: true, force: true });
}

function dumpLogs(): void {
  for (const args of [
    ['logs', '--tail', '80', CORE_NAME],
    ['compose', '-p', AGENT_PROJECT, '-f', composeFile, 'logs', '--tail', '80'],
  ]) {
    try {
      process.stdout.write(`--- docker ${args.join(' ')}\n`);
      process.stdout.write(docker(args, composeEnv()));
    } catch (err) {
      process.stdout.write(`(no logs: ${err instanceof Error ? err.message : 'error'})\n`);
    }
  }
}

async function main(): Promise<void> {
  log(`core ${CORE_IMAGE}, agent ${AGENT_IMAGE}`);
  docker([
    'run',
    '-d',
    '--name',
    CORE_NAME,
    '--network',
    'host',
    '-e',
    'NODE_ENV=test',
    '-e',
    `HZ_SETUP_TOKEN=${setupToken}`,
    '-e',
    `HZ_SECRET_KEY=${secretKey}`,
    '-e',
    'HZ_HOST=127.0.0.1',
    '-e',
    `HZ_PORT=${PORT}`,
    CORE_IMAGE,
  ]);

  await waitFor('core /api/health', 60, async () => {
    const r = await fetch(`${BASE}/api/health`);
    return r.ok ? true : null;
  });
  log('core is healthy');

  // Setup: account + TOTP.
  const start = setupStartResponseSchema.parse(
    await json(
      await api('POST', '/api/setup/start', { setupToken, username: 'alex', password }),
      'setup/start',
    ),
  );
  const totp = new TOTP({ secret: Secret.fromBase32(start.secret), digits: 6, period: 30 });
  const confirm = await api('POST', '/api/setup/confirm', { setupToken, code: totp.generate() });
  await json(confirm, 'setup/confirm');
  const session = confirm.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .find((c) => c.startsWith('hz_session='));
  if (!session) throw new Error('setup/confirm did not set the session cookie');
  cookie = session;
  log('setup done, logged in');

  const enroll = enrollResponseSchema.parse(
    await json(await api('POST', '/api/servers/enroll', { name: AGENT_NAME }), 'servers/enroll'),
  );
  log('enrollment token created');

  writeFileSync(
    envFile,
    [
      `HZ_CORE_URL=ws://127.0.0.1:${PORT}/agent`,
      `HZ_AGENT_NAME=${AGENT_NAME}`,
      `HZ_AGENT_TOKEN=${enroll.token}`,
      'HZ_AGENT_ALLOW_TERMINAL=0',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  compose(['up', '-d', '--no-build']);
  log('agent started');

  const connected = await waitFor('ci-agent connected with metrics', 90, async () => {
    const s = await findServer();
    return s && s.connected && s.cpu !== null ? s : null;
  });
  log(
    `ci-agent connected: status=${connected.status}, cpu=${connected.cpu}, ram=${connected.ramPct}`,
  );

  const agentLogs = compose(['logs', '--no-color']);
  if (agentLogs.includes(enroll.token)) throw new Error('agent log contains the token');

  compose(['stop', '--timeout', '5']);
  const stoppedAt = Date.now();
  log('agent stopped, waiting for crit');

  const crit = await waitFor('status crit', CRIT_WITHIN_S + 5, async () => {
    const s = await findServer();
    return s && s.status === 'crit' ? s : null;
  });
  const after = Math.round((Date.now() - stoppedAt) / 1000);
  if (after > CRIT_WITHIN_S) throw new Error(`crit after ${after} s (> ${CRIT_WITHIN_S} s)`);
  log(`crit after ${after} s, connected=${crit.connected}`);

  const alert = await waitFor('open crit alert', 30, async () => {
    const alerts = alertListResponseSchema.parse(
      await json(
        await api('GET', `/api/alerts?state=open&serverId=${encodeURIComponent(crit.id)}`),
        'alerts',
      ),
    );
    return (
      alerts.alerts.find(
        (a) => a.serverId === crit.id && a.level === 'crit' && a.state === 'open',
      ) ?? null
    );
  });
  log(`alert: "${alert.title}"`);
  log('OK');
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err: unknown) => {
    process.stdout.write(`[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    dumpLogs();
    cleanup();
    process.exit(1);
  });

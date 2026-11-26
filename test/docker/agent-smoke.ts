/**
 * Docker smoke test for M2 + M3 (docs/ROADMAP.md): core image + agent image.
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
 * 6. M3 containers:
 *    a. starts a busybox container `hz-smoke` (stdout + stderr every second) and waits
 *       until GET /api/containers lists it as running,
 *    b. subscribes to the live topic container-logs:<id> and receives stdout and stderr lines,
 *    c. POST /api/containers/:id/stop -> the `containers` topic shows it exited/off live,
 *       and GET /api/alerts has an open container alert for it,
 *    d. image update: a container from busybox:hz-smoke (= busybox:1.36), then
 *       busybox:1.37 is tagged as busybox:hz-smoke, POST /api/containers/:id/update,
 *       and the container runs with the image id of busybox:1.37,
 * 7. stops the agent, waits until the server is crit (<= 100 s) and
 *    GET /api/alerts shows an open crit alert for it.
 * Cleans up containers and volumes in every case.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Secret, TOTP } from 'otpauth';
import WebSocket from 'ws';
import { alertListResponseSchema } from '../../packages/shared/src/api/alerts.js';
import { setupStartResponseSchema } from '../../packages/shared/src/api/auth.js';
import {
  containerListResponseSchema,
  logLineSchema,
  logSnapshotSchema,
  type ContainerSummary,
  type LogLine,
} from '../../packages/shared/src/api/containers.js';
import {
  enrollResponseSchema,
  serverListResponseSchema,
  type ServerSummary,
} from '../../packages/shared/src/api/servers.js';
import { liveServerMessageSchema, type LiveServerMessage } from '../../packages/shared/src/live.js';

const CORE_IMAGE = process.env.HZ_SMOKE_CORE_IMAGE ?? 'homelab-zentrale/core:local';
const AGENT_IMAGE = process.env.HZ_SMOKE_AGENT_IMAGE ?? 'homelab-zentrale/agent:local';
const PORT = Number(process.env.HZ_SMOKE_PORT ?? 18080);
const BASE = `http://127.0.0.1:${PORT}`;
const CORE_NAME = 'hz-smoke-core';
const AGENT_PROJECT = 'hz-smoke-agent';
const AGENT_NAME = 'ci-agent';
const CRIT_WITHIN_S = 100;
const SMOKE_CONTAINER = 'hz-smoke';
const UPDATE_CONTAINER = 'hz-smoke-upd';
const OLD_IMAGE = 'busybox:1.36';
const NEW_IMAGE = 'busybox:1.37';
const SMOKE_TAG = 'busybox:hz-smoke';
/** Prints one stdout and one stderr line per second. */
const CHATTY = [
  'sh',
  '-c',
  'trap "exit 0" TERM; i=0; while true; do echo "hz-smoke out $i"; echo "hz-smoke err $i" >&2; i=$((i+1)); sleep 1; done',
];

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

/** Live client on /live with the session cookie (same Origin as the API). */
function liveClient(topics: string[]) {
  const messages: LiveServerMessage[] = [];
  const waiters = new Set<() => void>();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live`, { headers: { cookie, origin: BASE } });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', topics }));
      resolve();
    });
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) =>
      reject(new Error(`live: HTTP ${res.statusCode}`)),
    );
  });
  ws.on('message', (raw: WebSocket.RawData) => {
    const parsed = liveServerMessageSchema.safeParse(JSON.parse(raw.toString()));
    if (!parsed.success) return;
    messages.push(parsed.data);
    for (const w of waiters) w();
  });
  return {
    opened,
    messages,
    /** Resolves with the first value `pick` returns for any message (old or new). */
    async waitFor<T>(
      what: string,
      timeoutS: number,
      pick: (m: LiveServerMessage) => T | null,
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let wake: () => void = () => undefined;
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(new Error(`timeout (${timeoutS} s) waiting for live ${what}`));
        }, timeoutS * 1000);
        let seen = 0;
        wake = () => {
          for (; seen < messages.length; seen += 1) {
            const v = pick(messages[seen] as LiveServerMessage);
            if (v !== null) {
              clearTimeout(timer);
              waiters.delete(wake);
              resolve(v);
              return;
            }
          }
        };
        waiters.add(wake);
        wake();
      });
    },
    close: () => ws.close(),
  };
}

async function listContainers(serverId: string): Promise<ContainerSummary[]> {
  return containerListResponseSchema.parse(
    await json(
      await api('GET', `/api/containers?serverId=${encodeURIComponent(serverId)}`),
      'containers',
    ),
  ).containers;
}

async function waitContainer(
  serverId: string,
  name: string,
  what: string,
  timeoutS: number,
  ok: (c: ContainerSummary) => boolean,
): Promise<ContainerSummary> {
  return waitFor(what, timeoutS, async () => {
    const c = (await listContainers(serverId)).find((x) => x.name === name);
    return c && ok(c) ? c : null;
  });
}

function imageId(ref: string): string {
  return docker(['image', 'inspect', '--format', '{{.Id}}', ref]).trim();
}

function ensureImage(ref: string): void {
  try {
    imageId(ref);
  } catch {
    log(`pulling ${ref}`);
    docker(['pull', '-q', ref]);
  }
}

async function containerChecks(serverId: string): Promise<void> {
  removeSmokeContainers();
  ensureImage(OLD_IMAGE);
  ensureImage(NEW_IMAGE);

  // a. a real container shows up as running
  docker(['run', '-d', '--name', SMOKE_CONTAINER, OLD_IMAGE, ...CHATTY]);
  const running = await waitContainer(
    serverId,
    SMOKE_CONTAINER,
    'hz-smoke running',
    90,
    (c) => c.state === 'running',
  );
  log(`hz-smoke listed: state=${running.state}, status=${running.status}, id=${running.id}`);

  // b. logs over the live topic, both channels
  const logs = liveClient([`container-logs:${running.id}`]);
  await logs.opened;
  const lines: LogLine[] = [];
  const collect = (m: LiveServerMessage): LogLine[] => {
    if (m.type === 'snapshot') return logSnapshotSchema.parse(m.data).lines;
    if (m.type === 'update') return (m.upsert ?? []).map((u) => logLineSchema.parse(u));
    return [];
  };
  await logs.waitFor('stdout and stderr log lines', 45, (m) => {
    if (m.type === 'error') throw new Error(`live error ${m.code}`);
    lines.push(...collect(m));
    const out = lines.some((l) => l.stream === 'stdout' && l.text.startsWith('hz-smoke out'));
    const err = lines.some((l) => l.stream === 'stderr' && l.text.startsWith('hz-smoke err'));
    return out && err ? true : null;
  });
  logs.close();
  log(`logs streamed: ${lines.length} lines (stdout + stderr)`);

  // c. stop through the API: live OFF/DOWN + alert
  const live = liveClient(['containers']);
  await live.opened;
  await json(await api('POST', `/api/containers/${running.id}/stop`), 'containers/stop');
  const stopped = await live.waitFor('hz-smoke exited', 60, (m) => {
    if (m.type !== 'update' && m.type !== 'snapshot') return null;
    const items = (m.type === 'update' ? m.upsert : (m.data as unknown[])) ?? [];
    const c = (items as ContainerSummary[]).find((x) => x.id === running.id);
    return c && c.state === 'exited' && (c.status === 'off' || c.status === 'crit') ? c : null;
  });
  live.close();
  log(`hz-smoke stopped live: state=${stopped.state}, status=${stopped.status}`);
  const alert = await waitFor('container alert', 30, async () => {
    const alerts = alertListResponseSchema.parse(
      await json(
        await api('GET', `/api/alerts?state=open&serverId=${encodeURIComponent(serverId)}`),
        'alerts',
      ),
    );
    return (
      alerts.alerts.find((a) => a.source === 'container' && a.title.includes(SMOKE_CONTAINER)) ??
      null
    );
  });
  log(`container alert: ${alert.level} "${alert.title}"`);
  docker(['rm', '-f', SMOKE_CONTAINER]);

  // d. image update: same tag, new image
  docker(['tag', OLD_IMAGE, SMOKE_TAG]);
  docker([
    'run',
    '-d',
    '--name',
    UPDATE_CONTAINER,
    '--restart',
    'unless-stopped',
    SMOKE_TAG,
    ...CHATTY,
  ]);
  const before = docker(['inspect', '--format', '{{.Image}}', UPDATE_CONTAINER]).trim();
  if (before !== imageId(OLD_IMAGE)) throw new Error('update container does not run busybox:1.36');
  const upd = await waitContainer(
    serverId,
    UPDATE_CONTAINER,
    'hz-smoke-upd running',
    90,
    (c) => c.state === 'running',
  );
  docker(['tag', NEW_IMAGE, SMOKE_TAG]);
  const newId = imageId(NEW_IMAGE);
  await json(await api('POST', `/api/containers/${upd.id}/update`), 'containers/update');
  const after = docker([
    'inspect',
    '--format',
    '{{.Image}} {{.State.Running}} {{.HostConfig.RestartPolicy.Name}}',
    UPDATE_CONTAINER,
  ])
    .trim()
    .split(' ');
  if (after[0] !== newId)
    throw new Error(`after update the image is ${after[0]}, expected ${newId}`);
  if (after[1] !== 'true') throw new Error('updated container is not running');
  if (after[2] !== 'unless-stopped') throw new Error('restart policy was not kept');
  const leftovers = docker([
    'ps',
    '-a',
    '--filter',
    `name=${UPDATE_CONTAINER}-hz-old`,
    '--format',
    '{{.Names}}',
  ]).trim();
  if (leftovers) throw new Error(`old container left over: ${leftovers}`);
  const listed = await waitContainer(
    serverId,
    UPDATE_CONTAINER,
    'updated container listed',
    60,
    (c) => c.state === 'running' && c.dockerId !== upd.dockerId,
  );
  log(`image updated: ${before.slice(7, 19)} -> ${newId.slice(7, 19)}, listed as ${listed.status}`);
  const ghost = alertListResponseSchema
    .parse(
      await json(
        await api('GET', `/api/alerts?serverId=${encodeURIComponent(serverId)}`),
        'alerts',
      ),
    )
    .alerts.find((a) => a.title.includes('-hz-old-'));
  if (ghost) throw new Error(`the update raised an alert for the old container: "${ghost.title}"`);
  removeSmokeContainers();
}

async function findServer(): Promise<ServerSummary | null> {
  const list = serverListResponseSchema.parse(
    await json(await api('GET', '/api/servers'), 'servers'),
  );
  return list.servers.find((s) => s.name === AGENT_NAME) ?? null;
}

function removeSmokeContainers(): void {
  let names: string[] = [];
  try {
    names = docker(['ps', '-a', '--filter', 'name=hz-smoke', '--format', '{{.Names}}'])
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n === SMOKE_CONTAINER || n.startsWith(`${UPDATE_CONTAINER}`));
  } catch {
    // docker not reachable
  }
  for (const n of names) {
    try {
      docker(['rm', '-f', n]);
    } catch {
      // gone
    }
  }
}

function cleanup(): void {
  removeSmokeContainers();
  try {
    docker(['rmi', SMOKE_TAG]);
  } catch {
    // not tagged
  }
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

  await containerChecks(connected.id);

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
        (a) =>
          a.serverId === crit.id &&
          a.source === 'server' &&
          a.level === 'crit' &&
          a.state === 'open',
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

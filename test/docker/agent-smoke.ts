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
 * 7. M6 game server (real Paper, skipped with HZ_SMOKE_SKIP_GAME=1):
 *    a. POST /api/games minecraft-java/PAPER (MEMORY 4G, the smallest option) on ci-agent,
 *       live progress from topic game:<id>, waits for status ok (<= 9 min),
 *    b. version, players {online: 0}, tps not null; the game port accepts TCP,
 *    c. `docker compose config` of the rendered folder (inside the agent container, the
 *       .env is root 0600): compose.yml + .env interpolate, no unset variable,
 *    d. step-up (fresh TOTP), RCON `list` and `tps` through the API,
 *    e. backup -> a backup entry with sizeBytes > 0, the file exists, no .partial left,
 *    e2. M12 sleep mode: PUT autoStopMinutes 1 + wakeOnConnect -> the core stops the empty
 *       server and arms the agent's wake listener (game.wake.arm), the summary says
 *       sleeping; a Minecraft status ping on the game port answers "Schläft" and does NOT
 *       wake it; a login handshake gets the "Server startet" disconnect, the agent sends
 *       game_wake and the core starts the game again (status ok),
 *    f. stop -> off, DELETE with a wrong confirmName is refused, DELETE with the right one
 *       removes container and folder.
 * 8. M17 auto-update (skipped with HZ_SMOKE_SKIP_UPDATE=1). Core and agent run from a local
 *    registry:2 (127.0.0.1:5000), so the agent can pull "their" tag:
 *    a. core: a derived image (`FROM <core>` + another org.opencontainers.image.version) is
 *       pushed under the core's tag, POST /api/servers/:id/update {target: core} -> the run
 *       ends `updated`, the core container was replaced (new id, new image), /api/health
 *       answers, the agent reconnects,
 *    b. agent: same with a derived agent image -> `updated`, homelab-agent runs the new image,
 *    c. broken agent: a derived image whose HEALTHCHECK always fails -> `rolled_back`,
 *       homelab-agent runs the previous image again, an open warn alert update:<id>:agent,
 *    d. the exited updater helper is removed by the agent afterwards.
 * 9. stops the agent, waits until the server is crit (<= 100 s) and
 *    GET /api/alerts shows an open crit alert for it.
 * Cleans up containers and volumes in every case. On failure it prints core, agent and
 * game container logs.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Secret, TOTP } from 'otpauth';
import WebSocket from 'ws';
import { alertListResponseSchema } from '../../packages/shared/src/api/alerts.js';
import {
  setupStartResponseSchema,
  stepUpResponseSchema,
} from '../../packages/shared/src/api/auth.js';
import {
  containerListResponseSchema,
  logLineSchema,
  logSnapshotSchema,
  type ContainerSummary,
  type LogLine,
} from '../../packages/shared/src/api/containers.js';
import {
  gameBackupListResponseSchema,
  gameEventSchema,
  gameRconResponseSchema,
  gameResponseSchema,
  gameSuggestResponseSchema,
  gameTemplateListResponseSchema,
  type GameSummary,
} from '../../packages/shared/src/api/games.js';
import {
  enrollResponseSchema,
  serverListResponseSchema,
  type ServerSummary,
} from '../../packages/shared/src/api/servers.js';
import { liveServerMessageSchema, type LiveServerMessage } from '../../packages/shared/src/live.js';
import {
  updateNowResponseSchema,
  updatesResponseSchema,
  type UpdateRun,
} from '../../packages/shared/src/api/updates.js';

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
const AGENT_CONTAINER = 'homelab-agent';
const SKIP_GAME = process.env.HZ_SMOKE_SKIP_GAME === '1';
const SKIP_UPDATE = process.env.HZ_SMOKE_SKIP_UPDATE === '1';
/** M17: local registry, so the agent can pull the tags core and agent run with. */
const REGISTRY_NAME = 'hz-smoke-registry';
const REGISTRY = `127.0.0.1:${Number(process.env.HZ_SMOKE_REGISTRY_PORT ?? 5000)}`;
const REG_CORE = `${REGISTRY}/homelab-core:smoke`;
const REG_AGENT = `${REGISTRY}/homelab-agent:smoke`;
const CORE_VOLUME = 'hz-smoke-core-data';
const DERIVED = ['hz-smoke/core:v2', 'hz-smoke/agent:v2', 'hz-smoke/agent:broken'] as const;
/** Image refs core and agent run with (the registry tags unless HZ_SMOKE_SKIP_UPDATE=1). */
let coreRef = CORE_IMAGE;
let agentRef = AGENT_IMAGE;
let registryStarted = false;
const GAME = 'ci-paper';
const GAME_CONTAINER = `game-${GAME}`;
const GAME_DIR = `/opt/homelab/games/${GAME}`;
const GAME_BACKUP_DIR = `/opt/homelab/backups/${GAME}`;
/** Core SETUP_TIMEOUT_MS is 10 min; Paper download + world generation on a CI runner. */
const GAME_READY_S = 9 * 60;
/** Re-do the step-up before it runs out (STEP_UP_MINUTES = 15). */
const STEP_UP_REUSE_MS = 12 * 60_000;
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
let totp: TOTP | null = null;
/** Last TOTP time step the core accepted (codes are never accepted twice). */
let lastTotpStep = -1;
let stepUpAt = 0;
let lastGame: GameSummary | null = null;
let gameCreated = false;

function log(msg: string): void {
  process.stdout.write(`[smoke ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

/** docker CLI, argument array, no shell. */
function docker(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  // Only the docker CLI, argument array, no shell.
  // nosemgrep
  return execFileSync('docker', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** docker CLI with exit code, stdout and stderr (no throw), argument array, no shell. */
function dockerFull(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { code: number; stdout: string; stderr: string } {
  // nosemgrep
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const composeEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HZ_AGENT_IMAGE: agentRef,
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

/** Thrown inside a waitFor callback: stops waiting at once (no retry). */
class Fatal extends Error {}

async function waitFor<T>(
  what: string,
  timeoutS: number,
  fn: () => Promise<T | null>,
  intervalMs = 1000,
): Promise<T> {
  const end = Date.now() + timeoutS * 1000;
  let lastErr = '';
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== null) return v;
    } catch (err) {
      if (err instanceof Fatal) throw err;
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout (${timeoutS} s) waiting for ${what}${lastErr ? `: ${lastErr}` : ''}`);
}

/** Live client on /live with the session cookie (same Origin as the API). */
function liveClient(topics: string[], onMessage?: (m: LiveServerMessage) => void) {
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
    onMessage?.(parsed.data);
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

// ---- M6: game server ---------------------------------------------------------------

/** Fresh TOTP step-up (needed for RCON and delete). Waits for a TOTP step not used yet. */
async function stepUp(): Promise<void> {
  const t = totp;
  if (!t) throw new Error('no TOTP secret');
  if (t.counter() <= lastTotpStep) {
    log('step-up: waiting for the next TOTP step');
    await waitFor('next TOTP step', 35, async () => (t.counter() > lastTotpStep ? true : null));
  }
  const step = t.counter();
  const res = stepUpResponseSchema.parse(
    await json(await api('POST', '/api/auth/step-up', { code: t.generate() }), 'auth/step-up'),
  );
  lastTotpStep = step;
  stepUpAt = Date.now();
  log(`step-up until ${res.stepUpUntil}`);
}

async function ensureStepUp(): Promise<void> {
  if (Date.now() - stepUpAt > STEP_UP_REUSE_MS) await stepUp();
}

async function getGame(id: string): Promise<GameSummary> {
  const g = gameResponseSchema.parse(
    await json(await api('GET', `/api/games/${id}`), 'games/:id'),
  ).game;
  lastGame = g;
  return g;
}

/** Waits until the game summary satisfies `ok`; logs status changes, stops at crit. */
async function waitGame(
  id: string,
  what: string,
  timeoutS: number,
  ok: (g: GameSummary) => boolean,
  failOnCrit = true,
): Promise<GameSummary> {
  let seen = '';
  return waitFor(
    what,
    timeoutS,
    async () => {
      const g = await getGame(id);
      const now = `${g.status} "${g.statusText}"`;
      if (now !== seen) {
        seen = now;
        log(`game ${g.name}: ${now}`);
      }
      if (ok(g)) return g;
      if (failOnCrit && g.status === 'crit') {
        throw new Fatal(`game ${g.name} is crit while waiting for ${what}: ${g.statusText}`);
      }
      return null;
    },
    3000,
  );
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(5000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// Minimal Minecraft Java client (server list ping and login handshake), strictly bounded.

function mcVarInt(n: number): Buffer {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

function mcFrame(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([mcVarInt(id), payload]);
  return Buffer.concat([mcVarInt(body.length), body]);
}

function mcHandshake(port: number, nextState: 1 | 2): Buffer {
  const host = Buffer.from('127.0.0.1');
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  return mcFrame(
    0,
    Buffer.concat([mcVarInt(767), mcVarInt(host.length), host, p, mcVarInt(nextState)]),
  );
}

/** Sends `data`, returns what the server sent until it closed (max 64 KiB, 10 s). */
function mcExchange(port: number, data: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    let size = 0;
    const t = setTimeout(() => s.destroy(), 10_000);
    s.once('connect', () => s.write(data));
    s.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) s.destroy();
      else chunks.push(c);
    });
    s.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    s.once('close', () => {
      clearTimeout(t);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/** Status request (+ ping, so the listener closes the connection after the pong). */
function mcStatus(port: number): Promise<string> {
  const ping = Buffer.alloc(8);
  ping.writeBigInt64BE(42n);
  return mcExchange(
    port,
    Buffer.concat([mcHandshake(port, 1), mcFrame(0, Buffer.alloc(0)), mcFrame(1, ping)]),
  );
}

function mcLogin(port: number): Promise<string> {
  const name = Buffer.from('hzsmoke');
  return mcExchange(
    port,
    Buffer.concat([mcHandshake(port, 2), mcFrame(0, Buffer.concat([mcVarInt(name.length), name]))]),
  );
}

/** M12: sleep after 1 min without players, "Schläft" in the server list, a login wakes. */
async function sleepWakeChecks(gameId: string, gamePort: number): Promise<void> {
  await json(
    await api('PUT', `/api/games/${gameId}`, { autoStopMinutes: 1, wakeOnConnect: true }),
    'PUT games/:id (sleep mode)',
  );
  const asleep = await waitGame(gameId, 'game asleep', 300, (g) => g.sleeping, false);
  log(`game asleep: ${asleep.status} "${asleep.statusText}"`);
  const state = docker([
    'ps',
    '-a',
    '--filter',
    `name=^${GAME_CONTAINER}$`,
    '--format',
    '{{.State}}',
  ]).trim();
  if (state === 'running') throw new Error('game container still running while asleep');

  const status = await waitFor(
    'sleeping server list answer',
    30,
    async () => {
      const text = await mcStatus(gamePort).catch(() => '');
      return text.includes('Schläft') ? text : null;
    },
    1000,
  );
  if (!status.includes('"online":0')) throw new Error(`unexpected status: ${status.slice(0, 300)}`);
  log('server list ping while asleep: "Schläft"');
  // A server list ping must not wake the game.
  await new Promise((r) => setTimeout(r, 5000));
  const still = await getGame(gameId);
  if (!still.sleeping) throw new Error('a server list ping woke the game');
  if (docker(['ps', '--filter', `name=^${GAME_CONTAINER}$`, '--format', '{{.State}}']).trim()) {
    throw new Error('game container started after a server list ping');
  }

  const disconnect = await mcLogin(gamePort);
  if (!disconnect.includes('Server startet')) {
    throw new Error(`login got no wake message: ${disconnect.slice(0, 300)}`);
  }
  log('login while asleep: "Server startet, bitte in 1 Minute neu verbinden."');
  const awake = await waitGame(
    gameId,
    'game awake (game_wake -> start)',
    GAME_READY_S,
    (g) => !g.sleeping && g.status === 'ok',
  );
  log(`game woke up: ${awake.status} "${awake.statusText}"`);
  // Back to "never sleep", so the stop below is a plain stop.
  await json(
    await api('PUT', `/api/games/${gameId}`, { autoStopMinutes: 0 }),
    'PUT games/:id (sleep off)',
  );
}

/** docker CLI inside the agent container (root there; the game files are root 0600/0640). */
function inAgent(args: string[]): { code: number; stdout: string; stderr: string } {
  return dockerFull(['exec', '-e', 'DOCKER_CONFIG=/tmp/.docker', AGENT_CONTAINER, ...args]);
}

/**
 * `docker compose config` of the rendered folder: compose.yml and .env must interpolate
 * without an unset variable. The output contains the RCON password: it is parsed and
 * checked here, never printed.
 */
function composeConfigCheck(image: string, gamePort: number): void {
  const r = inAgent([
    'docker',
    'compose',
    '--ansi',
    'never',
    '--project-directory',
    GAME_DIR,
    '-f',
    `${GAME_DIR}/compose.yml`,
    'config',
    '--format',
    'json',
  ]);
  if (r.code !== 0)
    throw new Error(`compose config failed (exit ${r.code}): ${r.stderr.slice(0, 500)}`);
  if (/variable is not set|defaulting to a blank string/i.test(r.stderr)) {
    throw new Error(`compose config warns about unset variables: ${r.stderr.slice(0, 500)}`);
  }
  if (r.stdout.includes('${')) throw new Error('compose config left a ${...} placeholder');
  const cfg = JSON.parse(r.stdout) as {
    services?: Record<
      string,
      {
        image?: string;
        container_name?: string;
        mem_limit?: string | number;
        environment?: Record<string, string | null>;
        ports?: { target?: number; published?: string | number; host_ip?: string }[];
      }
    >;
  };
  const svc = cfg.services?.server;
  if (!svc) throw new Error('compose config: no service "server"');
  const env = svc.environment ?? {};
  const problems: string[] = [];
  if (svc.image !== image) problems.push(`image ${svc.image}`);
  if (svc.container_name !== GAME_CONTAINER) problems.push(`container_name ${svc.container_name}`);
  if (String(svc.mem_limit) !== String(4 * 1024 ** 3) && svc.mem_limit !== '4G') {
    problems.push(`mem_limit ${String(svc.mem_limit)}`);
  }
  if (env.TYPE !== 'PAPER') problems.push(`TYPE ${env.TYPE}`);
  if (env.EULA !== 'TRUE') problems.push('EULA');
  // From env_file .env (never in compose.yml): only the length is checked.
  if ((env.RCON_PASSWORD ?? '').length < 16) problems.push('RCON_PASSWORD missing or short');
  const ports = svc.ports ?? [];
  const game = ports.find((p) => p.target === 25565);
  const rcon = ports.find((p) => p.target === 25575);
  if (!game || Number(game.published) !== gamePort) problems.push('game port');
  if (!rcon || rcon.host_ip !== '127.0.0.1' || !(Number(rcon.published) > 0)) {
    problems.push('rcon port not on 127.0.0.1');
  }
  if (problems.length > 0) throw new Error(`compose config: ${problems.join(', ')}`);
  const mode = inAgent(['stat', '-c', '%a', `${GAME_DIR}/.env`]);
  if (mode.stdout.trim() !== '600') throw new Error(`.env mode is ${mode.stdout.trim()}, not 600`);
  log(
    `compose config ok: image, container_name, mem_limit, env (RCON_PASSWORD from .env), ` +
      `ports ${gamePort} + 127.0.0.1:${String(rcon?.published)}, .env 0600`,
  );
}

async function gameChecks(serverId: string): Promise<void> {
  const templates = gameTemplateListResponseSchema.parse(
    await json(await api('GET', '/api/games/templates'), 'games/templates'),
  ).templates;
  const tpl = templates.find((t) => t.id === 'minecraft-java');
  if (!tpl)
    throw new Error(`minecraft-java template missing (${templates.map((t) => t.id).join(', ')})`);
  const suggest = gameSuggestResponseSchema.parse(
    await json(
      await api(
        'GET',
        `/api/games/suggest?templateId=minecraft-java&serverId=${encodeURIComponent(serverId)}`,
      ),
      'games/suggest',
    ),
  );
  log(
    `suggested ports ${JSON.stringify(suggest.ports)}, ram warning: ${suggest.ramWarning ?? '-'}`,
  );

  // a. create (202) and follow the live progress
  const seenEvents = new Set<string>();
  const onEvent = (m: LiveServerMessage): void => {
    const items =
      m.type === 'snapshot' && Array.isArray(m.data)
        ? m.data
        : m.type === 'update'
          ? (m.upsert ?? [])
          : [];
    for (const item of items) {
      const e = gameEventSchema.safeParse(item);
      if (!e.success || seenEvents.has(e.data.id)) continue;
      seenEvents.add(e.data.id);
      if (e.data.kind !== 'console') log(`game event ${e.data.kind}: ${e.data.text.slice(0, 200)}`);
    }
  };
  const created = await api('POST', '/api/games', {
    templateId: 'minecraft-java',
    serverId,
    name: GAME,
    values: { TYPE: 'PAPER', VERSION: 'LATEST', MEMORY: '4G', MAX_PLAYERS: 5 },
    autoStopMinutes: 0,
  });
  if (created.status !== 202) {
    throw new Error(
      `POST /api/games: HTTP ${created.status} ${(await created.text()).slice(0, 300)}`,
    );
  }
  gameCreated = true;
  const game = gameResponseSchema.parse(await created.json()).game;
  lastGame = game;
  log(`game created: id=${game.id}, ${game.status} "${game.statusText}", ${game.address}`);
  const live = liveClient([`game:${game.id}`], onEvent);
  await live.opened;
  try {
    const ready = await waitGame(game.id, 'game status ok', GAME_READY_S, (g) => g.status === 'ok');
    log(`game ready: ${ready.version ?? '?'} at ${ready.address}`);

    // b. version, players and TPS (TPS comes with the first status or the next 30 s poll)
    const full = await waitGame(
      game.id,
      'version, players and tps',
      120,
      (g) => g.status === 'ok' && g.version !== null && g.players !== null && g.tps !== null,
    );
    if (full.players?.online !== 0)
      throw new Error(`players online ${full.players?.online}, expected 0`);
    if (full.players.max !== 5) throw new Error(`max players ${full.players.max}, expected 5`);
    if (!/paper/i.test(full.version ?? ''))
      log(`note: version "${full.version}" does not say Paper`);
    const gamePort = full.ports.find((p) => p.name === 'game')?.port;
    if (!gamePort) throw new Error('no game port in the summary');
    if (!(await tcpOpen(gamePort))) throw new Error(`game port ${gamePort} not reachable`);
    log(
      `status: version "${full.version}", players ${full.players.online}/${full.players.max}, ` +
        `tps ${full.tps}, ram ${full.ramBytes ?? '-'}/${full.ramLimitBytes ?? '-'}, port ${gamePort} open`,
    );
    const tplImage = docker(['inspect', '--format', '{{.Config.Image}}', GAME_CONTAINER]).trim();
    if (tplImage !== tpl.image)
      throw new Error(`game container image ${tplImage}, expected ${tpl.image}`);

    // c. rendered folder interpolates
    composeConfigCheck(tpl.image, gamePort);

    // d. RCON with step-up
    await stepUp();
    const rcon = async (command: string): Promise<string> =>
      gameRconResponseSchema.parse(
        await json(await api('POST', `/api/games/${game.id}/rcon`, { command }), `rcon ${command}`),
      ).output;
    const list = await rcon('list');
    log(`rcon list: ${list.trim()}`);
    if (!/There are 0 of a max of 5 players online/i.test(list)) {
      throw new Error(`unexpected rcon list output: ${list.slice(0, 200)}`);
    }
    const tps = await rcon('tps');
    log(`rcon tps: ${tps.trim()}`);
    if (!/TPS/i.test(tps)) throw new Error(`unexpected rcon tps output: ${tps.slice(0, 200)}`);

    // e. backup
    await json(await api('POST', `/api/games/${game.id}/backup`), 'games/:id/backup');
    const backup = await waitFor(
      'backup entry',
      300,
      async () => {
        const list = gameBackupListResponseSchema.parse(
          await json(await api('GET', `/api/games/${game.id}/backups`), 'games/:id/backups'),
        ).backups;
        return list.find((b) => b.sizeBytes > 0) ?? null;
      },
      3000,
    );
    log(`backup: ${backup.fileName}, ${backup.sizeBytes} bytes`);
    const size = inAgent(['stat', '-c', '%s', `${GAME_BACKUP_DIR}/${backup.fileName}`]);
    if (Number(size.stdout.trim()) !== backup.sizeBytes) {
      throw new Error(
        `backup file size ${size.stdout.trim() || size.stderr.trim()} != ${backup.sizeBytes}`,
      );
    }
    const leftovers = inAgent(['ls', '-A', GAME_BACKUP_DIR]).stdout;
    if (leftovers.includes('.partial')) throw new Error(`backup temp file left: ${leftovers}`);
    const afterBackup = await waitGame(
      game.id,
      'game idle after backup',
      120,
      (g) => g.status === 'ok',
    );
    if (afterBackup.lastBackupAt === null) throw new Error('lastBackupAt not set');

    // e2. sleep mode: sleep, "Schläft" without waking, login wakes (M12)
    await sleepWakeChecks(game.id, gamePort);

    // f. stop and delete
    await json(await api('POST', `/api/games/${game.id}/stop`), 'games/:id/stop');
    await waitGame(game.id, 'game off', 180, (g) => g.status === 'off', false);
    // compose down removes the container, so "gone" counts as stopped too.
    const state = docker([
      'ps',
      '-a',
      '--filter',
      `name=^${GAME_CONTAINER}$`,
      '--format',
      '{{.State}}',
    ]).trim();
    if (state !== '' && state !== 'exited')
      throw new Error(`game container still running after stop (${state})`);
    log('game stopped');

    await ensureStepUp();
    const wrong = await api('DELETE', `/api/games/${game.id}`, { confirmName: 'not-the-name' });
    const wrongText = await wrong.text();
    if (wrong.status !== 400 || !wrongText.includes('confirm_mismatch')) {
      throw new Error(`delete with a wrong name: HTTP ${wrong.status} ${wrongText.slice(0, 200)}`);
    }
    await json(
      await api('DELETE', `/api/games/${game.id}`, { confirmName: GAME }),
      'DELETE games/:id',
    );
    const gone = await api('GET', `/api/games/${game.id}`);
    if (gone.status !== 404)
      throw new Error(`game still listed after delete (HTTP ${gone.status})`);
    const containerLeft = docker([
      'ps',
      '-a',
      '--filter',
      `name=^${GAME_CONTAINER}$`,
      '--format',
      '{{.Names}}',
    ]).trim();
    if (containerLeft) throw new Error(`game container left after delete: ${containerLeft}`);
    if (inAgent(['test', '-e', GAME_DIR]).code === 0)
      throw new Error(`${GAME_DIR} left after delete`);
    gameCreated = false;
    lastGame = null;
    log('game deleted (container and folder removed)');
  } finally {
    live.close();
  }
}

/** Starts registry:2 and pushes core + agent under the tags they will run with. */
async function prepareRegistry(): Promise<void> {
  dockerFull(['rm', '-f', REGISTRY_NAME]);
  docker([
    'run',
    '-d',
    '--name',
    REGISTRY_NAME,
    '--network',
    'host',
    '-e',
    `REGISTRY_HTTP_ADDR=${REGISTRY}`,
    'registry:2',
  ]);
  registryStarted = true;
  await waitFor('local registry', 30, async () => {
    const r = await fetch(`http://${REGISTRY}/v2/`);
    return r.ok ? true : null;
  });
  for (const [local, tag] of [
    [CORE_IMAGE, REG_CORE],
    [AGENT_IMAGE, REG_AGENT],
  ] as const) {
    docker(['tag', local, tag]);
    docker(['push', '-q', tag]);
  }
  coreRef = REG_CORE;
  agentRef = REG_AGENT;
  log(`registry ${REGISTRY}: core and agent pushed`);
}

/**
 * Builds `FROM <base>` (a local image, nothing is pulled) + a new OCI version label (and optionally a failing health
 * check), tags it as `localTag` and pushes it under `pushAs`. Returns the image id.
 */
function deriveAndPush(
  base: string,
  localTag: string,
  version: string,
  pushAs: string,
  broken = false,
): string {
  const dir = mkdtempSync(path.join(tmp, 'img-'));
  writeFileSync(
    path.join(dir, 'Dockerfile'),
    [
      `FROM ${base}`,
      `LABEL org.opencontainers.image.version=${version}`,
      ...(broken
        ? [
            // Healthy never: the updater must roll back.
            'HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=2 CMD ["node", "-e", "process.exit(1)"]',
          ]
        : []),
      '',
    ].join('\n'),
  );
  docker(['build', '-q', '-t', localTag, dir]);
  docker(['tag', localTag, pushAs]);
  docker(['push', '-q', pushAs]);
  const id = imageId(localTag);
  log(`pushed ${pushAs} = ${localTag} (${version}, ${id.slice(7, 19)})`);
  return id;
}

async function updates() {
  return updatesResponseSchema.parse(await json(await api('GET', '/api/updates'), 'updates'));
}

/** Starts an update run and waits until it is no longer running (the core may restart meanwhile). */
async function runUpdate(
  serverId: string,
  target: 'agent' | 'core',
  timeoutS: number,
): Promise<UpdateRun> {
  const { runId } = updateNowResponseSchema.parse(
    await json(
      await api('POST', `/api/servers/${serverId}/update`, { target }),
      `update ${target}`,
    ),
  );
  log(`update ${target}: run ${runId} started`);
  const run = await waitFor(
    `update run ${target}`,
    timeoutS,
    async () => {
      // Errors (core restarting) are retried by waitFor.
      const r = (await updates()).runs.find((x) => x.id === runId);
      if (!r) throw new Fatal(`run ${runId} not listed`);
      return r.status === 'running' ? null : r;
    },
    3000,
  );
  log(
    `update ${target}: ${run.status}${run.message ? ` (${run.message})` : ''} ${run.from ?? ''} -> ${run.to ?? ''}`,
  );
  return run;
}

function containerByRole(role: string): { id: string; image: string; running: boolean }[] {
  const ids = docker(['ps', '-a', '-q', '--no-trunc', '--filter', `label=hz.role=${role}`])
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  return ids.map((id) => {
    const [image = '', running = ''] = docker([
      'inspect',
      '--format',
      '{{.Image}} {{.State.Running}}',
      id,
    ])
      .trim()
      .split(' ');
    return { id, image, running: running === 'true' };
  });
}

async function waitConnected(what: string, timeoutS = 120): Promise<ServerSummary> {
  return waitFor(what, timeoutS, async () => {
    const s = await findServer();
    return s?.connected ? s : null;
  });
}

async function updateChecks(serverId: string): Promise<void> {
  // The core must know it runs on this server (inventory: container with hz.role=core).
  await waitFor('updates: hostsCore', 120, async () => {
    const st = (await updates()).servers.find((x) => x.serverId === serverId);
    return st?.hostsCore ? st : null;
  });

  // a. core
  const coreBefore = containerByRole('core');
  if (coreBefore.length !== 1)
    throw new Error(`expected one core container, got ${coreBefore.length}`);
  const coreV2 = deriveAndPush(CORE_IMAGE, DERIVED[0], 'smoke-core-2', REG_CORE);
  const coreRun = await runUpdate(serverId, 'core', 6 * 60);
  if (coreRun.status !== 'updated')
    throw new Error(`core update: ${coreRun.status} ${coreRun.message ?? ''}`);
  const coreAfter = containerByRole('core');
  const core = coreAfter[0];
  if (coreAfter.length !== 1 || !core)
    throw new Error(`after the core update: ${coreAfter.length} core containers`);
  if (core.id === coreBefore[0]?.id) throw new Error('core container was not replaced');
  if (core.image !== coreV2) throw new Error(`core runs ${core.image}, expected ${coreV2}`);
  if (!core.running) throw new Error('new core container is not running');
  const health = await fetch(`${BASE}/api/health`);
  if (!health.ok) throw new Error(`/api/health after the core update: HTTP ${health.status}`);
  await waitConnected('agent reconnected after the core update');
  log('core update: replaced, healthy, agent connected');

  // b. agent
  const agentV2 = deriveAndPush(AGENT_IMAGE, DERIVED[1], 'smoke-agent-2', REG_AGENT);
  const agentRun = await runUpdate(serverId, 'agent', 8 * 60);
  if (agentRun.status !== 'updated')
    throw new Error(`agent update: ${agentRun.status} ${agentRun.message ?? ''}`);
  const agentImage = docker(['inspect', '--format', '{{.Image}}', AGENT_CONTAINER]).trim();
  if (agentImage !== agentV2) throw new Error(`agent runs ${agentImage}, expected ${agentV2}`);
  await waitConnected('new agent connected');
  log('agent update: new image runs and is connected');

  // c. broken agent image -> rolled back
  deriveAndPush(DERIVED[1], DERIVED[2], 'smoke-agent-broken', REG_AGENT, true);
  const brokenRun = await runUpdate(serverId, 'agent', 8 * 60);
  if (brokenRun.status !== 'rolled_back') {
    throw new Error(
      `broken agent image: ${brokenRun.status} ${brokenRun.message ?? ''} (expected rolled_back)`,
    );
  }
  const back = containerByRole('agent').filter((c) => c.running);
  if (back.length !== 1 || back[0]?.image !== agentV2) {
    throw new Error(
      `after the rollback: ${JSON.stringify(back)} (expected one agent on ${agentV2})`,
    );
  }
  await waitConnected('agent connected again after the rollback');
  const warn = await waitFor('warn alert for the rollback', 30, async () => {
    const alerts = alertListResponseSchema.parse(
      await json(
        await api('GET', `/api/alerts?state=open&serverId=${encodeURIComponent(serverId)}`),
        'alerts',
      ),
    );
    return (
      alerts.alerts.find((a) => a.key === `update:${serverId}:agent` && a.level === 'warn') ?? null
    );
  });
  log(`rollback: old agent runs again, alert "${warn.title}"`);

  // d. the agent removes the exited helper (30 s after sending the result).
  await waitFor('updater helper removed', 120, async () =>
    containerByRole('updater').length === 0 ? true : null,
  );
  // Later steps (and a re-run) use the good image under the tag again.
  docker(['tag', DERIVED[1], REG_AGENT]);
  docker(['push', '-q', REG_AGENT]);
  log('M17 auto-update checks done');
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

/** Removes a left-over game (container, folder, backups) after a failed run. */
function removeGame(): void {
  if (!gameCreated) return;
  try {
    docker(['rm', '-f', '-v', GAME_CONTAINER]);
  } catch {
    // gone
  }
  try {
    // The files are root-owned (written by the agent); remove them from a container.
    docker([
      'run',
      '--rm',
      '-v',
      '/opt/homelab:/opt/homelab',
      NEW_IMAGE,
      'rm',
      '-rf',
      GAME_DIR,
      GAME_BACKUP_DIR,
    ]);
  } catch {
    // nothing to remove
  }
}

function cleanup(): void {
  removeSmokeContainers();
  removeGame();
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
  // M17 leftovers: updater helpers, renamed old containers, the core volume, registry, images.
  for (const filter of ['label=hz.role=updater', 'name=-hz-old-']) {
    const r = dockerFull(['ps', '-a', '-q', '--filter', filter]);
    for (const id of r.stdout
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)) {
      dockerFull(['rm', '-f', id]);
    }
  }
  try {
    docker(['rm', '-f', '-v', CORE_NAME]);
  } catch {
    // not started
  }
  dockerFull(['volume', 'rm', CORE_VOLUME]);
  if (registryStarted) dockerFull(['rm', '-f', '-v', REGISTRY_NAME]);
  dockerFull(['rmi', ...DERIVED, REG_CORE, REG_AGENT]);
  rmSync(tmp, { recursive: true, force: true });
}

function dumpLogs(): void {
  if (lastGame) {
    // Field values are not secret (secrets never reach a summary), but are not needed here.
    const rest = { ...lastGame, values: {} };
    process.stdout.write(`--- last game summary\n${JSON.stringify(rest, null, 2)}\n`);
  }
  for (const args of [
    ['ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'],
    ['logs', '--tail', '200', CORE_NAME],
    ['compose', '-p', AGENT_PROJECT, '-f', composeFile, 'logs', '--tail', '200'],
    ...dockerFull(['ps', '-a', '-q', '--filter', 'label=hz.role=updater'])
      .stdout.split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((id) => ['logs', '--tail', '200', id]),
    ...(gameCreated
      ? [
          ['logs', '--tail', '200', GAME_CONTAINER],
          ['inspect', '--format', '{{json .State}}', GAME_CONTAINER],
        ]
      : []),
  ]) {
    process.stdout.write(`--- docker ${args.join(' ')}\n`);
    const r = dockerFull(args, composeEnv());
    // docker logs replays the container's stderr on stderr: print both.
    process.stdout.write(r.stdout);
    if (r.stderr) process.stdout.write(r.stderr);
    if (r.code !== 0) process.stdout.write(`(exit ${r.code})\n`);
  }
}

async function main(): Promise<void> {
  log(`core ${CORE_IMAGE}, agent ${AGENT_IMAGE}`);
  if (SKIP_UPDATE) log('update checks skipped (HZ_SMOKE_SKIP_UPDATE=1)');
  else await prepareRegistry();
  docker([
    'run',
    '-d',
    '--name',
    CORE_NAME,
    // M17: the agent finds and updates the core by this label; the DB survives in the volume.
    '--label',
    'hz.role=core',
    '-v',
    `${CORE_VOLUME}:/data`,
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
    coreRef,
  ]);

  await waitFor('core /api/health', 60, async () => {
    const r = await fetch(`${BASE}/api/health`);
    return r.ok ? true : null;
  });
  log('core is healthy');

  // Setup: account + TOTP.
  const start = setupStartResponseSchema.parse(
    await json(
      await api('POST', '/api/setup/start', { setupToken, username: 'admin', password }),
      'setup/start',
    ),
  );
  totp = new TOTP({ secret: Secret.fromBase32(start.secret), digits: 6, period: 30 });
  const confirmStep = totp.counter();
  const confirm = await api('POST', '/api/setup/confirm', { setupToken, code: totp.generate() });
  await json(confirm, 'setup/confirm');
  lastTotpStep = confirmStep;
  const session = confirm.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .find((c) => c.startsWith('hz_session='));
  if (!session) throw new Error('setup/confirm did not set the session cookie');
  cookie = session;
  log('setup done, logged in');

  // Creating an enrollment token needs a step-up session.
  await stepUp();
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
  if (SKIP_GAME) log('game checks skipped (HZ_SMOKE_SKIP_GAME=1)');
  else await gameChecks(connected.id);
  if (!SKIP_UPDATE) await updateChecks(connected.id);

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

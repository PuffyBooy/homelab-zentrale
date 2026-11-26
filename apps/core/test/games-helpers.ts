import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gameResponseSchema, type ContainerInfo, type GameSummary, type Modules } from '@hz/shared';
import {
  enrollAgent,
  inventoryMsg,
  listen,
  metricsMsg,
  until,
  type Received,
  type WsClient,
} from './agent-helpers.js';
import type { AppDeps } from '../src/app.js';
import type { FetchLike } from '../src/checks/rdap.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

/** Fake secret generated at runtime (no secret-looking literals in the repo, gitleaks). */
export const fakeSecret = (): string => randomBytes(8).toString('hex');

export const FIXTURE_TEMPLATES = fileURLToPath(new URL('./fixtures/games', import.meta.url));
export const REPO_TEMPLATES = fileURLToPath(new URL('../../../templates/games', import.meta.url));

export interface StatusAnswer {
  online: boolean;
  players: { online: number; max: number; names: string[] } | null;
  version: string | null;
  tps: number | null;
}

export const ONLINE: StatusAnswer = {
  online: true,
  players: { online: 2, max: 20, names: ['steve', 'mia'] },
  version: 'Paper 1.21.4',
  tps: 19.8,
};

/** How the simulated agent answers. `fail` maps an action to an rpc error. */
export interface AgentBehaviour {
  status: StatusAnswer | { error: string };
  fail: Partial<Record<string, { code: string; message: string }>>;
  backup:
    | { kind: 'ok'; sizeBytes: number }
    | { kind: 'fail'; code: number; error?: string }
    /** Refused before streaming (rpc error), e.g. not_found for a template without ./data. */
    | { kind: 'refuse'; code: string; message: string }
    /** No answer: the test ends the stream itself. */
    | { kind: 'hold' };
  /** Docker memory of the game container. */
  memBytes: number;
  /** Text appended to every rcon output. */
  rconSuffix: string;
  /** M12: jars in data/plugins|mods (game.mods.*). */
  mods: { fileName: string; sizeBytes: number; sha512: string }[];
  /** M12: game.restore outcome. */
  restore: 'ok' | 'fail';
  /** M12: archive bytes game.export sends (world download); null: no answer (M11 tests). */
  exportData: Buffer | null;
  /** M12: game.export fails before transfer.begin. */
  exportFail: boolean;
}

export interface GameSetup {
  t: TestApp;
  url: string;
  cookie: string;
  secret: string;
  agent: WsClient;
  serverId: string;
  /** Permanent token of the fake agent (reconnect tests). */
  agentToken: string;
  rpcs: Received[];
  behaviour: AgentBehaviour;
  headers: Record<string, string>;
  /** Containers the fake agent reports (game containers appear after compose.up). */
  running: Map<string, ContainerInfo>;
  keepAlive: () => Promise<void>;
  sendInventory: () => Promise<void>;
}

let dockerSeq = 0x100000000000;
/** Backup file name like game.backup writes it: <name>-YYYYMMDD-HHMMSS.tar.zst. */
export const backupName = (name: string, seq: number): string =>
  `${name}-20261125-12${String(seq).padStart(4, '0')}.tar.zst`;
const nextDockerId = (): string => (dockerSeq++).toString(16).padStart(12, '0');

/**
 * App with the fixture templates, an admin, and an enrolled fake agent that
 * answers compose.*, game.* and container.* like the real one (compose up/down
 * add and remove the game container in its inventory).
 */
export async function withGames(
  clients: WsClient[],
  opts: {
    captureLogs?: boolean;
    templatesDir?: string;
    ramPct?: number;
    gameFetch?: FetchLike;
    /** M15 relay DNS: domains module state and its fake providers (domains-helpers.ts). */
    modules?: Partial<Modules>;
    features?: AppDeps['features'];
  } = {},
): Promise<GameSetup> {
  const t = await makeApp({
    env: { HZ_GAME_TEMPLATES_DIR: opts.templatesDir ?? FIXTURE_TEMPLATES },
    liveOptions: { throttleMs: 10, appendThrottleMs: 5 },
    ...(opts.gameFetch ? { gameFetch: opts.gameFetch } : {}),
    ...(opts.modules ? { modules: opts.modules } : {}),
    ...(opts.features ? { features: opts.features } : {}),
    ...(opts.captureLogs ? { captureLogs: true } : {}),
  });
  const admin = await completeSetup(t);
  const url = await listen(t);
  const e = await enrollAgent(t, url, admin.cookie);
  clients.push(e.agent);
  const rpcs: Received[] = [];
  const running = new Map<string, ContainerInfo>();
  const behaviour: AgentBehaviour = {
    status: ONLINE,
    fail: {},
    backup: { kind: 'ok', sizeBytes: 123_456 },
    memBytes: 3 * 1024 ** 3,
    rconSuffix: '',
    mods: [],
    restore: 'ok',
    exportData: null,
    exportFail: false,
  };
  const pongs = { n: 0 };
  const inventory = () =>
    inventoryMsg({
      containers: [...running.values()],
      listeningPorts: [
        { proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd' },
        { proto: 'tcp', address: '0.0.0.0', port: 25565, process: 'java' },
        { proto: 'udp', address: '0.0.0.0', port: 2457 },
      ],
    });
  let backupSeq = 0;
  e.agent.ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as Received;
    if (m.type === 'pong') pongs.n += 1;
    if (m.type === 'ping') e.agent.send({ type: 'pong', ts: m.ts });
    if (m.type !== 'rpc') return;
    rpcs.push(m);
    const id = m.id as string;
    const action = m.action as string;
    const params = m.params as Record<string, unknown>;
    const ok = (d: unknown) => e.agent.send({ type: 'rpc.result', id, ok: true, data: d });
    const failure = behaviour.fail[action];
    if (failure) {
      e.agent.send({ type: 'rpc.result', id, ok: false, error: failure });
      return;
    }
    const dir = (params.dir ?? params.gameDir) as string;
    const name = dir?.split('/').pop() ?? '';
    switch (action) {
      case 'compose.up':
        running.set(name, {
          dockerId: nextDockerId(),
          name: `game-${name}`,
          image: 'itzg/minecraft-server:latest',
          composeProject: name,
          composeService: 'server',
          composeDir: dir,
          state: 'running',
          health: 'none',
          statusText: 'Up 1 second',
          startedAt: new Date(t.clock.t).toISOString(),
          ports: [],
          memBytes: behaviour.memBytes,
          game: name,
        });
        e.agent.send(inventory());
        ok({ output: '' });
        return;
      case 'compose.down':
      case 'game.remove':
        running.delete(name);
        e.agent.send(inventory());
        ok(action === 'game.remove' ? null : { output: '' });
        return;
      case 'game.status': {
        const st = behaviour.status;
        if ('error' in st) {
          e.agent.send({
            type: 'rpc.result',
            id,
            ok: false,
            error: { code: 'failed', message: st.error },
          });
        } else ok(st);
        return;
      }
      case 'game.rcon':
        ok({ output: `ran ${String(params.command)}${behaviour.rconSuffix}` });
        return;
      case 'game.backups.purge':
        ok({ removed: 2 });
        return;
      case 'game.backup': {
        const b = behaviour.backup;
        if (b.kind === 'hold') return;
        if (b.kind === 'refuse') {
          e.agent.send({
            type: 'rpc.result',
            id,
            ok: false,
            error: { code: b.code, message: b.message },
          });
          return;
        }
        e.agent.send({
          type: 'stream.data',
          streamId: id,
          channel: 'progress',
          chunk: 'tar ./data\n',
        });
        if (b.kind === 'ok') {
          backupSeq += 1;
          // Like apps/agent/src/actions/game-backup.ts: rpc.result first, then progress lines,
          // the last one carries the result.
          ok(null);
          const progress = (chunk: string) =>
            e.agent.send({ type: 'stream.data', streamId: id, channel: 'progress', chunk });
          progress('backup: 12.5 MiB written\n');
          progress(
            `result ${JSON.stringify({
              path: `/opt/homelab/backups/${name}/${backupName(name, backupSeq)}`,
              sizeBytes: b.sizeBytes,
            })}\n`,
          );
          e.agent.send({ type: 'stream.end', streamId: id, code: 0 });
        } else {
          e.agent.send({
            type: 'stream.end',
            streamId: id,
            code: b.code,
            ...(b.error ? { error: b.error } : {}),
          });
        }
        return;
      }
      case 'game.wake.arm':
        ok({ listening: params.ports });
        return;
      case 'game.mods.list':
        ok({ files: behaviour.mods });
        return;
      case 'game.mods.install': {
        const f = {
          fileName: String(params.fileName),
          sizeBytes: Number(params.sizeBytes),
          sha512: String(params.sha512),
        };
        behaviour.mods.push(f);
        ok(f);
        return;
      }
      case 'game.mods.remove':
        behaviour.mods = behaviour.mods.filter((m) => m.fileName !== params.fileName);
        ok(null);
        return;
      case 'game.restore': {
        if (behaviour.restore === 'fail') {
          e.agent.send({ type: 'stream.end', streamId: id, code: 1, error: 'failed' });
          return;
        }
        ok(null);
        e.agent.send({
          type: 'stream.data',
          streamId: id,
          channel: 'progress',
          chunk: `restore: extracting\nresult ${JSON.stringify({ entries: 42 })}\n`,
        });
        e.agent.send({ type: 'stream.end', streamId: id, code: 0 });
        return;
      }
      case 'game.export': {
        if (behaviour.exportData === null) {
          ok(null);
          return;
        }
        if (behaviour.exportFail) {
          e.agent.send({ type: 'stream.end', streamId: id, code: 1, error: 'failed' });
          return;
        }
        ok(null);
        const data = behaviour.exportData;
        const chunk = 48 * 1024;
        const chunks = Math.ceil(data.length / chunk);
        const sha256 = createHash('sha256').update(data).digest('hex');
        e.agent.send({ type: 'transfer.begin', streamId: id, bytes: data.length, sha256, chunks });
        for (let i = 0; i < chunks; i += 1) {
          e.agent.send({
            type: 'transfer.chunk',
            streamId: id,
            seq: i,
            data: data.subarray(i * chunk, (i + 1) * chunk).toString('base64'),
          });
        }
        e.agent.send({ type: 'transfer.end', streamId: id, bytes: data.length, sha256, chunks });
        e.agent.send({ type: 'stream.end', streamId: id, code: 0 });
        return;
      }
      default:
        ok(action === 'compose.write' ? { dir, files: Object.keys(params.files as object) } : null);
    }
  });
  e.agent.send(metricsMsg({ ramPct: opts.ramPct ?? 40 }));
  e.agent.send(inventory());
  const setup: GameSetup = {
    t,
    url,
    ...admin,
    agent: e.agent,
    serverId: e.serverId,
    agentToken: e.agentToken,
    rpcs,
    behaviour,
    headers: authHeaders(admin.cookie),
    running,
    keepAlive: async () => {
      const before = pongs.n;
      e.agent.send({ type: 'ping', ts: new Date(t.clock.t).toISOString() });
      await until(() => pongs.n > before);
    },
    sendInventory: async () => {
      const before = pongs.n;
      e.agent.send(inventory());
      e.agent.send({ type: 'ping', ts: new Date(t.clock.t).toISOString() });
      await until(() => pongs.n > before);
    },
  };
  await setup.keepAlive();
  return setup;
}

export function createGame(s: GameSetup, payload: Record<string, unknown> = {}) {
  return s.t.app.inject({
    method: 'POST',
    url: '/api/games',
    headers: s.headers,
    payload: {
      templateId: 'minecraft-java',
      serverId: s.serverId,
      name: 'survival',
      values: {},
      ...payload,
    },
  });
}

export function rpcsOf(s: GameSetup, action: string): Received[] {
  return s.rpcs.filter((r) => r.action === action);
}

/** Moves the fake clock, keeps the agent alive, runs the scheduler and waits for game tasks. */
export async function tick(s: GameSetup, ms: number): Promise<void> {
  s.t.clock.advance(ms);
  await s.keepAlive();
  await s.t.app.hzCore.scheduler.tick();
  await s.t.app.hzCore.games.idle();
}

/** Creates a Minecraft game and waits until it is ready. */
export async function readyGame(
  s: GameSetup,
  payload: Record<string, unknown> = {},
): Promise<GameSummary> {
  const res = await createGame(s, payload);
  if (res.statusCode !== 202) throw new Error(`create ${res.statusCode} ${res.body}`);
  const { game } = gameResponseSchema.parse(res.json());
  await s.t.app.hzCore.games.idle();
  await tick(s, 5_000);
  const now = s.t.app.hzCore.games.summary(game.id);
  if (now?.status !== 'ok' && now?.status !== 'warn') {
    throw new Error(`not ready: ${now?.status} ${now?.statusText}`);
  }
  return now;
}

export function gameRequest(
  s: GameSetup,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  return s.t.app.inject({
    method,
    url,
    headers: s.headers,
    ...(payload ? { payload } : {}),
  });
}

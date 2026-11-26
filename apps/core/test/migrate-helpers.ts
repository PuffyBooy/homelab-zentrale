import { createHash, randomBytes } from 'node:crypto';
import {
  gameMigrationResponseSchema,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_WINDOW,
  type ContainerInfo,
  type Migration,
  type Modules,
} from '@hz/shared';
import {
  connectAgent,
  enrollAgent,
  inventoryMsg,
  metricsMsg,
  until,
  type Received,
  type WsClient,
} from './agent-helpers.js';
import type { AppDeps } from '../src/app.js';
import { ONLINE, readyGame, withGames, type GameSetup } from './games-helpers.js';

/** How the fake source agent answers game.export. */
export interface ExportBehaviour {
  data: Buffer;
  /** Overrides of transfer.begin / transfer.end values. */
  beginBytes?: number;
  beginSha?: string;
  endSha?: string;
  /** Send every chunk at once, ignoring acks (a misbehaving agent). */
  ignoreWindow?: boolean;
  /** Stop after this many chunks (the test continues or disconnects). */
  stopAfterChunks?: number;
  /** Do not send transfer.begin until `release()`. */
  holdBegin?: boolean;
  /** stream.end with this error instead of an archive. */
  failWith?: string;
}

/** How the fake target agent answers game.import. */
export interface ImportBehaviour {
  refuse?: { code: string; message: string };
  holdAcks?: boolean;
  /** Hold the end of the extraction (result + stream.end) until `releaseEnd()`. */
  holdEnd?: boolean;
}

export interface FakeAgent {
  ws: WsClient;
  serverId: string;
  rpcs: Received[];
  running: Map<string, ContainerInfo>;
  /** Chunks the agent received (game.import). */
  chunks: { seq: number; bytes: number }[];
  sendInventory(listening?: number[]): void;
  /** Finishes a held extraction (ImportBehaviour.holdEnd). */
  releaseEnd(): void;
}

let dockerSeq = 0x200000000000;
const nextDockerId = (): string => (dockerSeq++).toString(16).padStart(12, '0');

/**
 * Answers compose.*, game.status/remove/rcon and game.import like the real
 * agent (minimal, for the target of a migration).
 */
export function installFakeAgent(
  s: GameSetup,
  ws: WsClient,
  serverId: string,
  imp: ImportBehaviour,
  listening: number[] = [],
  /** M15: Tailscale address the agent reports (default: inventoryMsg's). */
  tailscaleIp?: string,
): FakeAgent {
  const rpcs: Received[] = [];
  const running = new Map<string, ContainerInfo>();
  const chunks: { seq: number; bytes: number }[] = [];
  const inventory = (ports: number[]) =>
    inventoryMsg({
      ...(tailscaleIp
        ? {
            system: {
              hostname: 'cloud',
              os: 'Ubuntu 24.04',
              kernel: '6.8.0',
              arch: 'x64',
              tailscaleIp,
            },
          }
        : {}),
      containers: [...running.values()],
      listeningPorts: [
        { proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd' },
        ...ports.map((port) => ({ proto: 'tcp' as const, address: '0.0.0.0', port })),
      ],
    });
  let lastListening = listening;
  const imports = new Map<string, { parts: Buffer[] }>();
  let heldEnd: (() => void) | null = null;
  ws.ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as Received;
    if (m.type === 'ping') ws.send({ type: 'pong', ts: m.ts });
    if (m.type === 'transfer.chunk') {
      const st = imports.get(m.streamId as string);
      if (!st) return;
      const buf = Buffer.from(m.data as string, 'base64');
      st.parts.push(buf);
      chunks.push({ seq: m.seq as number, bytes: buf.length });
      if (!imp.holdAcks) ws.send({ type: 'transfer.ack', streamId: m.streamId, seq: m.seq });
      return;
    }
    if (m.type === 'transfer.end') {
      const id = m.streamId as string;
      const st = imports.get(id);
      if (!st) return;
      const all = Buffer.concat(st.parts);
      const sha = createHash('sha256').update(all).digest('hex');
      imports.delete(id);
      if (sha !== m.sha256 || all.length !== m.bytes) {
        ws.send({ type: 'stream.end', streamId: id, code: 1, error: 'checksum_mismatch' });
        return;
      }
      const finish = () => {
        ws.send({
          type: 'stream.data',
          streamId: id,
          channel: 'progress',
          chunk: `result ${JSON.stringify({ bytes: all.length, sha256: sha, entries: 3 })}\n`,
        });
        ws.send({ type: 'stream.end', streamId: id, code: 0 });
      };
      if (imp.holdEnd) heldEnd = finish;
      else finish();
      return;
    }
    if (m.type === 'stream.cancel') {
      imports.delete(m.streamId as string);
      return;
    }
    if (m.type !== 'rpc') return;
    rpcs.push(m);
    const id = m.id as string;
    const action = m.action as string;
    const params = m.params as Record<string, unknown>;
    const ok = (d: unknown) => ws.send({ type: 'rpc.result', id, ok: true, data: d });
    const dir = (params.dir ?? params.gameDir) as string | undefined;
    const name = dir?.split('/').pop() ?? '';
    switch (action) {
      case 'game.import':
        if (imp.refuse) {
          ws.send({ type: 'rpc.result', id, ok: false, error: imp.refuse });
          return;
        }
        imports.set(id, { parts: [] });
        ok(null);
        return;
      case 'compose.up':
        running.set(name, {
          dockerId: nextDockerId(),
          name: `game-${name}`,
          image: 'itzg/minecraft-server:latest',
          composeProject: name,
          composeService: 'server',
          composeDir: dir as string,
          state: 'running',
          health: 'none',
          statusText: 'Up 1 second',
          startedAt: new Date(s.t.clock.t).toISOString(),
          ports: [],
          memBytes: 3 * 1024 ** 3,
        });
        ws.send(inventory(lastListening));
        ok({ output: '' });
        return;
      case 'compose.down':
      case 'game.remove':
        running.delete(name);
        ws.send(inventory(lastListening));
        ok(action === 'game.remove' ? null : { output: '' });
        return;
      case 'game.status':
        ok(ONLINE);
        return;
      case 'game.rcon':
        ok({ output: `ran ${String(params.command)}` });
        return;
      case 'compose.write':
        ok({ dir, files: Object.keys(params.files as object) });
        return;
      default:
        ok(null);
    }
  });
  const agent: FakeAgent = {
    ws,
    serverId,
    rpcs,
    running,
    chunks,
    sendInventory: (ports = lastListening) => {
      lastListening = ports;
      ws.send(inventory(ports));
    },
    releaseEnd: () => {
      const f = heldEnd;
      heldEnd = null;
      f?.();
    },
  };
  return agent;
}

export interface ExportControl {
  /** Chunks sent so far. */
  sent: number;
  /** Highest ack received. */
  acked: number;
  /** Sends transfer.begin (holdBegin) or continues after stopAfterChunks. */
  release(): void;
  streamIds: string[];
}

/** Adds game.export to the source fake agent of withGames. */
export function installExport(s: GameSetup, b: ExportBehaviour): ExportControl {
  const ctl: ExportControl = { sent: 0, acked: -1, release: () => undefined, streamIds: [] };
  s.agent.ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as Received;
    if (m.type === 'transfer.ack' && ctl.streamIds.includes(m.streamId as string)) {
      ctl.acked = Math.max(ctl.acked, m.seq as number);
      pump();
      return;
    }
    if (m.type !== 'rpc' || m.action !== 'game.export') return;
    const id = m.id as string;
    ctl.streamIds.push(id);
    // The default handler of withGames already answered rpc.result ok.
    if (b.failWith) {
      s.agent.send({ type: 'stream.end', streamId: id, code: 1, error: b.failWith });
      return;
    }
    s.agent.send({ type: 'stream.data', streamId: id, channel: 'progress', chunk: 'tar ./data\n' });
    const total = Math.ceil(b.data.length / TRANSFER_CHUNK_BYTES);
    const sha = createHash('sha256').update(b.data).digest('hex');
    let limit = b.stopAfterChunks ?? total;
    let ended = false;
    const begin = () =>
      s.agent.send({
        type: 'transfer.begin',
        streamId: id,
        bytes: b.beginBytes ?? b.data.length,
        sha256: b.beginSha ?? sha,
        chunks: total,
      });
    pumpFn = () => {
      while (
        ctl.sent < total &&
        ctl.sent < limit &&
        (b.ignoreWindow || ctl.sent <= ctl.acked + TRANSFER_WINDOW)
      ) {
        const seq = ctl.sent;
        const data = b.data
          .subarray(seq * TRANSFER_CHUNK_BYTES, (seq + 1) * TRANSFER_CHUNK_BYTES)
          .toString('base64');
        s.agent.send({ type: 'transfer.chunk', streamId: id, seq, data });
        ctl.sent += 1;
      }
      if (ctl.sent === total && !ended) {
        ended = true;
        s.agent.send({
          type: 'transfer.end',
          streamId: id,
          chunks: total,
          bytes: b.beginBytes ?? b.data.length,
          sha256: b.endSha ?? b.beginSha ?? sha,
        });
        s.agent.send({ type: 'stream.end', streamId: id, code: 0 });
      }
    };
    ctl.release = () => {
      if (b.holdBegin) {
        b.holdBegin = false;
        begin();
      }
      limit = total;
      pump();
    };
    if (b.holdBegin) return;
    begin();
    pump();
  });
  let pumpFn: () => void = () => undefined;
  const pump = () => pumpFn();
  return ctl;
}

export interface MigrateSetup {
  s: GameSetup;
  gameId: string;
  target: FakeAgent;
  targetToken: string;
}

/**
 * Two sim servers: `heimserver` (source, with a ready Minecraft game) and
 * `cloud` (target, port 25566 already used there).
 */
export async function withTwoServers(
  clients: WsClient[],
  imp: ImportBehaviour = {},
  opts: {
    targetRamPct?: number;
    targetListening?: number[];
    targetTailscaleIp?: string;
    modules?: Partial<Modules>;
    features?: AppDeps['features'];
    captureLogs?: boolean;
  } = {},
): Promise<MigrateSetup> {
  const s = await withGames(clients, {
    ...(opts.modules ? { modules: opts.modules } : {}),
    ...(opts.features ? { features: opts.features } : {}),
    ...(opts.captureLogs ? { captureLogs: true } : {}),
  });
  const game = await readyGame(s);
  const e = await enrollAgent(s.t, s.url, s.cookie, 'cloud');
  clients.push(e.agent);
  const target = installFakeAgent(
    s,
    e.agent,
    e.serverId,
    imp,
    opts.targetListening ?? [25566],
    opts.targetTailscaleIp,
  );
  e.agent.send(metricsMsg({ ramPct: opts.targetRamPct ?? 40 }));
  target.sendInventory();
  await keepAlive(target);
  await s.keepAlive();
  return { s, gameId: game.id, target, targetToken: e.agentToken };
}

/** Round trip on the agent socket so earlier frames are processed by the core. */
export async function keepAlive(a: FakeAgent): Promise<void> {
  const ts = new Date().toISOString();
  a.ws.send({ type: 'ping', ts });
  await a.ws.next((m) => m.type === 'pong');
}

/** Reconnects a server with a fresh fake agent. */
export async function reconnect(
  s: GameSetup,
  url: string,
  token: string,
  serverId: string,
  name: string,
  clients: WsClient[],
): Promise<FakeAgent> {
  const ws = await connectAgent(url, token, name);
  clients.push(ws);
  const a = installFakeAgent(s, ws, serverId, {});
  ws.send(metricsMsg());
  a.sendInventory();
  await keepAlive(a);
  return a;
}

export const archive = (bytes: number): Buffer => randomBytes(bytes);

export async function migration(s: GameSetup, gameId: string): Promise<Migration | null> {
  const res = await s.t.app.inject({
    method: 'GET',
    url: `/api/games/${gameId}/migration`,
    headers: s.headers,
  });
  if (res.statusCode !== 200) throw new Error(`migration ${res.statusCode}`);
  return gameMigrationResponseSchema.parse(res.json()).migration;
}

/** Waits until the latest migration of the game is done or failed. */
export async function settled(s: GameSetup, gameId: string, timeoutMs = 5000): Promise<Migration> {
  await until(() => {
    const row = s.t.db.sqlite
      .prepare('SELECT phase FROM game_migrations WHERE game_id = ? ORDER BY started_at DESC')
      .get(gameId) as { phase: string } | undefined;
    return row?.phase === 'done' || row?.phase === 'failed';
  }, timeoutMs);
  const m = await migration(s, gameId);
  if (!m) throw new Error('no migration');
  return m;
}

/** Waits until the latest migration reaches `phase` (or later). */
export async function reached(s: GameSetup, gameId: string, phase: string): Promise<void> {
  await until(() => {
    const row = s.t.db.sqlite
      .prepare('SELECT phase FROM game_migrations WHERE game_id = ? ORDER BY started_at DESC')
      .get(gameId) as { phase: string } | undefined;
    return row?.phase === phase;
  });
}

export function startMigration(s: GameSetup, gameId: string, payload: Record<string, unknown>) {
  return s.t.app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/migrate`,
    headers: s.headers,
    payload,
  });
}

export const actionsOf = (rpcs: Received[], action: string): Received[] =>
  rpcs.filter((r) => r.action === action);

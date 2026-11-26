import { createHash, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';

/**
 * Simulated agent for e2e: speaks the protocol from packages/shared/src/agent-protocol.ts
 * (hello -> enrolled/welcome -> metrics + inventory) and answers the RPCs the web UI can
 * trigger: cleanup preview and cleanup (M2), container.* and compose.* with a fresh
 * inventory, container.logs as a stream (M3), container.limit (M10), and for M11 the
 * listening ports of the inventory plus game.export / game.import (binary transfer with
 * transfer.begin/chunk/ack/end and a sha256 check). Nothing here runs a real command.
 */

/** Same shape as listeningPortSchema in packages/shared. */
export interface SimListeningPort {
  proto: 'tcp' | 'udp';
  address: string;
  port: number;
  process?: string;
}

/** Same values as packages/shared (agent-protocol.ts, M11 transfer). */
const TRANSFER_CHUNK_BYTES = 48 * 1024;
const TRANSFER_WINDOW = 32;

/** Same shape as containerInfoSchema in packages/shared (kept local, e2e has no deps). */
export interface SimContainer {
  dockerId: string;
  name: string;
  image: string;
  imageId?: string;
  composeProject?: string;
  composeService?: string;
  composeDir?: string;
  state: 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
  statusText: string;
  exitCode?: number;
  startedAt?: string;
  ports: { privatePort: number; publicPort?: number; ip?: string; proto: 'tcp' | 'udp' }[];
  cpu?: number;
  memBytes?: number;
  restartCount?: number;
  /** Label hz.role (core/agent): never a throttle target, container.limit is refused. */
  role?: 'core' | 'agent';
  /** Current docker --cpus limit, null without a limit (container.limit). */
  cpuLimit?: number | null;
}

export function hexId(): string {
  return randomBytes(32).toString('hex');
}

export function imageId(): string {
  return `sha256:${randomBytes(32).toString('hex')}`;
}

interface LogStream {
  streamId: string;
  dockerId: string;
  timer: ReturnType<typeof setInterval> | null;
  n: number;
}

const PROTOCOL_VERSION = 1;
const GB = 1024 ** 3;
/** cpuCores in the sim inventory; container.limit caps at this. */
const SIM_CPU_CORES = 4;

export interface SimAgentOptions {
  url: string;
  name: string;
  token: string;
  cpu?: number;
  ramUsed?: number;
  ramTotal?: number;
  diskUsed?: number;
  diskTotal?: number;
  temp?: number | null;
  tailscaleIp?: string;
  metricsEveryMs?: number;
  /** Docker containers in the inventory. Turns on the docker capability. */
  containers?: SimContainer[];
  /** Interval of followed log lines. */
  logEveryMs?: number;
  /** Simulate game servers: compose.write, compose.down and game.status. */
  games?: boolean;
  /** Announce the terminal capability and answer pty.* with an echo shell. */
  terminal?: boolean;
  /** inventory.listeningPorts; default sshd on 0.0.0.0:22 and python3 on 127.0.0.1:8123. */
  listeningPorts?: SimListeningPort[];
  /** Size of the simulated world archive game.export sends (default 100 KiB, 3 chunks). */
  exportBytes?: number;
  /** M13: inventory.storage (RAID, volumes, disks); left out when undefined. */
  storage?: Record<string, unknown>;
  /** M15: announce the relay capability and accept relay.set (no sockets are opened). */
  relay?: boolean;
}

/** An archive game.import is receiving. */
interface SimImport {
  gameId: string;
  bytes: number;
  sha256: string;
  chunks: number;
  parts: Buffer[];
}

/** An archive game.export is sending, waiting for acks beyond the window. */
interface SimExport {
  streamId: string;
  data: Buffer;
  chunks: number;
  next: number;
  acked: number;
}

/** One simulated PTY: echoes input like a line-mode shell, never runs anything. */
interface SimPty {
  streamId: string;
  cols: number;
  rows: number;
  line: string;
}

type Msg = { type: string; [k: string]: unknown };

export class SimAgent {
  serverId: string | null = null;
  agentToken: string | null = null;
  readonly received: Msg[] = [];
  /** Every RPC the core sent, in order (for asserting the right action). */
  readonly rpcs: { action: string; params: Record<string, unknown> }[] = [];
  containers: SimContainer[];
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly streams = new Map<string, LogStream>();
  /** Open PTYs by stream id. */
  readonly ptys = new Map<string, SimPty>();
  /** Every size the core sent (open and resize), for asserting the fit. */
  readonly ptySizes: { cols: number; rows: number }[] = [];
  /** All input that reached the agent (the core must not log it, the test checks it got here). */
  ptyInput = '';
  /** Public and local listening ports reported in every inventory (M11 port audit). */
  listeningPorts: SimListeningPort[];
  /** M13: inventory.storage sent with every inventory (setStorage changes it). */
  storage: Record<string, unknown> | undefined;
  /** World data per game folder name: set by game.import, read by game.export. */
  readonly gameData = new Map<string, Buffer>();
  private readonly imports = new Map<string, SimImport>();
  private readonly exports = new Map<string, SimExport>();
  /** M15: the routes of the last accepted relay.set. */
  relayRoutes: Record<string, unknown>[] = [];
  /** M15: route ids relay.set reports as failed (port in use). */
  readonly relayFail = new Set<string>();

  constructor(private readonly o: SimAgentOptions) {
    this.containers = (o.containers ?? []).map((c) => ({ ...c }));
    this.listeningPorts = (
      o.listeningPorts ?? [
        { proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd' },
        { proto: 'tcp', address: '127.0.0.1', port: 8123, process: 'python3' },
      ]
    ).map((p) => ({ ...p }));
    this.storage = o.storage;
  }

  container(name: string): SimContainer | undefined {
    return this.containers.find((c) => c.name === name);
  }

  /** Connects, sends hello and waits for welcome. */
  async connect(): Promise<void> {
    const ws = new WebSocket(this.o.url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const fail = (err: unknown): void =>
        reject(err instanceof Error ? err : new Error(String(err)));
      ws.once('error', fail);
      ws.once('close', (code) => fail(new Error(`closed before welcome: ${code}`)));
      ws.once('open', () => {
        this.send({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          name: this.o.name,
          version: '0.0.0-e2e',
          arch: 'x64',
          os: 'Debian GNU/Linux 12 (bookworm)',
          token: this.agentToken ?? this.o.token,
          capabilities: {
            terminal: !!this.o.terminal,
            docker: this.o.containers !== undefined,
            relay: !!this.o.relay,
          },
        });
      });
      ws.on('message', (raw) => {
        let msg: Msg;
        try {
          msg = JSON.parse(String(raw)) as Msg;
        } catch {
          return;
        }
        this.received.push(msg);
        if (msg.type === 'enrolled') {
          this.agentToken = String(msg.agentToken);
          this.serverId = String(msg.serverId);
        } else if (msg.type === 'welcome') {
          this.serverId = String(msg.serverId);
          ws.removeAllListeners('error');
          ws.removeAllListeners('close');
          resolve();
        } else if (msg.type === 'reject') {
          fail(new Error(`rejected: ${String(msg.code)}`));
        } else if (msg.type === 'ping') {
          this.send({ type: 'pong', ts: new Date().toISOString() });
        } else if (msg.type === 'rpc') {
          this.answer(msg);
        } else if (msg.type === 'stream.cancel') {
          this.endStream(String(msg.streamId), null);
          this.ptys.delete(String(msg.streamId));
          this.cancelTransfer(String(msg.streamId));
        } else if (msg.type.startsWith('transfer.')) {
          this.onTransfer(msg);
        }
      });
    });
    this.sendMetrics();
    this.sendInventory();
    this.timer = setInterval(() => this.sendMetrics(), this.o.metricsEveryMs ?? 5000);
  }

  /** The shell exits (like `exit` in bash): stream.end with the exit code. */
  ptyExit(code = 0): void {
    for (const id of [...this.ptys.keys()]) {
      this.ptys.delete(id);
      this.send({ type: 'stream.end', streamId: id, code });
    }
  }

  private ptyOut(id: string, chunk: string): void {
    this.send({ type: 'stream.data', streamId: id, channel: 'stdout', chunk });
  }

  private prompt(): string {
    return `admin@${this.o.name}:~$ `;
  }

  /** pty.* RPCs; false when the action is not one of them. */
  private answerPty(id: string, action: string, params: Record<string, unknown>): boolean {
    if (!action.startsWith('pty.')) return false;
    const fail = (code: string): true => {
      this.send({ type: 'rpc.result', id, ok: false, error: { code, message: code } });
      return true;
    };
    if (!this.o.terminal) return fail('terminal_disabled');
    if (action === 'pty.open') {
      const cols = Number(params.cols);
      const rows = Number(params.rows);
      this.ptySizes.push({ cols, rows });
      this.ptys.set(id, { streamId: id, cols, rows, line: '' });
      this.send({ type: 'rpc.result', id, ok: true, data: { streamId: id } });
      this.ptyOut(id, `Simulierte Shell auf ${this.o.name}\r\n${this.prompt()}`);
      return true;
    }
    const pty = this.ptys.get(String(params.streamId));
    if (!pty) return fail('not_found');
    if (action === 'pty.input') {
      const data = String(params.data ?? '');
      this.ptyInput += data;
      let out = '';
      for (const ch of data) {
        if (ch === '\r') {
          out += `\r\n${pty.line ? `echo: ${pty.line}\r\n` : ''}${this.prompt()}`;
          pty.line = '';
        } else {
          pty.line += ch;
          out += ch;
        }
      }
      this.send({ type: 'rpc.result', id, ok: true, data: {} });
      if (out) this.ptyOut(pty.streamId, out);
      return true;
    }
    if (action === 'pty.resize') {
      pty.cols = Number(params.cols);
      pty.rows = Number(params.rows);
      this.ptySizes.push({ cols: pty.cols, rows: pty.rows });
      this.send({ type: 'rpc.result', id, ok: true, data: {} });
      return true;
    }
    if (action === 'pty.close') {
      this.ptys.delete(pty.streamId);
      this.send({ type: 'rpc.result', id, ok: true, data: {} });
      this.send({ type: 'stream.end', streamId: pty.streamId, code: 0 });
      return true;
    }
    return fail('not_allowed');
  }

  /** relay.set: ok per route unless its id is in relayFail; not_allowed without `relay`. */
  private answerRelay(id: string, params: Record<string, unknown>): void {
    if (!this.o.relay) {
      this.send({
        type: 'rpc.result',
        id,
        ok: false,
        error: { code: 'not_allowed', message: 'relay is disabled on this server' },
      });
      return;
    }
    const routes = Array.isArray(params.routes) ? (params.routes as Record<string, unknown>[]) : [];
    this.relayRoutes = routes.filter((r) => !this.relayFail.has(String(r.id)));
    this.send({
      type: 'rpc.result',
      id,
      ok: true,
      data: {
        routes: routes.map((r) =>
          this.relayFail.has(String(r.id))
            ? { id: String(r.id), ok: false, error: `Port ${String(r.listenPort)} ist belegt` }
            : { id: String(r.id), ok: true, error: null },
        ),
      },
    });
  }

  /** Simulates a stopped agent: socket gone, no more reports. */
  disconnect(): void {
    this.ptys.clear();
    for (const st of this.streams.values()) if (st.timer) clearInterval(st.timer);
    this.streams.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ws?.terminate();
    this.ws = null;
  }

  sendMetrics(): void {
    const o = this.o;
    this.send({
      type: 'metrics',
      ts: new Date().toISOString(),
      cpu: o.cpu ?? 23,
      load1: 0.4,
      ram: { usedBytes: o.ramUsed ?? 7.8 * GB, totalBytes: o.ramTotal ?? 16 * GB },
      swap: { usedBytes: 0.2 * GB, totalBytes: 2 * GB },
      disks: [
        {
          mount: '/',
          fs: 'ext4',
          usedBytes: o.diskUsed ?? 389 * GB,
          totalBytes: o.diskTotal ?? 480 * GB,
        },
      ],
      temp: o.temp === undefined ? 44.5 : o.temp,
      net: { rxBps: 1.2 * 1024 ** 2, txBps: 340 * 1024 },
      uptimeS: 12 * 86400 + 4 * 3600,
    });
  }

  sendInventory(): void {
    this.send({
      type: 'inventory',
      ts: new Date().toISOString(),
      system: {
        hostname: this.o.name,
        os: 'Debian GNU/Linux 12 (bookworm)',
        kernel: '6.1.0-28-amd64',
        arch: 'x64',
        cpuModel: 'Intel N100',
        cpuCores: SIM_CPU_CORES,
        tailscaleIp: this.o.tailscaleIp ?? '100.64.0.20',
      },
      containers: this.containers,
      updates: { total: 12, security: 3 },
      rebootRequired: true,
      sshFailed24h: 41,
      fail2banBanned: 2,
      listeningPorts: this.listeningPorts,
      ...(this.storage ? { storage: this.storage } : {}),
    });
  }

  /** M13: replaces inventory.storage and reports it in a fresh inventory. */
  setStorage(storage: Record<string, unknown>): void {
    this.storage = storage;
    this.sendInventory();
  }

  /** Pushes one log line to every open stream of the container (stdout or stderr). */
  logLine(name: string, text: string, channel: 'stdout' | 'stderr' = 'stdout'): void {
    const c = this.container(name);
    if (!c) return;
    for (const st of this.streams.values()) {
      if (st.dockerId === c.dockerId) {
        this.send({ type: 'stream.data', streamId: st.streamId, channel, chunk: `${text}\n` });
      }
    }
  }

  private startLogs(streamId: string, params: Record<string, unknown>): void {
    const c = this.containers.find((x) => x.dockerId === params.id || x.name === params.id);
    if (!c) {
      this.send({ type: 'stream.end', streamId, code: 1, error: 'no such container' });
      return;
    }
    const tail = typeof params.tail === 'number' ? params.tail : 500;
    const lines: string[] = [];
    for (let i = 0; i < Math.min(tail, 40); i++) {
      lines.push(`${c.name} boot step ${i + 1}: ok`);
    }
    if (lines.length) {
      this.send({
        type: 'stream.data',
        streamId,
        channel: 'stdout',
        chunk: lines.join('\n') + '\n',
      });
      this.send({
        type: 'stream.data',
        streamId,
        channel: 'stderr',
        chunk: `WARN ${c.name}: config file has no timezone, using UTC\n`,
      });
    }
    const st: LogStream = { streamId, dockerId: c.dockerId, timer: null, n: 0 };
    this.streams.set(streamId, st);
    if (params.follow === false || c.state !== 'running') {
      this.endStream(streamId, 0);
      return;
    }
    st.timer = setInterval(() => {
      st.n++;
      this.send({
        type: 'stream.data',
        streamId,
        channel: 'stdout',
        chunk: `${c.name} heartbeat ${st.n}\n`,
      });
    }, this.o.logEveryMs ?? 400);
  }

  /** code null: cancelled by the core, nothing is sent. */
  private endStream(streamId: string, code: number | null): void {
    const st = this.streams.get(streamId);
    if (!st) return;
    if (st.timer) clearInterval(st.timer);
    this.streams.delete(streamId);
    if (code !== null) this.send({ type: 'stream.end', streamId, code });
  }

  /** `docker logs -f` ends when the container stops or is recreated. */
  private endStreamsOf(dockerId: string): void {
    for (const st of [...this.streams.values()]) {
      if (st.dockerId === dockerId) this.endStream(st.streamId, 0);
    }
  }

  /** Applies a container action; returns false when the container is unknown. */
  private act(action: string, params: Record<string, unknown>): boolean {
    const now = new Date().toISOString();
    if (action.startsWith('compose.')) {
      const dir = params.dir;
      const list = this.containers.filter((c) => c.composeDir === dir);
      if (!list.length) return false;
      if (action === 'compose.up') {
        for (const c of list) this.recreate(c, now);
      }
      return true;
    }
    const c = this.containers.find((x) => x.dockerId === params.id || x.name === params.id);
    if (!c) return false;
    if (action === 'container.stop') {
      this.endStreamsOf(c.dockerId);
      c.state = 'exited';
      c.exitCode = 0;
      c.statusText = 'Exited (0) 1 second ago';
      delete c.cpu;
      delete c.memBytes;
    } else if (action === 'container.start' || action === 'container.restart') {
      c.state = 'running';
      delete c.exitCode;
      c.startedAt = now;
      c.statusText = 'Up 1 second';
    } else if (action === 'container.update') {
      this.recreate(c, now);
    }
    return true;
  }

  /** Pull + recreate: new container id and image id, same name and config. */
  private recreate(c: SimContainer, now: string): void {
    this.endStreamsOf(c.dockerId);
    c.dockerId = hexId();
    c.imageId = imageId();
    c.state = 'running';
    delete c.exitCode;
    c.startedAt = now;
    c.statusText = 'Up 1 second';
  }

  private answer(msg: Msg): void {
    const id = String(msg.id);
    const action = String(msg.action);
    const params = (msg.params ?? {}) as Record<string, unknown>;
    this.rpcs.push({ action, params });
    if (action === 'container.logs') {
      this.startLogs(id, params);
      return;
    }
    if (this.answerPty(id, action, params)) return;
    if (action === 'relay.set') {
      this.answerRelay(id, params);
      return;
    }
    if (action === 'wol.send') {
      // M14: the real agent sends the magic packet; here it is only recorded in rpcs.
      this.send({ type: 'rpc.result', id, ok: true, data: { sent: true } });
      return;
    }
    if (this.o.games && this.answerGame(id, action, params)) return;
    if (action === 'container.limit') {
      this.answerLimit(id, params);
      return;
    }
    if (action.startsWith('container.') || action.startsWith('compose.')) {
      if (!this.act(action, params)) {
        this.send({
          type: 'rpc.result',
          id,
          ok: false,
          error: { code: 'not_found', message: 'no such container' },
        });
        return;
      }
      // The new state first, so the core answers the HTTP request with it.
      this.sendInventory();
      this.send({ type: 'rpc.result', id, ok: true, data: {} });
      return;
    }
    if (msg.action === 'system.cleanupPreview') {
      this.send({
        type: 'rpc.result',
        id,
        ok: true,
        data: {
          items: [
            { kind: 'apt-cache', bytes: 1.2 * GB },
            { kind: 'journal', bytes: 0.8 * GB },
            { kind: 'docker-images', bytes: 6.4 * GB, detail: '7 Images' },
          ],
          totalBytes: 8.4 * GB,
        },
      });
    } else if (msg.action === 'system.cleanup') {
      this.send({ type: 'rpc.result', id, ok: true, data: { freedBytes: 8.4 * GB } });
    } else {
      this.send({
        type: 'rpc.result',
        id,
        ok: false,
        error: { code: 'not_allowed', message: 'not simulated' },
      });
    }
  }

  /**
   * `docker update --cpus` (M10): refuses hz.role containers like the real agent,
   * caps at the CPU count, null removes the limit. Answers { cpus }.
   */
  private answerLimit(id: string, params: Record<string, unknown>): void {
    const c = this.containers.find((x) => x.dockerId === params.id || x.name === params.id);
    if (!c) {
      this.send({
        type: 'rpc.result',
        id,
        ok: false,
        error: { code: 'not_found', message: 'no such container' },
      });
      return;
    }
    if (c.role) {
      this.send({
        type: 'rpc.result',
        id,
        ok: false,
        error: { code: 'not_allowed', message: 'protected container' },
      });
      return;
    }
    const raw = params.cpus;
    const cpus =
      typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.min(raw, SIM_CPU_CORES)
        : null;
    c.cpuLimit = cpus;
    this.sendInventory();
    this.send({ type: 'rpc.result', id, ok: true, data: { cpus } });
  }

  /** Opens a port (like a new nginx on 0.0.0.0) and reports it in a fresh inventory. */
  listen(p: SimListeningPort): void {
    this.listeningPorts.push({ ...p });
    this.sendInventory();
  }

  /** game.export: accepted, a progress line, transfer.begin, chunks in the ack window. */
  private startExport(id: string, params: Record<string, unknown>): void {
    const gameId = String(params.gameId ?? '');
    let data = this.gameData.get(gameId);
    if (!data) {
      data = randomBytes(this.o.exportBytes ?? 100 * 1024);
      this.gameData.set(gameId, data);
    }
    const chunks = Math.max(1, Math.ceil(data.length / TRANSFER_CHUNK_BYTES));
    const ex: SimExport = { streamId: id, data, chunks, next: 0, acked: -1 };
    this.exports.set(id, ex);
    this.send({ type: 'rpc.result', id, ok: true, data: { streamId: id } });
    this.send({
      type: 'stream.data',
      streamId: id,
      channel: 'progress',
      chunk: `archive ${gameId}/data ${data.length} bytes\n`,
    });
    this.send({
      type: 'transfer.begin',
      streamId: id,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      chunks,
    });
    this.pumpExport(ex);
  }

  private pumpExport(ex: SimExport): void {
    while (ex.next < ex.chunks && ex.next - ex.acked <= TRANSFER_WINDOW) {
      const part = ex.data.subarray(
        ex.next * TRANSFER_CHUNK_BYTES,
        (ex.next + 1) * TRANSFER_CHUNK_BYTES,
      );
      this.send({
        type: 'transfer.chunk',
        streamId: ex.streamId,
        seq: ex.next,
        data: part.toString('base64'),
      });
      ex.next++;
    }
    if (ex.next === ex.chunks && ex.acked === ex.chunks - 1) {
      this.exports.delete(ex.streamId);
      this.send({
        type: 'transfer.end',
        streamId: ex.streamId,
        chunks: ex.chunks,
        bytes: ex.data.length,
        sha256: createHash('sha256').update(ex.data).digest('hex'),
      });
      this.send({ type: 'stream.end', streamId: ex.streamId, code: 0 });
    }
  }

  /** game.import: accepted, then the core sends the chunks. */
  private startImport(id: string, params: Record<string, unknown>): void {
    const gameId = String(params.gameId ?? '');
    // Like the real agent: refused when /opt/homelab/games/<gameId>/data exists.
    if (this.gameData.has(gameId)) {
      this.send({
        type: 'rpc.result',
        id,
        ok: false,
        error: { code: 'busy', message: 'data exists' },
      });
      return;
    }
    this.imports.set(id, {
      gameId,
      bytes: Number(params.bytes),
      sha256: String(params.sha256),
      chunks: Number(params.chunks),
      parts: [],
    });
    this.send({ type: 'rpc.result', id, ok: true, data: { streamId: id } });
  }

  private onTransfer(msg: Msg): void {
    const streamId = String(msg.streamId);
    if (msg.type === 'transfer.ack') {
      const ex = this.exports.get(streamId);
      if (!ex) return;
      ex.acked = Math.max(ex.acked, Number(msg.seq));
      this.pumpExport(ex);
      return;
    }
    const im = this.imports.get(streamId);
    if (!im) return;
    if (msg.type === 'transfer.chunk') {
      if (Number(msg.seq) !== im.parts.length) {
        this.failImport(streamId, 'sequence');
        return;
      }
      im.parts.push(Buffer.from(String(msg.data), 'base64'));
      this.send({ type: 'transfer.ack', streamId, seq: Number(msg.seq) });
    } else if (msg.type === 'transfer.end') {
      const data = Buffer.concat(im.parts);
      const sha = createHash('sha256').update(data).digest('hex');
      if (data.length !== im.bytes || sha !== im.sha256 || msg.sha256 !== sha) {
        this.failImport(streamId, 'checksum_mismatch');
        return;
      }
      this.imports.delete(streamId);
      this.gameData.set(im.gameId, data);
      const result = { bytes: data.length, sha256: sha, entries: 3 };
      this.send({
        type: 'stream.data',
        streamId,
        channel: 'progress',
        chunk: `extracted ${im.gameId}/data\nresult ${JSON.stringify(result)}\n`,
      });
      this.send({ type: 'stream.end', streamId, code: 0 });
    }
  }

  private failImport(streamId: string, error: string): void {
    this.imports.delete(streamId);
    this.send({ type: 'stream.end', streamId, code: 1, error });
  }

  private cancelTransfer(streamId: string): void {
    this.imports.delete(streamId);
    this.exports.delete(streamId);
  }

  /** Game server actions (only with `games`); false when the action is not one of them. */
  private answerGame(id: string, action: string, params: Record<string, unknown>): boolean {
    if (action === 'game.export') {
      this.startExport(id, params);
      return true;
    }
    if (action === 'game.import') {
      this.startImport(id, params);
      return true;
    }
    if (action === 'game.remove') {
      const gameDir = String(params.gameDir ?? '');
      const name = gameDir.split('/').pop() ?? '';
      this.containers = this.containers.filter((c) => c.composeDir !== gameDir);
      this.gameData.delete(name);
      this.sendInventory();
      this.send({ type: 'rpc.result', id, ok: true, data: {} });
      return true;
    }
    const dir = String(params.dir ?? params.gameDir ?? '');
    const name = dir.split('/').pop() ?? 'game';
    const list = this.containers.filter((c) => c.composeDir === dir);
    if (action === 'compose.write') {
      if (!list.length) {
        this.containers.push({
          dockerId: hexId(),
          name: `game-${name}`,
          image: 'itzg/minecraft-server:e2e',
          imageId: imageId(),
          composeProject: name,
          composeService: 'server',
          composeDir: dir,
          state: 'created',
          health: 'none',
          statusText: 'Created',
          ports: [],
        });
      }
      this.sendInventory();
      this.send({ type: 'rpc.result', id, ok: true, data: {} });
      return true;
    }
    if (action === 'compose.down' && list.length) {
      for (const c of list) {
        this.endStreamsOf(c.dockerId);
        c.state = 'exited';
        c.exitCode = 0;
        c.statusText = 'Exited (0) 1 second ago';
      }
      this.sendInventory();
      this.send({ type: 'rpc.result', id, ok: true, data: {} });
      return true;
    }
    if (action === 'game.status') {
      const up = list.some((c) => c.state === 'running');
      this.send({
        type: 'rpc.result',
        id,
        ok: true,
        data: {
          online: up,
          players: up ? { online: 1, max: 20, names: ['Lena'] } : null,
          version: '1.21.4',
          tps: up ? 19.9 : null,
        },
      });
      return true;
    }
    return false;
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

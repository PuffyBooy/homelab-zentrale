import { EventEmitter } from 'node:events';
import type { FastifyBaseLogger } from 'fastify';
import type WebSocket from 'ws';
import {
  AGENT_CLOSE,
  HELLO_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseAgentMessage,
  rpcParamsByAction,
  streamingActions,
  terminalActions,
  type AgentEvent,
  type AgentToCore,
  type CoreToAgent,
  type Hello,
  type Inventory,
  type Metrics,
  type RpcAction,
  type RpcErrorCode,
  type RpcParamsInput,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import type { ServerRow } from '../db/schema.js';
import type { AgentTokens } from './tokens.js';

/** What the hub reports to the rest of the core (implemented by ServerService). */
export interface AgentSink {
  /** After a successful hello (also after enrollment). */
  onConnected(server: ServerRow, hello: Hello, enrolled: boolean): void;
  onDisconnected(serverId: string): void;
  /** Any valid message from a connected agent. */
  onSeen(serverId: string): void;
  onMetrics(serverId: string, m: Metrics): void;
  onInventory(serverId: string, inv: Inventory): void;
  onEvent(serverId: string, ev: AgentEvent): void;
  /** Whether the admin allowed the terminal for this server. */
  terminalAllowed(serverId: string): boolean;
}

export type RpcFailure = RpcErrorCode | 'offline' | 'disconnected';

export class RpcError extends Error {
  constructor(
    public readonly code: RpcFailure,
    /** Agent message; may be shown to the admin, never contains secrets from the core. */
    public readonly detail = '',
  ) {
    super(code);
    this.name = 'RpcError';
  }
}

export interface HubOptions {
  helloTimeoutMs?: number;
  /** More invalid messages than this within `invalidWindowMs` closes the socket. */
  maxInvalid?: number;
  invalidWindowMs?: number;
  /** More messages than this within `rateWindowMs` closes the socket. */
  maxMessages?: number;
  rateWindowMs?: number;
  /** A connection without any frame (also pong) for this long is terminated. */
  staleAfterMs?: number;
  metricsIntervalS?: number;
  inventoryIntervalS?: number;
  defaultRpcTimeoutMs?: number;
}

const DEFAULTS: Required<HubOptions> = {
  helloTimeoutMs: HELLO_TIMEOUT_MS,
  maxInvalid: 20,
  invalidWindowMs: 60_000,
  maxMessages: 600,
  rateWindowMs: 60_000,
  staleAfterMs: 90_000,
  metricsIntervalS: 10,
  inventoryIntervalS: 60,
  defaultRpcTimeoutMs: 30_000,
};

export interface StreamChunk {
  channel: 'stdout' | 'stderr' | 'progress';
  chunk: string;
}
export interface StreamEndInfo {
  code: number;
  error?: string;
  /** Agent message of an rpc.result error for this stream (never contains core secrets). */
  detail?: string;
}

/**
 * Output of a streaming RPC (stream.data / stream.end with streamId = rpc id).
 * Usable as EventEmitter ('data', 'end') or with `for await`.
 */
export class RpcStream extends EventEmitter implements AsyncIterable<StreamChunk> {
  readonly done: Promise<StreamEndInfo>;
  /** Data of an `rpc.result ok` for this id, if the agent sends one (e.g. pty.open). */
  readonly result: Promise<unknown>;
  /** Upper bound for buffered chunks; the oldest are dropped beyond it. */
  static readonly MAX_QUEUE = 1024;
  private ended: StreamEndInfo | null = null;
  private readonly queue: StreamChunk[] = [];
  private iterating = false;
  private wake: (() => void) | null = null;
  private resolveDone!: (e: StreamEndInfo) => void;
  private resolveResult!: (v: unknown) => void;

  constructor(
    readonly id: string,
    private readonly onCancel: () => void,
  ) {
    super();
    this.done = new Promise((r) => (this.resolveDone = r));
    this.result = new Promise((r) => (this.resolveResult = r));
  }

  /** @internal */
  pushData(c: StreamChunk): void {
    if (this.ended) return;
    // Buffer only for the async iterator (or until a consumer attaches). Consumers that
    // only listen on 'data' would otherwise let the queue grow without bound.
    if (this.iterating || this.listenerCount('data') === 0) {
      this.queue.push(c);
      if (this.queue.length > RpcStream.MAX_QUEUE) this.queue.shift();
    }
    this.emit('data', c);
    this.wake?.();
  }

  /** @internal */
  pushResult(data: unknown): void {
    this.resolveResult(data);
  }

  /** @internal */
  finish(info: StreamEndInfo): void {
    if (this.ended) return;
    this.ended = info;
    this.resolveResult(undefined);
    this.resolveDone(info);
    this.emit('end', info);
    this.wake?.();
  }

  /** Number of buffered chunks (for tests). */
  get queued(): number {
    return this.queue.length;
  }

  get isEnded(): boolean {
    return this.ended !== null;
  }

  /** Asks the agent to stop the stream (stream.cancel). */
  cancel(): void {
    if (this.ended) return;
    this.onCancel();
    this.finish({ code: -1, error: 'cancelled' });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
    this.iterating = true;
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: RpcError): void;
  timer: NodeJS.Timeout;
}

interface Conn {
  ws: WebSocket;
  serverId: string;
  name: string;
  capabilities: Hello['capabilities'];
  connectedAt: number;
  lastFrame: number;
  pending: Map<string, Pending>;
  streams: Map<string, { stream: RpcStream; timer: NodeJS.Timeout | null }>;
}

interface Counter {
  times: number[];
}

function bump(c: Counter, now: number, windowMs: number): number {
  c.times = c.times.filter((t) => now - t < windowMs);
  c.times.push(now);
  return c.times.length;
}

/**
 * Agent hub: one WebSocket per server on /agent, authenticated by token in the
 * first message. Every frame is validated with the shared protocol schemas.
 */
export class AgentHub {
  private readonly conns = new Map<string, Conn>();
  private readonly disconnected = new Map<string, number>();
  private readonly opts: Required<HubOptions>;
  private closed = false;

  constructor(
    private readonly deps: {
      tokens: AgentTokens;
      sink: AgentSink;
      now: Clock;
      log: FastifyBaseLogger;
      options?: HubOptions;
    },
  ) {
    this.opts = { ...DEFAULTS, ...deps.options };
  }

  isConnected(serverId: string): boolean {
    return this.conns.has(serverId);
  }

  /** When the socket of this server closed (null while connected or never since boot). */
  disconnectedAt(serverId: string): number | null {
    return this.conns.has(serverId) ? null : (this.disconnected.get(serverId) ?? null);
  }

  connectedIds(): string[] {
    return [...this.conns.keys()];
  }

  capabilities(serverId: string): Hello['capabilities'] | null {
    return this.conns.get(serverId)?.capabilities ?? null;
  }

  /** Entry point for every new /agent socket. */
  handleSocket(ws: WebSocket, ip: string): void {
    const log = this.deps.log;
    if (this.closed) {
      ws.terminate();
      return;
    }
    let conn: Conn | null = null;
    const invalid: Counter = { times: [] };
    const rate: Counter = { times: [] };

    const helloTimer = setTimeout(() => {
      log.info({ ip }, 'agent hello timeout');
      ws.close(AGENT_CLOSE.HELLO_TIMEOUT, 'hello timeout');
    }, this.opts.helloTimeoutMs);

    const reject = (
      code: 'bad_token' | 'revoked' | 'protocol' | 'name_taken' | 'invalid',
    ): void => {
      clearTimeout(helloTimer);
      this.send(ws, { type: 'reject', code });
      ws.close(code === 'revoked' ? AGENT_CLOSE.REVOKED : AGENT_CLOSE.REJECTED, code);
    };

    ws.on('message', (data, isBinary) => {
      if (this.closed) return;
      const now = this.deps.now();
      if (bump(rate, now, this.opts.rateWindowMs) > this.opts.maxMessages) {
        log.warn({ ip, serverId: conn?.serverId }, 'agent message flood, closing');
        ws.close(AGENT_CLOSE.POLICY, 'too many messages');
        return;
      }
      if (conn) conn.lastFrame = now;
      const raw = isBinary ? null : rawText(data);
      const msg = raw === null ? null : parseAgentMessage(raw);

      if (!conn) {
        // Before the handshake only a valid hello is accepted.
        if (!msg || msg.type !== 'hello') {
          log.info({ ip }, 'agent sent no valid hello');
          reject('invalid');
          return;
        }
        if (msg.protocol !== PROTOCOL_VERSION) {
          reject('protocol');
          return;
        }
        const auth = this.deps.tokens.authenticate(msg);
        if (auth.kind === 'reject') {
          log.info({ ip, code: auth.code }, 'agent rejected');
          reject(auth.code);
          return;
        }
        clearTimeout(helloTimer);
        if (auth.kind === 'enrolled') {
          this.send(ws, {
            type: 'enrolled',
            agentToken: auth.agentToken,
            serverId: auth.server.id,
          });
        }
        conn = this.attach(ws, auth.server, msg, now);
        this.send(ws, {
          type: 'welcome',
          serverId: auth.server.id,
          protocol: PROTOCOL_VERSION,
          metricsIntervalS: this.opts.metricsIntervalS,
          inventoryIntervalS: this.opts.inventoryIntervalS,
        });
        log.info(
          {
            serverId: auth.server.id,
            name: auth.server.name,
            ip,
            enrolled: auth.kind === 'enrolled',
          },
          'agent connected',
        );
        this.deps.sink.onConnected(auth.server, msg, auth.kind === 'enrolled');
        return;
      }

      // A replaced, revoked or deleted connection is detached from the map but
      // may still deliver frames until the socket is gone: ignore them.
      if (this.conns.get(conn.serverId) !== conn) return;

      if (!msg || msg.type === 'hello') {
        const n = bump(invalid, now, this.opts.invalidWindowMs);
        log.debug({ serverId: conn.serverId, invalid: n }, 'invalid agent message dropped');
        if (n > this.opts.maxInvalid) {
          log.warn({ serverId: conn.serverId }, 'too many invalid agent messages, closing');
          ws.close(AGENT_CLOSE.POLICY, 'too many invalid messages');
        }
        return;
      }
      try {
        this.dispatch(conn, msg);
      } catch (err) {
        // A failing sink (e.g. a DB error) must never take the core down.
        log.error(
          {
            serverId: conn.serverId,
            type: msg.type,
            err: err instanceof Error ? err.name : 'error',
          },
          'agent message handling failed',
        );
      }
    });

    ws.on('pong', () => {
      if (conn) conn.lastFrame = this.deps.now();
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (conn && !this.closed) this.detach(conn);
    });
    ws.on('error', () => {
      // 'close' follows; never log the error object (it can carry frame data).
    });
  }

  private attach(ws: WebSocket, server: ServerRow, hello: Hello, now: number): Conn {
    const old = this.conns.get(server.id);
    if (old) {
      // A second connection of the same server replaces the old one.
      this.detach(old);
      old.ws.close(AGENT_CLOSE.REPLACED, 'replaced');
    }
    const conn: Conn = {
      ws,
      serverId: server.id,
      name: server.name,
      capabilities: hello.capabilities,
      connectedAt: now,
      lastFrame: now,
      pending: new Map(),
      streams: new Map(),
    };
    this.conns.set(server.id, conn);
    this.disconnected.delete(server.id);
    return conn;
  }

  private detach(conn: Conn): void {
    if (this.conns.get(conn.serverId) !== conn) return;
    this.conns.delete(conn.serverId);
    this.disconnected.set(conn.serverId, this.deps.now());
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError('disconnected'));
    }
    conn.pending.clear();
    for (const [, s] of conn.streams) {
      if (s.timer) clearTimeout(s.timer);
      s.stream.finish({ code: -1, error: 'disconnected' });
    }
    conn.streams.clear();
    this.deps.log.info({ serverId: conn.serverId, name: conn.name }, 'agent disconnected');
    this.deps.sink.onDisconnected(conn.serverId);
  }

  private dispatch(conn: Conn, msg: AgentToCore): void {
    const sink = this.deps.sink;
    sink.onSeen(conn.serverId);
    switch (msg.type) {
      case 'metrics':
        sink.onMetrics(conn.serverId, msg);
        return;
      case 'inventory':
        sink.onInventory(conn.serverId, msg);
        return;
      case 'event':
        sink.onEvent(conn.serverId, msg);
        return;
      case 'ping':
        this.send(conn.ws, { type: 'pong', ts: new Date(this.deps.now()).toISOString() });
        return;
      case 'pong':
      case 'hello':
        return;
      case 'rpc.result': {
        const p = conn.pending.get(msg.id);
        if (p) {
          conn.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.data);
          else p.reject(new RpcError(msg.error.code, msg.error.message));
          return;
        }
        const s = conn.streams.get(msg.id);
        if (s) {
          if (msg.ok) s.stream.pushResult(msg.data);
          else
            this.endStream(conn, msg.id, {
              code: -1,
              error: msg.error.code,
              detail: msg.error.message,
            });
        }
        // Late results (after a timeout) are ignored.
        return;
      }
      case 'stream.data':
        conn.streams.get(msg.streamId)?.stream.pushData({ channel: msg.channel, chunk: msg.chunk });
        return;
      case 'stream.end':
        this.endStream(conn, msg.streamId, {
          code: msg.code,
          ...(msg.error !== undefined ? { error: msg.error } : {}),
        });
        return;
    }
  }

  private endStream(conn: Conn, id: string, info: StreamEndInfo): void {
    const s = conn.streams.get(id);
    if (!s) return;
    conn.streams.delete(id);
    if (s.timer) clearTimeout(s.timer);
    s.stream.finish(info);
  }

  private send(ws: WebSocket, msg: CoreToAgent): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  /**
   * Validates action and params against the allowlist BEFORE anything is sent.
   * Throws RpcError('not_allowed' | 'invalid_params' | 'terminal_disabled' | 'offline').
   */
  private prepare<A extends RpcAction>(
    serverId: string,
    action: A,
    params: RpcParamsInput<A>,
  ): { conn: Conn; params: unknown } {
    if (typeof action !== 'string' || !Object.hasOwn(rpcParamsByAction, action)) {
      throw new RpcError('not_allowed');
    }
    const parsed = rpcParamsByAction[action].safeParse(params);
    if (!parsed.success) throw new RpcError('invalid_params');
    if (terminalActions.includes(action) && !this.deps.sink.terminalAllowed(serverId)) {
      throw new RpcError('terminal_disabled');
    }
    const conn = this.conns.get(serverId);
    if (!conn) throw new RpcError('offline');
    if (terminalActions.includes(action) && !conn.capabilities.terminal) {
      throw new RpcError('terminal_disabled');
    }
    return { conn, params: parsed.data };
  }

  /** Request/response RPC. Resolves with `rpc.result.data`. */
  call<A extends RpcAction>(
    serverId: string,
    action: A,
    params: RpcParamsInput<A>,
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    let prepared: { conn: Conn; params: unknown };
    try {
      if (streamingActions.includes(action)) throw new RpcError('invalid_params', 'use stream()');
      prepared = this.prepare(serverId, action, params);
    } catch (err) {
      return Promise.reject(err instanceof RpcError ? err : new RpcError('invalid_params'));
    }
    const { conn } = prepared;
    const id = randomToken(12);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new RpcError('timeout'));
      }, opts.timeoutMs ?? this.opts.defaultRpcTimeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      this.send(conn.ws, { type: 'rpc', id, action, params: prepared.params });
    });
  }

  /** Streaming RPC (container.logs, game.backup, deploy.run, pty.open). */
  stream<A extends RpcAction>(
    serverId: string,
    action: A,
    params: RpcParamsInput<A>,
    opts: { timeoutMs?: number } = {},
  ): RpcStream {
    if (!streamingActions.includes(action)) throw new RpcError('invalid_params', 'use call()');
    const { conn, params: p } = this.prepare(serverId, action, params);
    const id = randomToken(12);
    const stream = new RpcStream(id, () => {
      conn.streams.delete(id);
      this.send(conn.ws, { type: 'stream.cancel', streamId: id });
    });
    const timer =
      opts.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            this.send(conn.ws, { type: 'stream.cancel', streamId: id });
            this.endStream(conn, id, { code: -1, error: 'timeout' });
          }, opts.timeoutMs);
    conn.streams.set(id, { stream, timer });
    this.send(conn.ws, { type: 'rpc', id, action, params: p });
    return stream;
  }

  /** Disconnects a server at once (token revoked, server deleted). */
  disconnect(serverId: string, reason: 'revoked' | 'deleted'): void {
    const conn = this.conns.get(serverId);
    if (!conn) return;
    this.send(conn.ws, { type: 'reject', code: 'revoked' });
    this.detach(conn);
    conn.ws.close(AGENT_CLOSE.REVOKED, reason);
    // Do not wait for the close handshake of a misbehaving agent.
    const ws = conn.ws;
    setTimeout(() => ws.terminate(), 1000).unref();
  }

  /** Forget the disconnect time of a deleted server. */
  forget(serverId: string): void {
    this.disconnected.delete(serverId);
  }

  /** Sends WebSocket pings and terminates connections without any frame for too long. */
  heartbeat(): void {
    const now = this.deps.now();
    for (const conn of [...this.conns.values()]) {
      if (now - conn.lastFrame > this.opts.staleAfterMs) {
        this.deps.log.info({ serverId: conn.serverId }, 'agent connection stale, terminating');
        this.detach(conn);
        conn.ws.terminate();
        continue;
      }
      if (conn.ws.readyState === conn.ws.OPEN) conn.ws.ping();
    }
  }

  /** Core shutdown: closes every socket without calling the sink (the DB closes next). */
  shutdown(): void {
    this.closed = true;
    for (const conn of this.conns.values()) {
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new RpcError('disconnected'));
      }
      for (const s of conn.streams.values()) {
        if (s.timer) clearTimeout(s.timer);
        s.stream.finish({ code: -1, error: 'disconnected' });
      }
      conn.ws.terminate();
    }
    this.conns.clear();
  }
}

function rawText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

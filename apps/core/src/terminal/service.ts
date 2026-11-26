import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type WebSocket from 'ws';
import type { consoleSessionSchema } from '@hz/shared';
import {
  CONSOLE_IDLE_MINUTES,
  CONSOLE_INPUT_MAX_BYTES,
  CONSOLE_INPUT_MAX_MESSAGES,
  CONSOLE_INPUT_WINDOW_MS,
  CONSOLE_MAX_MINUTES,
  CONSOLE_MAX_PER_SERVER,
  LIVE_CLOSE_SESSION_ENDED,
  consoleClientMessageSchema,
  consoleCloseReasonSchema,
  consoleServerMessageSchema,
  ptyOpenDataSchema,
  type ConsoleClientMessage,
  type ConsoleCloseReason,
  type ConsoleServerMessage,
} from '@hz/shared';
import type { z } from 'zod';
import type { AgentHub, RpcStream, StreamEndInfo } from '../agents/hub.js';
import { RpcError } from '../agents/hub.js';
import type { SessionStore } from '../auth/sessions.js';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { consoleSessions, servers, sessions } from '../db/schema.js';

export type ConsoleSession = z.infer<typeof consoleSessionSchema>;

/**
 * Largest browser frame accepted: one input of 16 Ki chars, each JSON-escaped to at
 * most 6 chars (control characters as \u00XX), plus the envelope.
 */
export const CONSOLE_MAX_CLIENT_BYTES = 6 * 16 * 1024 + 1024;
const MAX_INVALID = 20;
/** Largest `pty.input` the agent protocol accepts (agent-protocol.ts). */
const PTY_INPUT_MAX_CHARS = 16 * 1024;
/** The agent answers `busy` while 8 RPCs run; input is retried, not dropped. */
const PTY_BUSY_RETRIES = 50;
const PTY_BUSY_RETRY_MS = 100;
/** Output kept while the agent has not confirmed pty.open yet. */
const MAX_PENDING_OUT_CHARS = 256 * 1024;
/** A browser that does not read its output is cut off beyond this. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export interface ConsoleOptions {
  /** Time for the agent to confirm pty.open. Default 10 s. */
  openTimeoutMs?: number;
  /** A socket without `open` is closed after this. Default 30 s. */
  helloTimeoutMs?: number;
}

type State = 'idle' | 'opening' | 'open' | 'closed';

interface Client {
  ws: WebSocket;
  /** Admin session (auth) this socket belongs to. */
  authSessionId: string;
  ip: string;
  serverId: string;
  state: State;
  connectedAt: number;
  /** console_sessions.id once `open` was accepted. */
  id: string | null;
  startedAt: number;
  lastInput: number;
  stream: RpcStream | null;
  openTimer: NodeJS.Timeout | null;
  pendingOut: string[];
  pendingChars: number;
  bytesIn: number;
  bytesOut: number;
  invalid: number;
  inputs: { t: number; bytes: number }[];
  /** Input not yet sent to the agent; sent in order, one call at a time. */
  inBuf: string;
  /** Latest size not yet sent (older sizes are dropped). */
  resizeTo: { cols: number; rows: number } | null;
  inFlight: boolean;
  busyRetries: number;
  retryTimer: NodeJS.Timeout | null;
}

const MIN = 60_000;

function reasonOfEnd(info: StreamEndInfo): { reason: ConsoleCloseReason; exitCode: number | null } {
  switch (info.error) {
    case undefined:
      return { reason: 'exit', exitCode: info.code };
    case 'idle_timeout':
    case 'max_duration':
    case 'terminal_disabled':
    case 'busy':
      return { reason: info.error, exitCode: null };
    case 'disconnected':
      return { reason: 'agent_offline', exitCode: null };
    default:
      return { reason: 'error', exitCode: null };
  }
}

function reasonOfRpcError(err: unknown): ConsoleCloseReason {
  if (err instanceof RpcError) {
    if (err.code === 'terminal_disabled') return 'terminal_disabled';
    if (err.code === 'offline' || err.code === 'disconnected') return 'agent_offline';
  }
  return 'error';
}

/**
 * Web console bridge (SPEC 11): browser socket <-> agent PTY. Every session is a
 * row in console_sessions (when, how long, how many bytes, from which IP) and two
 * audit entries. Keystrokes and output are passed through, never stored or logged.
 *
 * Opening needs: a step-up session, allowTerminal on the server, a connected agent
 * with the terminal capability and fewer than CONSOLE_MAX_PER_SERVER consoles on
 * that server. An open console closes after CONSOLE_IDLE_MINUTES without input,
 * after CONSOLE_MAX_MINUTES in total and as soon as its admin session ends.
 */
export class ConsoleService {
  private readonly clients = new Set<Client>();
  private readonly openTimeoutMs: number;
  private readonly helloTimeoutMs: number;

  constructor(
    private readonly deps: {
      db: Db;
      now: Clock;
      hub: AgentHub;
      sessions: SessionStore;
      terminalAllowed: (serverId: string) => boolean;
      log: FastifyBaseLogger;
      options?: ConsoleOptions;
    },
  ) {
    this.openTimeoutMs = deps.options?.openTimeoutMs ?? 10_000;
    this.helloTimeoutMs = deps.options?.helloTimeoutMs ?? 30_000;
    deps.sessions.onRevoke(() => this.checkSessions());
  }

  /** Sessions left open by a previous run of the core (crash, kill) are closed. */
  recover(): number {
    return this.deps.db
      .update(consoleSessions)
      .set({ endedAt: this.deps.now(), reason: 'error' })
      .where(isNull(consoleSessions.endedAt))
      .run().changes;
  }

  /** Open or opening consoles (all servers, or one). */
  activeCount(serverId?: string): number {
    let n = 0;
    for (const c of this.clients) {
      if ((c.state === 'opening' || c.state === 'open') && (!serverId || c.serverId === serverId))
        n += 1;
    }
    return n;
  }

  get size(): number {
    return this.clients.size;
  }

  handleSocket(ws: WebSocket, ctx: { authSessionId: string; ip: string; serverId: string }): void {
    const now = this.deps.now();
    const c: Client = {
      ws,
      authSessionId: ctx.authSessionId,
      ip: ctx.ip,
      serverId: ctx.serverId,
      state: 'idle',
      connectedAt: now,
      id: null,
      startedAt: now,
      lastInput: now,
      stream: null,
      openTimer: null,
      pendingOut: [],
      pendingChars: 0,
      bytesIn: 0,
      bytesOut: 0,
      invalid: 0,
      inputs: [],
      inBuf: '',
      resizeTo: null,
      inFlight: false,
      busyRetries: 0,
      retryTimer: null,
    };
    this.clients.add(c);
    ws.on('message', (data, isBinary) => this.onMessage(c, data, isBinary));
    ws.on('close', () => this.finish(c, 'closed', null));
    ws.on('error', () => undefined);
    // Refuse early, so the page can show why without sending `open` first.
    const refused = this.refusal(c);
    if (refused) this.finish(c, refused, null);
  }

  private onMessage(c: Client, data: WebSocket.RawData, isBinary: boolean): void {
    if (c.state === 'closed') return;
    const raw = isBinary ? null : rawText(data);
    if (raw === null || raw.length > CONSOLE_MAX_CLIENT_BYTES) return this.invalid(c);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.invalid(c);
    }
    const parsed = consoleClientMessageSchema.safeParse(json);
    if (!parsed.success) return this.invalid(c);
    this.dispatch(c, parsed.data);
  }

  private dispatch(c: Client, msg: ConsoleClientMessage): void {
    switch (msg.type) {
      case 'ping':
        this.send(c, { type: 'pong' });
        return;
      case 'open':
        // One console per socket: a second `open` is a protocol error.
        if (c.state !== 'idle') return this.invalid(c);
        this.open(c, msg.cols, msg.rows);
        return;
      case 'input':
        if (c.state !== 'open' || !c.stream) return this.invalid(c);
        this.input(c, msg.data);
        return;
      case 'resize':
        if (c.state !== 'open' || !c.stream) return this.invalid(c);
        // Coalesced: only the latest size is sent once the previous call is done.
        c.resizeTo = { cols: msg.cols, rows: msg.rows };
        this.pump(c);
        return;
      case 'close':
        this.finish(c, 'closed', null);
        return;
    }
  }

  private invalid(c: Client): void {
    c.invalid += 1;
    if (c.invalid > MAX_INVALID) this.finish(c, 'error', null);
  }

  /** Why this socket may not open a console now, or null. */
  private refusal(c: Client): ConsoleCloseReason | null {
    const now = this.deps.now();
    const s = this.deps.db
      .select({ stepUpUntil: sessions.stepUpUntil, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, c.authSessionId))
      .get();
    if (!s || s.expiresAt <= now) return 'closed';
    if (s.stepUpUntil === null || s.stepUpUntil <= now) return 'step_up_required';
    if (!this.deps.terminalAllowed(c.serverId)) return 'not_allowed';
    if (!this.deps.hub.isConnected(c.serverId)) return 'agent_offline';
    if (!this.deps.hub.capabilities(c.serverId)?.terminal) return 'terminal_disabled';
    if (this.activeCount(c.serverId) >= CONSOLE_MAX_PER_SERVER) return 'busy';
    return null;
  }

  private open(c: Client, cols: number, rows: number): void {
    const refused = this.refusal(c);
    if (refused) return this.finish(c, refused, null);
    let stream: RpcStream;
    try {
      stream = this.deps.hub.stream(c.serverId, 'pty.open', { cols, rows });
    } catch (err) {
      return this.finish(c, reasonOfRpcError(err), null);
    }
    const now = this.deps.now();
    c.state = 'opening';
    c.stream = stream;
    c.id = randomToken(16);
    c.startedAt = now;
    c.lastInput = now;
    this.deps.db
      .insert(consoleSessions)
      .values({ id: c.id, serverId: c.serverId, startedAt: now, ip: c.ip.slice(0, 64) })
      .run();
    writeAudit(this.deps.db, now, {
      actor: 'admin',
      action: 'console.open',
      target: c.serverId,
      details: { console: c.id, ip: c.ip, session: c.authSessionId },
    });
    this.deps.log.info({ serverId: c.serverId, console: c.id }, 'console opened');

    stream.on('data', (chunk: { chunk: string }) => this.output(c, chunk.chunk));
    stream.on('end', (info: StreamEndInfo) => {
      const r = reasonOfEnd(info);
      this.finish(c, r.reason, r.exitCode, false);
    });
    c.openTimer = setTimeout(() => {
      if (c.state === 'opening') this.finish(c, 'error', null);
    }, this.openTimeoutMs);
    void stream.result.then((data) => {
      if (c.state !== 'opening' || !c.id) return;
      if (c.openTimer) clearTimeout(c.openTimer);
      c.openTimer = null;
      if (!ptyOpenDataSchema.safeParse(data).success) return this.finish(c, 'error', null);
      c.state = 'open';
      this.send(c, { type: 'ready', sessionId: c.id });
      const pending = c.pendingOut;
      c.pendingOut = [];
      c.pendingChars = 0;
      for (const chunk of pending) this.output(c, chunk);
    });
  }

  private output(c: Client, chunk: string): void {
    if (chunk === '') return;
    if (c.state === 'opening') {
      c.pendingOut.push(chunk);
      c.pendingChars += chunk.length;
      while (c.pendingChars > MAX_PENDING_OUT_CHARS && c.pendingOut.length > 1) {
        c.pendingChars -= c.pendingOut.shift()?.length ?? 0;
      }
      return;
    }
    if (c.state !== 'open') return;
    if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) return this.finish(c, 'error', null);
    c.bytesOut += Buffer.byteLength(chunk, 'utf8');
    this.send(c, { type: 'output', data: chunk });
  }

  private input(c: Client, data: string): void {
    const now = this.deps.now();
    const bytes = Buffer.byteLength(data, 'utf8');
    c.inputs = c.inputs.filter((x) => now - x.t < CONSOLE_INPUT_WINDOW_MS);
    c.inputs.push({ t: now, bytes });
    const total = c.inputs.reduce((a, x) => a + x.bytes, 0);
    if (c.inputs.length > CONSOLE_INPUT_MAX_MESSAGES || total > CONSOLE_INPUT_MAX_BYTES) {
      return this.finish(c, 'rate_limited', null);
    }
    c.bytesIn += bytes;
    c.lastInput = now;
    if (c.stream) {
      c.inBuf += data;
      this.pump(c);
    }
  }

  /**
   * Sends buffered input (and the latest resize) to the agent, one call at a
   * time and in order. Keystrokes typed while a call runs are joined into the
   * next one, so key repeat in vim does not become one RPC per key. Input is
   * never dropped silently: the agent's parallel limit (`busy`) is retried,
   * any other failure ends the console with `error`.
   */
  private pump(c: Client): void {
    if (c.inFlight || c.retryTimer || c.state !== 'open' || !c.stream) return;
    const streamId = c.stream.id;
    let call: Promise<unknown>;
    let sent = '';
    if (c.inBuf !== '') {
      let n = Math.min(c.inBuf.length, PTY_INPUT_MAX_CHARS);
      // Never split a surrogate pair between two calls.
      const last = c.inBuf.charCodeAt(n - 1);
      if (n < c.inBuf.length && last >= 0xd800 && last <= 0xdbff) n -= 1;
      sent = c.inBuf.slice(0, n);
      c.inBuf = c.inBuf.slice(n);
      call = this.deps.hub.call(c.serverId, 'pty.input', { streamId, data: sent });
    } else if (c.resizeTo) {
      const size = c.resizeTo;
      c.resizeTo = null;
      call = this.deps.hub.call(c.serverId, 'pty.resize', { streamId, ...size });
    } else {
      return;
    }
    c.inFlight = true;
    call.then(
      () => {
        c.inFlight = false;
        c.busyRetries = 0;
        this.pump(c);
      },
      (err: unknown) => {
        c.inFlight = false;
        if (c.state !== 'open') return;
        if (err instanceof RpcError && err.code === 'busy' && c.busyRetries < PTY_BUSY_RETRIES) {
          c.busyRetries += 1;
          c.inBuf = sent + c.inBuf;
          c.retryTimer = setTimeout(() => {
            c.retryTimer = null;
            this.pump(c);
          }, PTY_BUSY_RETRY_MS);
          return;
        }
        this.finish(c, 'error', null);
      },
    );
  }

  /** Fire and forget (pty.close while ending). */
  private agentCall(p: Promise<unknown>): void {
    p.catch(() => undefined);
  }

  /**
   * Ends a socket once: hangs up the PTY (unless the agent ended it), writes the
   * log row and the audit entry, tells the browser why and closes the socket.
   */
  private finish(
    c: Client,
    reason: ConsoleCloseReason,
    exitCode: number | null,
    hangUp = true,
    closeCode = 1000,
  ): void {
    if (c.state === 'closed') return;
    c.state = 'closed';
    this.clients.delete(c);
    if (c.openTimer) clearTimeout(c.openTimer);
    c.openTimer = null;
    if (c.retryTimer) clearTimeout(c.retryTimer);
    c.retryTimer = null;
    c.inBuf = '';
    const stream = c.stream;
    if (stream && hangUp && !stream.isEnded) {
      this.agentCall(this.deps.hub.call(c.serverId, 'pty.close', { streamId: stream.id }));
      stream.cancel();
    }
    if (c.id) {
      const now = this.deps.now();
      const durationSec = Math.max(0, Math.round((now - c.startedAt) / 1000));
      this.deps.db
        .update(consoleSessions)
        .set({ endedAt: now, reason, bytesIn: c.bytesIn, bytesOut: c.bytesOut })
        .where(and(eq(consoleSessions.id, c.id), isNull(consoleSessions.endedAt)))
        .run();
      writeAudit(this.deps.db, now, {
        actor: 'admin',
        action: 'console.close',
        target: c.serverId,
        details: { console: c.id, reason, durationSec, bytesIn: c.bytesIn, bytesOut: c.bytesOut },
      });
      this.deps.log.info(
        { serverId: c.serverId, console: c.id, reason, durationSec },
        'console closed',
      );
    }
    this.send(c, { type: 'closed', reason, exitCode });
    if (c.ws.readyState === c.ws.OPEN || c.ws.readyState === c.ws.CONNECTING) {
      c.ws.close(closeCode, reason);
    }
  }

  private send(c: Client, msg: ConsoleServerMessage): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    // Validate outgoing frames too (both directions go through the shared schema).
    const parsed = consoleServerMessageSchema.safeParse(msg);
    if (!parsed.success) return;
    c.ws.send(JSON.stringify(parsed.data));
  }

  /** Closes consoles whose admin session was revoked or expired. */
  checkSessions(): void {
    if (this.clients.size === 0) return;
    const alive = this.deps.sessions.alive([...this.clients].map((c) => c.authSessionId));
    for (const c of [...this.clients]) {
      if (!alive.has(c.authSessionId)) {
        this.finish(c, 'closed', null, true, LIVE_CLOSE_SESSION_ENDED);
      }
    }
  }

  /** Scheduler (every 5 s): idle and total limits, revoked sessions, lost permission. */
  check(): void {
    if (this.clients.size === 0) return;
    const now = this.deps.now();
    this.checkSessions();
    for (const c of [...this.clients]) {
      if (c.state === 'idle') {
        if (now - c.connectedAt >= this.helloTimeoutMs) this.finish(c, 'idle_timeout', null);
        continue;
      }
      if (c.state !== 'open' && c.state !== 'opening') continue;
      if (!this.deps.terminalAllowed(c.serverId)) this.finish(c, 'not_allowed', null);
      else if (now - c.startedAt >= CONSOLE_MAX_MINUTES * MIN) this.finish(c, 'max_duration', null);
      else if (now - c.lastInput >= CONSOLE_IDLE_MINUTES * MIN)
        this.finish(c, 'idle_timeout', null);
    }
  }

  /** Core shutdown. */
  closeAll(): void {
    for (const c of [...this.clients]) this.finish(c, 'error', null, true, 1001);
  }

  list(q: { serverId?: string | undefined; limit: number }): ConsoleSession[] {
    const rows = this.deps.db
      .select({ s: consoleSessions, name: servers.name })
      .from(consoleSessions)
      .innerJoin(servers, eq(servers.id, consoleSessions.serverId))
      .where(q.serverId ? eq(consoleSessions.serverId, q.serverId) : undefined)
      .orderBy(desc(consoleSessions.startedAt), desc(consoleSessions.id))
      .limit(q.limit)
      .all();
    return rows.map(({ s, name }) => ({
      id: s.id,
      serverId: s.serverId,
      serverName: name,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: s.endedAt === null ? null : new Date(s.endedAt).toISOString(),
      durationSec:
        s.endedAt === null ? null : Math.max(0, Math.round((s.endedAt - s.startedAt) / 1000)),
      reason: consoleCloseReasonSchema.safeParse(s.reason).data ?? null,
      ip: s.ip,
      bytesIn: s.bytesIn,
      bytesOut: s.bytesOut,
    }));
  }
}

function rawText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

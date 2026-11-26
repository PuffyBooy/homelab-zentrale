import WebSocket, { type ClientOptions } from 'ws';
import { z } from 'zod';
import { DiscordRestError, type DiscordRest } from './rest.js';

/** Largest gateway frame accepted (we ask for no compression and intents 0). */
export const GATEWAY_MAX_PAYLOAD = 1024 * 1024;
export const GATEWAY_VERSION = 10;

/**
 * Why the gateway is down. `auth_invalid` (close 4004 or REST 401) and
 * `fatal` (4010-4014: shards, API version, intents) stop all retries until the
 * settings change; the others are retried with backoff.
 */
export type GatewayDownReason = 'auth_invalid' | 'fatal' | 'bad_url' | 'unreachable' | 'closed';

export interface GatewayReadyInfo {
  /** "Name" or "Name#1234" (legacy discriminator). */
  userName: string;
  applicationId: string | null;
}

export interface GatewayEvents {
  connecting(): void;
  ready(info: GatewayReadyInfo): void;
  resumed(): void;
  /** Raw `d` of INTERACTION_CREATE (validated by the caller). */
  interaction(d: unknown): void;
  down(reason: GatewayDownReason, willRetry: boolean): void;
}

export type WsFactory = (url: string, opts: ClientOptions) => WebSocket;

export interface GatewayOptions {
  /** Reconnect backoff: random in [ceiling/2, ceiling], ceiling base * 2^n up to max. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Until READY/RESUMED after the socket opened. Default 30 s. */
  readyTimeoutMs?: number;
  maxPayloadBytes?: number;
  /** Random source in [0, 1) (heartbeat jitter, backoff). */
  random?: () => number;
}

const D = {
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  readyTimeoutMs: 30_000,
  maxPayloadBytes: GATEWAY_MAX_PAYLOAD,
  random: Math.random,
} satisfies Required<GatewayOptions>;

/** Close codes after which retrying cannot help (docs: gateway close event codes). */
const FATAL_CLOSE = new Set([4010, 4011, 4012, 4013, 4014]);
/** Close codes after which the session cannot be resumed. */
const NEW_SESSION_CLOSE = new Set([4007, 4009]);

/** Exponential backoff with jitter (like apps/agent backoff.ts). */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const n = Math.max(0, Math.min(Math.floor(attempt), 30));
  const ceiling = Math.min(maxMs, baseMs * 2 ** n);
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(Math.max(baseMs, ceiling * (0.5 + r * 0.5)));
}

/**
 * Only `wss://<host>.discord.gg` without credentials or port is accepted as a
 * gateway URL (from GET /gateway/bot and READY's resume_gateway_url). Returns
 * the normalized base URL or null.
 */
export function checkGatewayUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'wss:') return null;
  if (u.username !== '' || u.password !== '' || u.port !== '') return null;
  if (!host.endsWith('.discord.gg') || !/^[a-z0-9.-]+$/.test(host)) return null;
  return `wss://${host}`;
}

export function gatewayConnectUrl(base: string): string {
  return `${base}/?v=${GATEWAY_VERSION}&encoding=json`;
}

const frameSchema = z.object({
  op: z.number().int(),
  d: z.unknown().optional(),
  s: z.number().int().nonnegative().nullable().optional(),
  t: z.string().max(64).nullable().optional(),
});
const helloSchema = z.object({ heartbeat_interval: z.number().int().min(1).max(600_000) });
const readySchema = z.object({
  session_id: z.string().min(1).max(128),
  resume_gateway_url: z.string().max(512).optional(),
  user: z.object({
    username: z.string().min(1).max(64),
    discriminator: z.string().max(8).optional(),
  }),
  application: z.object({ id: z.string().max(32) }).optional(),
});

/**
 * Discord Gateway client (outgoing WSS, so the hub needs no public endpoint):
 * HELLO and heartbeat with jitter, zombie detection (no HEARTBEAT_ACK),
 * IDENTIFY with intents 0, RESUME, op 7 reconnect, op 9 invalid session, close
 * codes and exponential backoff. The token is only sent in IDENTIFY/RESUME and
 * the REST header; it is never logged or put in an error.
 */
export class DiscordGateway {
  private readonly o: Required<GatewayOptions>;
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private gatewayUrl: string | null = null;
  private interval = 0;
  private acked = true;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private reason: GatewayDownReason | null = null;
  /** Bumped by stop(), so a connect waiting for REST cannot resurrect itself. */
  private gen = 0;

  constructor(
    private readonly token: string,
    private readonly rest: Pick<DiscordRest, 'gatewayUrl'>,
    private readonly events: GatewayEvents,
    private readonly wsFactory: WsFactory = (url, opts) => new WebSocket(url, opts),
    options: GatewayOptions = {},
  ) {
    this.o = { ...D, ...options };
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionId !== null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.gen += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown(true);
  }

  /** For tests: the session that a reconnect would resume. */
  get session(): { id: string | null; seq: number | null } {
    return { id: this.sessionId, seq: this.seq };
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const gen = this.gen;
    this.reason = null;
    this.events.connecting();
    let base: string;
    if (this.sessionId !== null && this.resumeUrl !== null) {
      base = this.resumeUrl;
    } else {
      this.sessionId = null;
      this.seq = null;
      if (this.gatewayUrl === null) {
        let raw: string;
        try {
          raw = await this.rest.gatewayUrl();
        } catch (err) {
          if (this.stopped || gen !== this.gen) return;
          const status = err instanceof DiscordRestError ? err.status : 0;
          if (status === 401) return this.down('auth_invalid');
          return this.down('unreachable');
        }
        if (this.stopped || gen !== this.gen) return;
        const checked = checkGatewayUrl(raw);
        if (checked === null) return this.down('bad_url');
        this.gatewayUrl = checked;
      }
      base = this.gatewayUrl;
    }
    let ws: WebSocket;
    try {
      ws = this.wsFactory(gatewayConnectUrl(base), {
        maxPayload: this.o.maxPayloadBytes,
        handshakeTimeout: this.o.readyTimeoutMs,
        perMessageDeflate: false,
        followRedirects: false,
      });
    } catch {
      return this.down('unreachable');
    }
    this.ws = ws;
    this.readyTimer = setTimeout(() => this.drop(ws, 'unreachable'), this.o.readyTimeoutMs);
    this.readyTimer.unref();
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      if (isBinary) return this.drop(ws, 'closed');
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        return this.drop(ws, 'closed');
      }
      this.handle(ws, json);
    });
    ws.on('error', () => {
      if (this.ws !== ws) return;
      this.reason ??= 'unreachable';
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.onClose(code);
    });
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload), () => undefined);
  }

  private handle(ws: WebSocket, raw: unknown): void {
    const f = frameSchema.safeParse(raw);
    if (!f.success) return;
    const { op, d, s, t } = f.data;
    if (typeof s === 'number') this.seq = s;
    switch (op) {
      case 10: {
        const h = helloSchema.safeParse(d);
        if (!h.success) return this.drop(ws, 'closed');
        this.interval = h.data.heartbeat_interval;
        this.acked = true;
        this.scheduleHeartbeat(ws, Math.floor(this.interval * this.o.random()));
        if (this.sessionId !== null && this.resumeUrl !== null) {
          this.send(ws, {
            op: 6,
            d: { token: this.token, session_id: this.sessionId, seq: this.seq },
          });
        } else {
          this.send(ws, {
            op: 2,
            d: {
              token: this.token,
              intents: 0,
              properties: { os: 'linux', browser: 'homelab-zentrale', device: 'homelab-zentrale' },
            },
          });
        }
        return;
      }
      case 11:
        this.acked = true;
        return;
      case 1:
        this.send(ws, { op: 1, d: this.seq });
        return;
      case 7:
        // Reconnect and resume.
        return this.drop(ws, 'closed');
      case 9:
        if (d !== true) {
          this.sessionId = null;
          this.seq = null;
          this.resumeUrl = null;
        }
        return this.drop(ws, 'closed');
      case 0:
        return this.dispatch(t ?? null, d);
      default:
        return;
    }
  }

  private dispatch(t: string | null, d: unknown): void {
    if (t === 'READY') {
      const r = readySchema.safeParse(d);
      if (!r.success) return;
      this.sessionId = r.data.session_id;
      const resume =
        r.data.resume_gateway_url === undefined ? null : checkGatewayUrl(r.data.resume_gateway_url);
      // A resume URL outside discord.gg is ignored: the next reconnect identifies anew.
      this.resumeUrl = resume;
      this.markUp();
      const disc = r.data.user.discriminator;
      this.events.ready({
        userName: disc && disc !== '0' ? `${r.data.user.username}#${disc}` : r.data.user.username,
        applicationId: r.data.application?.id ?? null,
      });
    } else if (t === 'RESUMED') {
      this.markUp();
      this.events.resumed();
    } else if (t === 'INTERACTION_CREATE') {
      this.events.interaction(d);
    }
  }

  private markUp(): void {
    this.attempt = 0;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private scheduleHeartbeat(ws: WebSocket, delay: number): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (this.ws !== ws) return;
      // No ACK for the last heartbeat: zombie connection, reconnect and resume.
      if (!this.acked) return this.drop(ws, 'closed');
      this.acked = false;
      this.send(ws, { op: 1, d: this.seq });
      this.scheduleHeartbeat(ws, this.interval);
    }, delay);
    this.heartbeatTimer.unref();
  }

  /** Ends the connection now; `close` then decides about the retry. */
  private drop(ws: WebSocket, reason: GatewayDownReason): void {
    if (this.ws !== ws) return;
    this.reason ??= reason;
    // terminate: a zombie would never finish the close handshake. The session
    // stays valid for RESUME (no 1000/1001 close).
    this.teardown(false);
    this.onClose(1006);
  }

  private onClose(code: number): void {
    this.teardown(false);
    if (this.stopped) return;
    if (code === 4004) {
      this.sessionId = null;
      return this.down('auth_invalid');
    }
    if (FATAL_CLOSE.has(code)) {
      this.sessionId = null;
      return this.down('fatal');
    }
    if (NEW_SESSION_CLOSE.has(code)) {
      this.sessionId = null;
      this.seq = null;
      this.resumeUrl = null;
    }
    this.down(this.reason ?? 'closed');
  }

  private teardown(closeNormal: boolean): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.heartbeatTimer = null;
    this.readyTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.removeAllListeners('message');
    ws.removeAllListeners('close');
    ws.on('error', () => undefined);
    if (closeNormal && ws.readyState === WebSocket.OPEN) ws.close(1000);
    else ws.terminate();
  }

  private down(reason: GatewayDownReason): void {
    if (this.stopped) return;
    const fatal = reason === 'auth_invalid' || reason === 'fatal' || reason === 'bad_url';
    this.events.down(reason, !fatal);
    if (fatal) {
      this.stopped = true;
      return;
    }
    const delay = backoffDelay(
      this.attempt,
      this.o.backoffBaseMs,
      this.o.backoffMaxMs,
      this.o.random,
    );
    this.attempt = Math.min(this.attempt + 1, 30);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref();
  }
}

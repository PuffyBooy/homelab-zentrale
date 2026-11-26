import WebSocket from 'ws';
import {
  haAreaListSchema,
  haAuthMessageSchema,
  haDeviceRegistryListSchema,
  haEntityDisplayListSchema,
  haEntityRegistryListSchema,
  haEventMessageSchema,
  haPongMessageSchema,
  haResultMessageSchema,
  haStateChangedEventSchema,
  haWebSocketUrl,
  parseHaState,
  type HaEntityState,
} from './protocol.js';

/**
 * Why the connection is down. The service turns this into a short German text;
 * nothing from the socket error (which could carry hosts or paths) goes further.
 */
export type HaDownReason =
  'auth_invalid' | 'unreachable' | 'timeout' | 'tls' | 'too_large' | 'protocol' | 'closed';

export class HaCallError extends Error {
  constructor(
    /** `timeout`, `busy` (too many pending), `disconnected`, `failed` (HA said no). */
    readonly kind: 'timeout' | 'busy' | 'disconnected' | 'failed',
    /** HA error code for `failed` (e.g. "not_found"), never the message text. */
    readonly haCode: string | null = null,
  ) {
    super(`ha_${kind}`);
    this.name = 'HaCallError';
  }
}

export interface HaClientOptions {
  /** TCP + WebSocket handshake + auth. Default 10 s. */
  connectTimeoutMs?: number;
  /** One command (get_states, call_service ...). Default 20 s. */
  requestTimeoutMs?: number;
  /** HA-level ping interval. Default 30 s. */
  pingIntervalMs?: number;
  /** No pong in time: the connection is dropped. Default 10 s. */
  pongTimeoutMs?: number;
  /** Largest frame accepted from HA (get_states of a big instance). Default 16 MiB. */
  maxPayloadBytes?: number;
  /** Commands waiting for a result at once. Default 64. */
  maxPending?: number;
  /** Reconnect backoff: base * 2^n, at most max. Defaults 1 s and 60 s. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** After "Token ungültig" retry this rarely (HA may ban IPs). Default 15 min. */
  authInvalidRetryMs?: number;
}

export interface HaSnapshot {
  haVersion: string | null;
  states: HaEntityState[];
  /** entity id -> area name (from the registries; empty if unavailable). */
  areas: Map<string, string>;
}

export interface HaClientEvents {
  /** A connection attempt starts. */
  connecting(): void;
  /** Authenticated, subscribed and loaded all states. */
  ready(snapshot: HaSnapshot): void;
  stateChanged(entityId: string, state: HaEntityState | null): void;
  down(reason: HaDownReason): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const D = {
  connectTimeoutMs: 10_000,
  requestTimeoutMs: 20_000,
  pingIntervalMs: 30_000,
  pongTimeoutMs: 10_000,
  maxPayloadBytes: 16 * 1024 * 1024,
  maxPending: 64,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  authInvalidRetryMs: 15 * 60_000,
} satisfies Required<HaClientOptions>;

const MAX_STATES = 20_000;

function socketReason(err: unknown): HaDownReason {
  const code =
    err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : '';
  const msg = err instanceof Error ? err.message : '';
  if (code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') return 'too_large';
  if (code === 'ETIMEDOUT' || /timed out/i.test(msg)) return 'timeout';
  if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(msg)) return 'tls';
  if (/Unexpected server response/i.test(msg)) return 'protocol';
  return 'unreachable';
}

function changedMs(s: HaEntityState): number | null {
  if (s.lastChanged === null) return null;
  const ms = Date.parse(s.lastChanged);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Lays the events buffered during the initial sync over the get_states snapshot.
 * Events received after the get_states result are newer and always win. Earlier
 * ones win only with a newer `last_changed` than the snapshot (the snapshot was
 * taken after them, so it normally already contains them).
 */
export function mergeBuffered(
  snapshot: Map<string, HaEntityState>,
  buffered: ReadonlyMap<string, { state: HaEntityState | null; afterStates: boolean }>,
): void {
  for (const [id, b] of buffered) {
    if (b.state === null) {
      if (b.afterStates) snapshot.delete(id);
      continue;
    }
    if (b.afterStates) {
      snapshot.set(id, b.state);
      continue;
    }
    // Not in the snapshot taken later: it was removed meanwhile.
    const cur = snapshot.get(id);
    if (!cur) continue;
    const a = changedMs(b.state);
    const c = changedMs(cur);
    if (a !== null && (c === null || a > c)) snapshot.set(id, b.state);
  }
}

/**
 * One connection to Home Assistant with reconnect (exponential backoff, at most
 * 60 s), HA-level ping/pong heartbeat, a frame size cap, a bounded pending map
 * and timeouts for every command. The token is sent once in the auth message and
 * never logged or put in an error.
 */
export class HaClient {
  private readonly o: Required<HaClientOptions>;
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private authed = false;
  private stopped = true;
  private attempt = 0;
  private nextId = 1;
  private stateSubId: number | null = null;
  /** Subscribed, states loaded and handed to `ready`. */
  private synced = false;
  /**
   * state_changed events received while the initial sync runs (latest per
   * entity, bounded); `afterStates` marks events that came after the get_states
   * result and are therefore newer than the snapshot.
   */
  private buffered = new Map<string, { state: HaEntityState | null; afterStates: boolean }>();
  private statesLoaded = false;
  private reason: HaDownReason | null = null;
  private readonly pending = new Map<number, Pending>();
  private connectTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    url: string,
    private readonly token: string,
    private readonly events: HaClientEvents,
    options: HaClientOptions = {},
  ) {
    this.o = { ...D, ...options };
    this.wsUrl = haWebSocketUrl(url);
  }

  get connected(): boolean {
    return this.authed && this.synced && this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown();
  }

  /** Sends one command and resolves with its `result` (rejects with HaCallError). */
  request(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.ws;
    if (!ws || !this.authed || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new HaCallError('disconnected'));
    }
    if (this.pending.size >= this.o.maxPending) return Promise.reject(new HaCallError('busy'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HaCallError('timeout'));
      }, this.o.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...payload, id, type }), (err) => {
        if (!err) return;
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        reject(new HaCallError('disconnected'));
      });
    });
  }

  /** Calls `<domain>.<service>` for exactly one entity. Callers pick from a fixed map. */
  callService(domain: string, service: string, entityId: string): Promise<unknown> {
    return this.request('call_service', { domain, service, target: { entity_id: entityId } });
  }

  // ---- connection --------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    this.reason = null;
    this.authed = false;
    this.stateSubId = null;
    this.synced = false;
    this.statesLoaded = false;
    this.buffered = new Map();
    this.events.connecting();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl, {
        maxPayload: this.o.maxPayloadBytes,
        handshakeTimeout: this.o.connectTimeoutMs,
        perMessageDeflate: false,
        followRedirects: false,
      });
    } catch {
      this.down('unreachable');
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => this.fail('timeout'), this.o.connectTimeoutMs);
    this.connectTimer.unref();
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      if (isBinary) return this.fail('protocol');
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        return this.fail('protocol');
      }
      for (const msg of Array.isArray(json) ? json : [json]) this.handle(ws, msg);
    });
    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      this.reason ??= socketReason(err);
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      if (code === 1009) this.reason ??= 'too_large';
      this.down(this.reason ?? (this.authed ? 'closed' : 'unreachable'));
    });
  }

  private handle(ws: WebSocket, msg: unknown): void {
    if (!this.authed) {
      const m = haAuthMessageSchema.safeParse(msg);
      if (!m.success) return this.fail('protocol');
      if (m.data.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
      } else if (m.data.type === 'auth_invalid') {
        this.fail('auth_invalid');
      } else {
        // The backoff is reset only once the sync is ready (see sync()), so an HA
        // that accepts the token but fails get_states does not cause a reconnect storm.
        this.authed = true;
        void this.sync(ws, m.data.ha_version ?? null);
      }
      return;
    }
    const type = msg && typeof msg === 'object' && 'type' in msg ? msg.type : undefined;
    if (type === 'result') {
      const r = haResultMessageSchema.safeParse(msg);
      if (!r.success) return;
      const p = this.pending.get(r.data.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(r.data.id);
      if (r.data.success) p.resolve(r.data.result);
      else p.reject(new HaCallError('failed', r.data.error?.code ?? null));
    } else if (type === 'pong') {
      const r = haPongMessageSchema.safeParse(msg);
      if (!r.success) return;
      const p = this.pending.get(r.data.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(r.data.id);
      p.resolve(null);
    } else if (type === 'event') {
      const e = haEventMessageSchema.safeParse(msg);
      if (!e.success || e.data.id !== this.stateSubId) return;
      const ev = haStateChangedEventSchema.safeParse(e.data.event);
      if (!ev.success) return;
      const next = ev.data.data.new_state;
      const entityId = ev.data.data.entity_id;
      const s = next === null || next === undefined ? null : parseHaState(next);
      if (s === null && next !== null && next !== undefined) return;
      if (!this.synced) {
        if (this.buffered.has(entityId) || this.buffered.size < MAX_STATES) {
          this.buffered.set(entityId, { state: s, afterStates: this.statesLoaded });
        }
        return;
      }
      this.events.stateChanged(s?.entityId ?? entityId, s);
    }
  }

  /**
   * subscribe state_changed first (no gap), then all states, then area names.
   * Events that arrive meanwhile are buffered and laid over the snapshot.
   */
  private async sync(ws: WebSocket, haVersion: string | null): Promise<void> {
    try {
      const subId = this.nextId;
      await this.request('subscribe_events', { event_type: 'state_changed' });
      if (this.ws !== ws) return;
      this.stateSubId = subId;
      const raw = await this.request('get_states');
      if (this.ws !== ws) return;
      if (!Array.isArray(raw)) return this.fail('protocol');
      this.statesLoaded = true;
      const byId = new Map<string, HaEntityState>();
      for (const r of raw.slice(0, MAX_STATES)) {
        const s = parseHaState(r);
        if (s) byId.set(s.entityId, s);
      }
      const areas = await this.areas();
      if (this.ws !== ws) return;
      mergeBuffered(byId, this.buffered);
      this.buffered = new Map();
      this.synced = true;
      this.attempt = 0;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.schedulePing(ws);
      this.events.ready({ haVersion, states: [...byId.values()].slice(0, MAX_STATES), areas });
    } catch (err) {
      if (this.ws !== ws) return;
      this.fail(err instanceof HaCallError && err.kind === 'timeout' ? 'timeout' : 'protocol');
    }
  }

  /** Area name per entity (entity area, else its device's area). Best effort. */
  private async areas(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try {
      const areaList = haAreaListSchema.safeParse(await this.request('config/area_registry/list'));
      if (!areaList.success || areaList.data.length === 0) return out;
      const names = new Map(areaList.data.map((a) => [a.area_id, a.name]));
      const devices = haDeviceRegistryListSchema.safeParse(
        await this.request('config/device_registry/list').catch(() => []),
      );
      const deviceArea = new Map<string, string>();
      if (devices.success) {
        for (const d of devices.data) if (d.area_id) deviceArea.set(d.id, d.area_id);
      }
      let entities: { id: string; area: string | null; device: string | null }[] = [];
      const display = haEntityDisplayListSchema.safeParse(
        await this.request('config/entity_registry/list_for_display').catch(() => null),
      );
      if (display.success) {
        entities = display.data.entities.map((e) => ({
          id: e.ei,
          area: e.ai ?? null,
          device: e.di ?? null,
        }));
      } else {
        const list = haEntityRegistryListSchema.safeParse(
          await this.request('config/entity_registry/list'),
        );
        if (list.success) {
          entities = list.data.map((e) => ({
            id: e.entity_id,
            area: e.area_id ?? null,
            device: e.device_id ?? null,
          }));
        }
      }
      for (const e of entities) {
        const areaId = e.area ?? (e.device ? deviceArea.get(e.device) : undefined);
        const name = areaId ? names.get(areaId) : undefined;
        if (name) out.set(e.id, name);
      }
    } catch {
      // Registries are optional (older HA, missing rights): no area names.
    }
    return out;
  }

  private schedulePing(ws: WebSocket): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      if (this.ws !== ws) return;
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.fail('timeout');
      }, this.o.pongTimeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: () => this.schedulePing(ws),
        reject: () => undefined,
        timer,
      });
      ws.send(JSON.stringify({ id, type: 'ping' }), () => undefined);
    }, this.o.pingIntervalMs);
    this.pingTimer.unref();
  }

  /** Ends the current connection with a reason; `close` then schedules the retry. */
  private fail(reason: HaDownReason): void {
    this.reason ??= reason;
    const ws = this.ws;
    if (!ws) return;
    ws.terminate();
  }

  private teardown(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.connectTimer = null;
    this.pingTimer = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new HaCallError('disconnected'));
    }
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    this.authed = false;
    this.stateSubId = null;
    this.synced = false;
    this.statesLoaded = false;
    this.buffered = new Map();
    if (ws) {
      ws.removeAllListeners('message');
      ws.on('error', () => undefined);
      ws.terminate();
    }
  }

  private down(reason: HaDownReason): void {
    this.teardown();
    if (this.stopped) return;
    this.events.down(reason);
    const delay =
      reason === 'auth_invalid'
        ? this.o.authInvalidRetryMs
        : Math.min(this.o.backoffBaseMs * 2 ** this.attempt, this.o.backoffMaxMs);
    this.attempt = Math.min(this.attempt + 1, 30);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref();
  }
}

import { and, gt, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type WebSocket from 'ws';
import {
  LIVE_CLOSE_SESSION_ENDED,
  liveClientMessageSchema,
  type Alert,
  type LiveServerMessage,
} from '@hz/shared';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import type { ServerService } from '../servers/service.js';

/** Max size of one client frame. Clients only send small subscribe messages. */
export const LIVE_MAX_CLIENT_BYTES = 16 * 1024;
const MAX_TOPICS_PER_SOCKET = 50;
const MAX_INVALID = 20;
const ALERT_SNAPSHOT_LIMIT = 100;

export interface LiveOptions {
  /** At most one update per topic in this interval (real time). Default 1000 ms. */
  throttleMs?: number;
  /** Appended items (log lines) go out at most this often per topic. Default 200 ms. */
  appendThrottleMs?: number;
}

/**
 * A family of topics served by another module (containers, container logs).
 * `open` runs when a topic gets its first subscriber, `close` when the last
 * one leaves (unsubscribe, socket closed, session ended).
 */
export interface TopicProvider {
  matches(topic: string): boolean;
  /** Snapshot data, or undefined if the topic does not exist. */
  snapshot(topic: string): unknown;
  /** Current item for an upsert, null if gone. */
  item?(topic: string, id: string): unknown;
  /** Checked before open(); defaults to `snapshot(topic) !== undefined`. */
  has?(topic: string): boolean;
  open?(topic: string): void;
  close?(topic: string): void;
}

interface Client {
  ws: WebSocket;
  sessionId: string;
  topics: Set<string>;
  invalid: number;
}

type Pending = Map<string, 'upsert' | 'remove'>;

/**
 * Browser live channel (/live). Topics `servers`, `server:<id>` and `alerts`,
 * plus the topics of registered providers (`containers`, `container-logs:<id>`):
 * a snapshot on subscribe, then throttled `update` messages with the full
 * changed items (upsert by id) or removed ids.
 */
export class LiveHub {
  private readonly clients = new Set<Client>();
  private readonly pending = new Map<string, Pending>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastFlush = new Map<string, number>();
  private readonly appended = new Map<string, unknown[]>();
  private readonly appendTimers = new Map<string, NodeJS.Timeout>();
  private readonly providers: TopicProvider[] = [];
  private readonly throttleMs: number;
  private readonly appendThrottleMs: number;

  constructor(
    private readonly deps: {
      db: Db;
      now: Clock;
      servers: ServerService;
      alerts: AlertService;
      log: FastifyBaseLogger;
      options?: LiveOptions;
    },
  ) {
    this.throttleMs = deps.options?.throttleMs ?? 1000;
    this.appendThrottleMs = deps.options?.appendThrottleMs ?? 200;
    deps.servers.onChange((id, deleted) => {
      this.mark('servers', id, deleted ? 'remove' : 'upsert');
      this.mark(`server:${id}`, id, deleted ? 'remove' : 'upsert');
    });
    deps.alerts.onChange((a) => this.mark('alerts', a.id, 'upsert'));
  }

  addProvider(p: TopicProvider): void {
    this.providers.push(p);
  }

  /** Topics of switched-off modules: no subscribe, no snapshot, no update. */
  private allowed: (topic: string) => boolean = () => true;

  setTopicFilter(fn: (topic: string) => boolean): void {
    this.allowed = fn;
  }

  private provider(topic: string): TopicProvider | undefined {
    return this.providers.find((p) => p.matches(topic));
  }

  get size(): number {
    return this.clients.size;
  }

  handleSocket(ws: WebSocket, sessionId: string): void {
    const client: Client = { ws, sessionId, topics: new Set(), invalid: 0 };
    this.clients.add(client);
    ws.on('message', (data, isBinary) => {
      const raw = isBinary ? null : String(data);
      if (raw === null || raw.length > LIVE_MAX_CLIENT_BYTES) {
        this.invalid(client);
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        this.invalid(client);
        return;
      }
      const parsed = liveClientMessageSchema.safeParse(json);
      if (!parsed.success) {
        this.invalid(client);
        return;
      }
      const msg = parsed.data;
      if (msg.type === 'ping') {
        this.send(client, { type: 'pong' });
      } else if (msg.type === 'subscribe') {
        for (const topic of msg.topics) this.subscribe(client, topic);
      } else {
        for (const topic of msg.topics) this.unsubscribe(client, topic);
      }
    });
    ws.on('close', () => this.drop(client));
    ws.on('error', () => undefined);
  }

  private invalid(client: Client): void {
    client.invalid += 1;
    this.send(client, { type: 'error', code: 'invalid' });
    if (client.invalid > MAX_INVALID) client.ws.close(1008, 'too many invalid messages');
  }

  private send(client: Client, msg: LiveServerMessage): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  }

  /** Snapshot data for a topic; undefined if unknown. */
  private snapshot(topic: string): unknown {
    const p = this.provider(topic);
    if (p) return p.snapshot(topic);
    if (topic === 'servers') return this.deps.servers.list();
    if (topic === 'alerts') {
      const active = this.deps.alerts.list({ state: 'active', limit: 500 });
      const recent = this.deps.alerts.list({ state: 'all', limit: ALERT_SNAPSHOT_LIMIT });
      const seen = new Set<string>();
      const out: Alert[] = [];
      for (const a of [...active, ...recent]) {
        if (!seen.has(a.id)) {
          seen.add(a.id);
          out.push(a);
        }
      }
      return out;
    }
    const m = /^server:([A-Za-z0-9_-]{1,64})$/.exec(topic);
    if (m?.[1]) return this.deps.servers.detail(m[1]) ?? undefined;
    return undefined;
  }

  private subscribe(client: Client, topic: string): void {
    if (!this.allowed(topic)) {
      this.send(client, { type: 'error', code: 'unknown_topic' });
      return;
    }
    if (!client.topics.has(topic) && client.topics.size >= MAX_TOPICS_PER_SOCKET) {
      this.send(client, { type: 'error', code: 'invalid' });
      return;
    }
    const p = this.provider(topic);
    if (p && !client.topics.has(topic)) {
      const exists = p.has ? p.has(topic) : p.snapshot(topic) !== undefined;
      if (!exists) {
        this.send(client, { type: 'error', code: 'unknown_topic' });
        return;
      }
      const first = !this.hasSubscribers(topic);
      client.topics.add(topic);
      if (first) p.open?.(topic);
    }
    const data = this.snapshot(topic);
    if (data === undefined) {
      if (p) this.unsubscribe(client, topic);
      this.send(client, { type: 'error', code: 'unknown_topic' });
      return;
    }
    client.topics.add(topic);
    this.send(client, { type: 'snapshot', topic, data });
  }

  private unsubscribe(client: Client, topic: string): void {
    if (!client.topics.delete(topic)) return;
    if (!this.hasSubscribers(topic)) this.provider(topic)?.close?.(topic);
  }

  /** Removes a client and closes the topics it was the last subscriber of. */
  private drop(client: Client): void {
    if (!this.clients.delete(client)) return;
    for (const topic of client.topics) {
      if (!this.hasSubscribers(topic)) this.provider(topic)?.close?.(topic);
    }
  }

  hasSubscribers(topic: string): boolean {
    for (const c of this.clients) if (c.topics.has(topic)) return true;
    return false;
  }

  /**
   * Appends items (log lines) to a topic; subscribers get them in order as
   * `upsert`, batched at most every appendThrottleMs.
   */
  append(topic: string, items: unknown[]): void {
    if (items.length === 0 || !this.allowed(topic) || !this.hasSubscribers(topic)) return;
    let list = this.appended.get(topic);
    if (!list) {
      list = [];
      this.appended.set(topic, list);
    }
    list.push(...items);
    if (this.appendTimers.has(topic)) return;
    const timer = setTimeout(() => this.flushAppended(topic), this.appendThrottleMs);
    timer.unref();
    this.appendTimers.set(topic, timer);
  }

  private flushAppended(topic: string): void {
    const t = this.appendTimers.get(topic);
    if (t) clearTimeout(t);
    this.appendTimers.delete(topic);
    const items = this.appended.get(topic);
    this.appended.delete(topic);
    if (!items || items.length === 0 || !this.allowed(topic)) return;
    const msg: LiveServerMessage = { type: 'update', topic, upsert: items };
    for (const c of this.clients) if (c.topics.has(topic)) this.send(c, msg);
  }

  /** Sends pending appends first, then a new snapshot to every subscriber. */
  resnapshot(topic: string): void {
    if (!this.allowed(topic)) return;
    this.flushAppended(topic);
    const data = this.snapshot(topic);
    if (data === undefined) return;
    for (const c of this.clients) {
      if (c.topics.has(topic)) this.send(c, { type: 'snapshot', topic, data });
    }
  }

  /** Records a change; the update goes out at most once per throttle interval. */
  mark(topic: string, id: string, op: 'upsert' | 'remove'): void {
    if (!this.allowed(topic) || !this.hasSubscribers(topic)) return;
    let p = this.pending.get(topic);
    if (!p) {
      p = new Map();
      this.pending.set(topic, p);
    }
    p.set(id, op);
    if (this.timers.has(topic)) return;
    const wait = Math.max(0, (this.lastFlush.get(topic) ?? 0) + this.throttleMs - Date.now());
    const timer = setTimeout(() => this.flush(topic), wait);
    timer.unref();
    this.timers.set(topic, timer);
  }

  /** Sends pending changes of a topic now (tests call this directly). */
  flush(topic: string): void {
    this.flushAppended(topic);
    const t = this.timers.get(topic);
    if (t) clearTimeout(t);
    this.timers.delete(topic);
    const p = this.pending.get(topic);
    this.pending.delete(topic);
    if (!p || p.size === 0 || !this.allowed(topic)) return;
    this.lastFlush.set(topic, Date.now());
    const upsert: unknown[] = [];
    const remove: string[] = [];
    for (const [id, op] of p) {
      // Items are read at flush time, so the newest state goes out.
      const item = op === 'remove' ? null : this.item(topic, id);
      if (item === null) remove.push(id);
      else upsert.push(item);
    }
    const msg: LiveServerMessage = {
      type: 'update',
      topic,
      ...(upsert.length > 0 ? { upsert } : {}),
      ...(remove.length > 0 ? { remove } : {}),
    };
    for (const c of this.clients) if (c.topics.has(topic)) this.send(c, msg);
  }

  flushAll(): void {
    for (const topic of new Set([...this.pending.keys(), ...this.appended.keys()])) {
      this.flush(topic);
    }
  }

  private item(topic: string, id: string): unknown {
    const p = this.provider(topic);
    if (p) return p.item ? p.item(topic, id) : null;
    if (topic === 'servers') return this.deps.servers.summary(id);
    if (topic === 'alerts') return this.deps.alerts.get(id);
    if (topic.startsWith('server:')) return this.deps.servers.detail(id);
    return null;
  }

  /** Closes sockets whose session was revoked or expired (scheduler, every 5 s). */
  checkSessions(): void {
    if (this.clients.size === 0) return;
    const ids = [...new Set([...this.clients].map((c) => c.sessionId))];
    const alive = new Set(
      this.deps.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(inArray(sessions.id, ids), gt(sessions.expiresAt, this.deps.now())))
        .all()
        .map((r) => r.id),
    );
    for (const c of [...this.clients]) {
      if (!alive.has(c.sessionId)) {
        this.drop(c);
        c.ws.close(LIVE_CLOSE_SESSION_ENDED, 'session ended');
      }
    }
  }

  closeAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const t of this.appendTimers.values()) clearTimeout(t);
    this.timers.clear();
    this.appendTimers.clear();
    this.appended.clear();
    for (const c of [...this.clients]) {
      this.drop(c);
      c.ws.terminate();
    }
  }
}

import {
  LIVE_CLOSE_SESSION_ENDED,
  alertSchema,
  checkSummarySchema,
  containerSummarySchema,
  logLineSchema,
  logSnapshotSchema,
  liveServerMessageSchema,
  liveTopicSchema,
  serverDetailSchema,
  serverSummarySchema,
  type Alert,
  type CheckSummary,
  type ContainerSummary,
  type LiveServerMessage,
  type LogLine,
  type ServerDetail,
  type ServerSummary,
} from '@hz/shared';
import type { QueryClient } from '@tanstack/react-query';
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { alertsAllKey, alertsKey, isActive } from './alerts.js';
import type { Schema } from './api.js';
import { checksKey } from './checks.js';
import { containersKey } from './containers.js';
import { appendLogLines, containerLogsKey, type LogBuffer } from './logs.js';
import { serverKey, serversKey } from './servers.js';

/**
 * Live channel to the core (docs/ARCHITECTURE.md, "Live-Daten zum Browser").
 * One WebSocket to /live on the same origin. Topics are reference counted; after a
 * reconnect every topic is subscribed again and the core answers with a fresh snapshot.
 * Every frame is checked with the zod schemas from @hz/shared and written into the
 * TanStack Query cache, so pages only read queries.
 */

export type LiveState = 'connecting' | 'open' | 'closed';

interface WithId {
  id: string;
}

/** Upsert by id, then remove. Keeps the order of existing items, appends new ones. */
export function mergeById<T extends WithId>(
  list: readonly T[] | undefined,
  upsert: readonly T[] = [],
  remove: readonly string[] = [],
): T[] {
  const out = [...(list ?? [])];
  for (const item of upsert) {
    const i = out.findIndex((x) => x.id === item.id);
    if (i === -1) out.push(item);
    else out[i] = item;
  }
  if (!remove.length) return out;
  const gone = new Set(remove);
  return out.filter((x) => !gone.has(x.id));
}

/** Validates each item on its own; invalid items are dropped and reported. */
function parseItems<T>(schema: Schema<T>, items: readonly unknown[]): { ok: T[]; bad: number } {
  const ok: T[] = [];
  let bad = 0;
  for (const raw of items) {
    try {
      ok.push(schema.parse(raw));
    } catch {
      bad++;
    }
  }
  return { ok, bad };
}

/** Snapshot data is the full list; accept a bare array or `{ <topic>: [...] }`. */
function snapshotList(data: unknown, field: string): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>)[field])) {
    return (data as Record<string, unknown[]>)[field] ?? null;
  }
  return null;
}

export interface ApplyResult {
  /** Alerts that arrived through an update (not the snapshot). */
  newAlerts: Alert[];
}

/**
 * Writes one validated live message into the query cache. Pure apart from the cache,
 * so it is unit tested without a socket. Invalid payloads never corrupt the cache:
 * the affected query is invalidated and refetched over REST instead.
 */
export function applyLiveMessage(qc: QueryClient, msg: LiveServerMessage): ApplyResult {
  const result: ApplyResult = { newAlerts: [] };
  if (msg.type !== 'snapshot' && msg.type !== 'update') return result;
  const { topic } = msg;

  if (topic === 'servers') {
    if (msg.type === 'snapshot') {
      const raw = snapshotList(msg.data, 'servers');
      const { ok, bad } = parseItems(serverSummarySchema, raw ?? []);
      if (!raw || bad) void qc.invalidateQueries({ queryKey: serversKey, exact: true });
      if (raw) qc.setQueryData<ServerSummary[]>(serversKey, ok);
      for (const s of ok) patchDetailSummary(qc, s);
    } else {
      const { ok, bad } = parseItems(serverSummarySchema, msg.upsert ?? []);
      if (bad) void qc.invalidateQueries({ queryKey: serversKey, exact: true });
      qc.setQueryData<ServerSummary[]>(serversKey, (old) => mergeById(old, ok, msg.remove));
      for (const s of ok) patchDetailSummary(qc, s);
      for (const id of msg.remove ?? []) qc.removeQueries({ queryKey: serverKey(id) });
    }
    return result;
  }

  if (topic === 'alerts') {
    void qc.invalidateQueries({ queryKey: alertsAllKey });
    if (msg.type === 'snapshot') {
      const raw = snapshotList(msg.data, 'alerts');
      const { ok, bad } = parseItems(alertSchema, raw ?? []);
      if (!raw || bad) void qc.invalidateQueries({ queryKey: alertsKey, exact: true });
      if (raw) qc.setQueryData<Alert[]>(alertsKey, ok.filter(isActive));
    } else {
      const { ok, bad } = parseItems(alertSchema, msg.upsert ?? []);
      if (bad) void qc.invalidateQueries({ queryKey: alertsKey, exact: true });
      const before = new Set((qc.getQueryData<Alert[]>(alertsKey) ?? []).map((a) => a.id));
      qc.setQueryData<Alert[]>(alertsKey, (old) => mergeById(old, ok, msg.remove).filter(isActive));
      result.newAlerts = ok.filter((a) => !before.has(a.id));
    }
    return result;
  }

  if (topic === 'containers') {
    if (msg.type === 'snapshot') {
      const raw = snapshotList(msg.data, 'containers');
      const { ok, bad } = parseItems(containerSummarySchema, raw ?? []);
      if (raw) qc.setQueryData<ContainerSummary[]>(containersKey, ok);
      // After the write, so the refetch flag is not reset by setQueryData.
      if (!raw || bad) void qc.invalidateQueries({ queryKey: containersKey, exact: true });
    } else {
      const { ok, bad } = parseItems(containerSummarySchema, msg.upsert ?? []);
      qc.setQueryData<ContainerSummary[]>(containersKey, (old) =>
        old ? mergeById(old, ok, msg.remove) : old,
      );
      if (bad) void qc.invalidateQueries({ queryKey: containersKey, exact: true });
    }
    return result;
  }

  if (topic === 'checks') {
    if (msg.type === 'snapshot') {
      const raw = snapshotList(msg.data, 'checks');
      const { ok, bad } = parseItems(checkSummarySchema, raw ?? []);
      if (raw) qc.setQueryData<CheckSummary[]>(checksKey, ok);
      if (!raw || bad) void qc.invalidateQueries({ queryKey: checksKey, exact: true });
    } else {
      const { ok, bad } = parseItems(checkSummarySchema, msg.upsert ?? []);
      qc.setQueryData<CheckSummary[]>(checksKey, (old) =>
        old ? mergeById(old, ok, msg.remove) : old,
      );
      for (const id of msg.remove ?? []) qc.removeQueries({ queryKey: [...checksKey, id] });
      if (bad) void qc.invalidateQueries({ queryKey: checksKey, exact: true });
    }
    return result;
  }

  const logs = /^container-logs:([A-Za-z0-9_-]{1,64})$/.exec(topic);
  if (logs?.[1]) {
    applyLogMessage(qc, logs[1], msg);
    return result;
  }

  const m = /^server:([A-Za-z0-9_-]{1,64})$/.exec(topic);
  if (m?.[1]) {
    const id = m[1];
    const key = serverKey(id);
    const payload = msg.type === 'snapshot' ? msg.data : msg.upsert?.[msg.upsert.length - 1];
    if (msg.type === 'update' && msg.remove?.includes(id)) {
      qc.removeQueries({ queryKey: key, exact: true });
      return result;
    }
    if (payload === undefined) return result;
    const detail = serverDetailSchema.safeParse(payload);
    if (detail.success) {
      qc.setQueryData<ServerDetail>(key, detail.data);
      return result;
    }
    // An update may also carry just the summary.
    const summary = serverSummarySchema.safeParse(payload);
    if (summary.success && qc.getQueryData(key)) {
      patchDetailSummary(qc, summary.data);
      return result;
    }
    void qc.invalidateQueries({ queryKey: key, exact: true });
  }
  return result;
}

/**
 * Topic `container-logs:<id>`: the snapshot replaces the buffer, updates append lines.
 * An update may also carry a snapshot-shaped item (`{ lines, ended }`) when the
 * stream ends. Invalid lines are dropped; there is no REST fallback for logs.
 */
function applyLogMessage(
  qc: QueryClient,
  id: string,
  msg: Extract<LiveServerMessage, { type: 'snapshot' | 'update' }>,
): void {
  const key = containerLogsKey(id);
  if (msg.type === 'snapshot') {
    const snap = logSnapshotSchema.safeParse(msg.data);
    if (!snap.success) return;
    qc.setQueryData<LogBuffer>(key, {
      lines: appendLogLines([], snap.data.lines),
      ended: snap.data.ended,
    });
    return;
  }
  const add: LogLine[] = [];
  let ended: boolean | null = null;
  for (const raw of msg.upsert ?? []) {
    const line = logLineSchema.safeParse(raw);
    if (line.success) {
      add.push(line.data);
      continue;
    }
    const snap = logSnapshotSchema.safeParse(raw);
    if (snap.success) {
      add.push(...snap.data.lines);
      ended = snap.data.ended;
    }
  }
  qc.setQueryData<LogBuffer>(key, (old) => ({
    lines: appendLogLines(old?.lines ?? [], add),
    ended: ended ?? old?.ended ?? false,
  }));
}

/** Keeps the summary inside a cached detail in step with the list. */
function patchDetailSummary(qc: QueryClient, s: ServerSummary): void {
  qc.setQueryData<ServerDetail>(serverKey(s.id), (old) => (old ? { ...old, server: s } : old));
}

/** Parses one raw frame. Returns null for anything that is not a valid server message. */
export function parseLiveFrame(raw: unknown): LiveServerMessage | null {
  if (typeof raw !== 'string' || raw.length > 4 * 1024 * 1024) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = liveServerMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** 1 s, 2 s, 4 s … up to 30 s, with up to 20 % jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (1 + random() * 0.2));
}

export function liveUrl(loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/live`;
}

type Listener<T> = (value: T) => void;

export interface LiveClientOptions {
  url?: string;
  /** Injected for tests. */
  createSocket?: (url: string) => WebSocket;
  /** Called when the session may be gone (closed with 4001, or the upgrade failed). */
  onUnauthorized?: () => void;
}

const PING_MS = 25_000;
/**
 * After these the session is checked again: the core closes with LIVE_CLOSE_SESSION_ENDED
 * when a session ends, and a missing session makes the upgrade fail before `open`.
 */
const SESSION_CLOSE_CODES = new Set([LIVE_CLOSE_SESSION_ENDED, 1008]);

export class LiveClient {
  private readonly qc: QueryClient;
  private readonly opts: LiveClientOptions;
  private socket: WebSocket | null = null;
  private readonly topics = new Map<string, number>();
  private state: LiveState = 'closed';
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly stateListeners = new Set<Listener<LiveState>>();
  private readonly alertListeners = new Set<Listener<Alert>>();
  /** Alerts already seen, so a later update of the same alert never toasts again. */
  private readonly seenAlerts = new Set<string>();
  private lastMessageAt: number | null = null;

  constructor(qc: QueryClient, opts: LiveClientOptions = {}) {
    this.qc = qc;
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close(1000);
    }
    this.setState('closed');
  }

  getState = (): LiveState => this.state;
  getLastMessageAt = (): number | null => this.lastMessageAt;

  onState = (fn: Listener<LiveState>): (() => void) => {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  };

  onAlert(fn: Listener<Alert>): () => void {
    this.alertListeners.add(fn);
    return () => this.alertListeners.delete(fn);
  }

  /** Reference-counted subscription. Returns the unsubscribe function. */
  subscribe(topic: string): () => void {
    if (!liveTopicSchema.safeParse(topic).success) return () => undefined;
    const n = this.topics.get(topic) ?? 0;
    this.topics.set(topic, n + 1);
    if (n === 0) this.send({ type: 'subscribe', topics: [topic] });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.topics.get(topic) ?? 1) - 1;
      if (left > 0) {
        this.topics.set(topic, left);
        return;
      }
      this.topics.delete(topic);
      this.send({ type: 'unsubscribe', topics: [topic] });
    };
  }

  /** Handles one raw frame (public for tests). */
  handleFrame(raw: unknown): void {
    const msg = parseLiveFrame(raw);
    if (!msg) return;
    this.lastMessageAt = Date.now();
    if (msg.type === 'pong' || msg.type === 'error') return;
    if (msg.type === 'snapshot' && msg.topic === 'alerts') {
      const list = snapshotList(msg.data, 'alerts') ?? [];
      for (const a of list) {
        if (a && typeof a === 'object' && typeof (a as WithId).id === 'string') {
          this.seenAlerts.add((a as WithId).id);
        }
      }
    }
    const { newAlerts } = applyLiveMessage(this.qc, msg);
    for (const a of newAlerts) {
      if (this.seenAlerts.has(a.id)) continue;
      this.seenAlerts.add(a.id);
      for (const fn of this.alertListeners) fn(a);
    }
  }

  private connect(): void {
    if (!this.running) return;
    this.setState('connecting');
    let socket: WebSocket;
    try {
      const url = this.opts.url ?? liveUrl();
      socket = this.opts.createSocket ? this.opts.createSocket(url) : new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.attempt = 0;
      this.setState('open');
      const topics = [...this.topics.keys()];
      for (let i = 0; i < topics.length; i += 20) {
        this.send({ type: 'subscribe', topics: topics.slice(i, i + 20) });
      }
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_MS);
    };
    socket.onmessage = (ev: MessageEvent) => this.handleFrame(ev.data);
    socket.onclose = (ev: CloseEvent) => {
      this.socket = null;
      this.clearTimers();
      if (!opened || SESSION_CLOSE_CODES.has(ev.code)) this.opts.onUnauthorized?.();
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose follows and schedules the retry.
    };
  }

  private scheduleReconnect(): void {
    this.setState('closed');
    if (!this.running) return;
    const delay = backoffMs(this.attempt++);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }

  private send(msg: object): void {
    const s = this.socket;
    if (s && s.readyState === 1) s.send(JSON.stringify(msg));
  }

  private setState(next: LiveState): void {
    if (this.state === next) return;
    this.state = next;
    for (const fn of this.stateListeners) fn(next);
  }
}

// ---------------------------------------------------------------------------
// React bindings

const LiveContext = createContext<LiveClient | null>(null);

export function LiveProvider({
  client,
  children,
}: {
  client: LiveClient;
  children?: ReactNode;
}): ReactElement {
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  return createElement(LiveContext.Provider, { value: client }, children);
}

export function useLiveClient(): LiveClient | null {
  return useContext(LiveContext);
}

/** Subscribes to a topic while the component is mounted. `null` subscribes to nothing. */
export function useLiveTopic(topic: string | null): void {
  const client = useContext(LiveContext);
  useEffect(() => {
    if (!client || !topic) return;
    return client.subscribe(topic);
  }, [client, topic]);
}

const noopSubscribe = (): (() => void) => () => undefined;
const closed = (): LiveState => 'closed';

export function useLiveState(): LiveState {
  const client = useContext(LiveContext);
  return useSyncExternalStore(
    client ? client.onState : noopSubscribe,
    client ? client.getState : closed,
    closed,
  );
}

/** Calls `fn` for every new alert that arrives live (not for the snapshot). */
export function useLiveAlerts(fn: (a: Alert) => void): void {
  const client = useContext(LiveContext);
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    if (!client) return;
    return client.onAlert((a) => ref.current(a));
  }, [client]);
}

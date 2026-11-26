import { and, desc, eq, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Alert, AlertLevel, AlertSource, AlertState, alertListQuerySchema } from '@hz/shared';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import type { Db } from '../db/index.js';
import { alerts, type AlertRow } from '../db/schema.js';
import { clockTime } from '../format.js';

export type AlertListQuery = z.infer<typeof alertListQuerySchema>;
export type AlertListener = (alert: Alert) => void;

/**
 * What happened to an alert (for notifications). `onChange` only carries the
 * alert; the notifier needs to know whether it is new, escalated or recovered.
 */
export type AlertEvent =
  | { kind: 'opened'; alert: Alert }
  | { kind: 'changed'; alert: Alert; previousLevel: AlertLevel }
  /** The condition recovered: `resolved` is the old alert, `alert` the new OK entry. */
  | { kind: 'recovered'; alert: Alert; resolved: Alert }
  | { kind: 'acked'; alert: Alert }
  /** Resolved without recovery (by the admin or because the target was deleted). */
  | { kind: 'closed'; alert: Alert }
  /** A log entry that is resolved from the start (info, e.g. the weekly report). */
  | { kind: 'logged'; alert: Alert };
export type AlertEventListener = (event: AlertEvent) => void;

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    key: row.key,
    level: row.level as AlertLevel,
    title: row.title,
    body: row.body,
    serverId: row.serverId,
    source: row.source as AlertSource,
    state: row.state as AlertState,
    openedAt: new Date(row.openedAt).toISOString(),
    ackedAt: iso(row.ackedAt),
    resolvedAt: iso(row.resolvedAt),
  };
}

export interface RaiseResult {
  alert: Alert;
  /** A new alert was opened. */
  created: boolean;
  /** An existing alert changed its level (escalation or de-escalation). */
  changed: boolean;
}

/**
 * Alert model core (SPEC 9). Every event becomes an alert; one open/acked alert
 * per dedupe key (also enforced by a partial unique index). States: open ->
 * acked -> resolved. Push, quiet hours and bundling sit on top of `onEvent`
 * (push/notifier.ts).
 */
/** Resolved alerts are kept this long (open and acknowledged ones forever). */
export const ALERT_RETENTION_MS = 90 * 24 * 60 * 60_000;

export class AlertService {
  private readonly listeners = new Set<AlertListener>();
  private readonly eventListeners = new Set<AlertEventListener>();

  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  onChange(fn: AlertListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Typed events for notifications (push). Listeners must not throw. */
  onEvent(fn: AlertEventListener): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  private emit(alert: Alert, event?: AlertEvent): void {
    for (const fn of this.listeners) fn(alert);
    if (event) for (const fn of this.eventListeners) fn(event);
  }

  /** Open or acked alert with this key. */
  /** Removes resolved alerts older than `maxAgeMs` (default 90 days). Returns the count. */
  prune(maxAgeMs = ALERT_RETENTION_MS): number {
    const cutoff = this.now() - maxAgeMs;
    return this.db
      .delete(alerts)
      .where(and(eq(alerts.state, 'resolved'), lt(alerts.resolvedAt, cutoff)))
      .run().changes;
  }

  active(key: string): Alert | null {
    const row = this.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.key, key), ne(alerts.state, 'resolved')))
      .get();
    return row ? toAlert(row) : null;
  }

  get(id: string): Alert | null {
    const row = this.db.select().from(alerts).where(eq(alerts.id, id)).get();
    return row ? toAlert(row) : null;
  }

  /**
   * Opens an alert unless one with the same key is still active. If the active
   * one has another level, it takes over level, title and body (keeps its id
   * and opened_at). Same level: nothing changes, so changing values do not spam.
   */
  raise(
    key: string,
    level: AlertLevel,
    title: string,
    body: string,
    serverId: string | null,
    source: AlertSource,
  ): RaiseResult {
    const existing = this.active(key);
    if (existing) {
      if (existing.level === level) return { alert: existing, created: false, changed: false };
      this.db.update(alerts).set({ level, title, body }).where(eq(alerts.id, existing.id)).run();
      const alert = this.get(existing.id);
      if (!alert) throw new Error('alert vanished');
      this.emit(alert, { kind: 'changed', alert, previousLevel: existing.level });
      return { alert, created: false, changed: true };
    }
    const row: AlertRow = {
      id: randomToken(16),
      key,
      level,
      title,
      body,
      serverId,
      source,
      state: 'open',
      openedAt: this.now(),
      ackedAt: null,
      resolvedAt: null,
    };
    this.db.insert(alerts).values(row).run();
    const alert = toAlert(row);
    this.emit(alert, { kind: 'opened', alert });
    return { alert, created: true, changed: false };
  }

  /**
   * Resolves the active alert with this key (the state recovered) and logs an
   * OK alert. Without an active alert nothing happens. Returns the OK alert.
   */
  resolve(key: string, ok?: { title: string; body: string }): Alert | null {
    const existing = this.active(key);
    if (!existing) return null;
    const now = this.now();
    this.db
      .update(alerts)
      .set({ state: 'resolved', resolvedAt: now })
      .where(eq(alerts.id, existing.id))
      .run();
    const resolved = this.get(existing.id);
    if (resolved) this.emit(resolved);
    const okRow: AlertRow = {
      id: randomToken(16),
      key,
      level: 'ok',
      title: ok?.title ?? `Erledigt: ${existing.title}`,
      body: ok?.body ?? `Seit ${clockTime(now)} erledigt.`,
      serverId: existing.serverId,
      source: existing.source,
      state: 'resolved',
      openedAt: now,
      ackedAt: null,
      resolvedAt: now,
    };
    this.db.insert(alerts).values(okRow).run();
    const okAlert = toAlert(okRow);
    this.emit(okAlert, { kind: 'recovered', alert: okAlert, resolved: resolved ?? existing });
    return okAlert;
  }

  /** open -> acked. Returns null if missing, 'conflict' if not open. */
  ack(id: string): Alert | null | 'conflict' {
    const a = this.get(id);
    if (!a) return null;
    if (a.state !== 'open') return 'conflict';
    this.db
      .update(alerts)
      .set({ state: 'acked', ackedAt: this.now() })
      .where(eq(alerts.id, id))
      .run();
    const updated = this.get(id);
    if (updated) this.emit(updated, { kind: 'acked', alert: updated });
    return updated;
  }

  /** Manual resolve (no OK alert). Returns null if missing, 'conflict' if already resolved. */
  resolveById(id: string): Alert | null | 'conflict' {
    const a = this.get(id);
    if (!a) return null;
    if (a.state === 'resolved') return 'conflict';
    this.db
      .update(alerts)
      .set({ state: 'resolved', resolvedAt: this.now() })
      .where(eq(alerts.id, id))
      .run();
    const updated = this.get(id);
    if (updated) this.emit(updated, { kind: 'closed', alert: updated });
    return updated;
  }

  /** Resolves every active alert whose key starts with `prefix`, without OK alerts. */
  resolveAllWithPrefix(prefix: string): void {
    const rows = this.db
      .select()
      .from(alerts)
      .where(ne(alerts.state, 'resolved'))
      .all()
      .filter((r) => r.key.startsWith(prefix));
    for (const r of rows) this.resolveById(r.id);
  }

  /**
   * Writes an entry that needs no action (resolved from the start), e.g. the
   * weekly report. It shows up in the alert log and may be pushed.
   */
  log(
    key: string,
    level: 'info' | 'ok',
    title: string,
    body: string,
    serverId: string | null,
    source: AlertSource,
  ): Alert {
    const now = this.now();
    const row: AlertRow = {
      id: randomToken(16),
      key,
      level,
      title,
      body,
      serverId,
      source,
      state: 'resolved',
      openedAt: now,
      ackedAt: null,
      resolvedAt: now,
    };
    this.db.insert(alerts).values(row).run();
    const alert = toAlert(row);
    this.emit(alert, { kind: 'logged', alert });
    return alert;
  }

  /** Number of open or acked alerts. */
  activeCount(): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(alerts)
      .where(inArray(alerts.state, ['open', 'acked']))
      .get();
    return row?.n ?? 0;
  }

  /** Resolves every active alert of a server without OK alerts (server deleted). */
  resolveAllForServer(serverId: string): void {
    const rows = this.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.serverId, serverId), ne(alerts.state, 'resolved')))
      .all();
    for (const r of rows) this.resolveById(r.id);
  }

  list(q: AlertListQuery): Alert[] {
    const where: SQL[] = [];
    if (q.state === 'active') where.push(inArray(alerts.state, ['open', 'acked']));
    else if (q.state !== 'all') where.push(eq(alerts.state, q.state));
    if (q.level) where.push(eq(alerts.level, q.level));
    if (q.serverId) where.push(eq(alerts.serverId, q.serverId));
    if (q.source) where.push(eq(alerts.source, q.source));
    return this.db
      .select()
      .from(alerts)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(alerts.openedAt), desc(alerts.id))
      .limit(q.limit)
      .all()
      .map(toAlert);
  }
}

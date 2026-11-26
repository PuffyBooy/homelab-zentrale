import { and, desc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Alert, AlertLevel, AlertSource, AlertState, alertListQuerySchema } from '@hz/shared';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import type { Db } from '../db/index.js';
import { alerts, type AlertRow } from '../db/schema.js';
import { clockTime } from '../format.js';

export type AlertListQuery = z.infer<typeof alertListQuerySchema>;
export type AlertListener = (alert: Alert) => void;

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
 * per dedupe key (also enforced by a partial unique index). M4 adds push,
 * quiet hours and bundling on top of the listeners.
 */
export class AlertService {
  private readonly listeners = new Set<AlertListener>();

  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  onChange(fn: AlertListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(alert: Alert): void {
    for (const fn of this.listeners) fn(alert);
  }

  /** Open or acked alert with this key. */
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
      this.emit(alert);
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
    this.emit(alert);
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
    this.emit(okAlert);
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
    if (updated) this.emit(updated);
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
    if (updated) this.emit(updated);
    return updated;
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

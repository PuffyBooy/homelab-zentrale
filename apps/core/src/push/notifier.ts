import { asc, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Alert, NotifySettings, PushPayload } from '@hz/shared';
import type { AlertEvent, AlertService } from '../alerts/service.js';
import { inQuietHours } from '../calendar.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import { pushDigestItems } from '../db/schema.js';
import { maskAddresses } from '../wall/service.js';

/**
 * Push policy (SPEC 9):
 * - crit always, immediately (also during quiet hours)
 * - warn at most one push per `warnBundleMinutes`; what comes in between is
 *   collected and sent as one bundle
 * - quiet hours (default 23:00-07:00 local time): only crit, and the OK of a
 *   recovered crit. Everything else that would have been pushed is collected
 *   (persisted in push_digest_items) and sent as one digest push "Über Nacht:
 *   N Meldungen" when the quiet hours end (decision 2026-11-26), only to the
 *   devices that existed when the push was held back
 * - recovery: OK of a crit immediately; OK of a warn goes with the warn bundle
 * - info (weekly report) immediately, not in quiet hours
 */
/** `defer`: would be pushed, but it is quiet hours; goes into the morning digest. */
export type Decision = 'now' | 'bundle' | 'defer' | 'drop';

export function decide(event: AlertEvent, settings: NotifySettings, now: number): Decision {
  const quiet = inQuietHours(now, settings.quietStart, settings.quietEnd);
  const nonCrit = (d: 'now' | 'bundle'): Decision => (quiet ? 'defer' : d);
  switch (event.kind) {
    case 'opened':
      if (event.alert.level === 'crit') return 'now';
      return event.alert.level === 'warn' ? nonCrit('bundle') : nonCrit('now');
    case 'changed':
      if (event.alert.level === 'crit') return event.previousLevel === 'crit' ? 'drop' : 'now';
      return event.alert.level === 'warn' ? nonCrit('bundle') : 'drop';
    case 'recovered':
      return event.resolved.level === 'crit' ? 'now' : nonCrit('bundle');
    case 'logged':
      return nonCrit('now');
    case 'acked':
    case 'closed':
      return 'drop';
  }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function payloadOf(alert: Alert): PushPayload {
  return {
    title: clip(alert.title, 200),
    body: clip(alert.body, 1000),
    level: alert.level,
    url: '/alerts',
    tag: clip(alert.key, 200),
  };
}

/** One push for several warn/ok entries. */
export function bundlePayload(items: readonly Alert[]): PushPayload | null {
  const first = items[0];
  if (!first) return null;
  if (items.length === 1) return payloadOf(first);
  const level = items.some((a) => a.level === 'warn') ? 'warn' : 'ok';
  return {
    title: `${items.length} Meldungen`,
    body: clip(items.map((a) => a.title).join('\n'), 1000),
    level,
    url: '/alerts',
    tag: 'warn-bundle',
  };
}

/** At most this many titles in the digest body. */
export const DIGEST_TITLES = 5;

/** The morning digest of the pushes held back during quiet hours. */
export function digestPayload(
  items: readonly { level: string; title: string }[],
): PushPayload | null {
  const n = items.length;
  if (n === 0) return null;
  const shown = items.slice(0, DIGEST_TITLES).map((i) => maskAddresses(i.title));
  if (n > DIGEST_TITLES) shown.push(`… und ${n - DIGEST_TITLES} weitere`);
  return {
    title: `Über Nacht: ${n} ${n === 1 ? 'Meldung' : 'Meldungen'}`,
    body: clip(shown.join('\n'), 1000),
    level: items.some((i) => i.level === 'warn') ? 'warn' : 'info',
    url: '/alerts',
    tag: 'night-digest',
  };
}

export interface PushSink {
  sendAll(payload: PushPayload): Promise<number>;
  /** Sends only to these devices (ids that no longer exist are skipped). */
  sendTo(deviceIds: readonly string[], payload: PushPayload): Promise<number>;
  /** Ids of the devices that currently receive pushes. */
  deviceIds(): string[];
}

export class Notifier {
  private queue: Alert[] = [];
  private lastBundleAt: number | null = null;

  constructor(
    private readonly deps: {
      alerts: AlertService;
      db: Db;
      push: PushSink;
      now: Clock;
      settings: () => NotifySettings;
      log: FastifyBaseLogger;
    },
  ) {
    deps.alerts.onEvent((e) => this.handle(e));
  }

  handle(event: AlertEvent): void {
    const d = decide(event, this.deps.settings(), this.deps.now());
    if (d === 'now') this.send(payloadOf(event.alert));
    else if (d === 'defer') this.defer([event.alert]);
    else if (d === 'bundle') {
      this.queue.push(event.alert);
      this.flush();
    }
  }

  /** Number of entries waiting for the next bundle (tests, diagnostics). */
  get queued(): number {
    return this.queue.length;
  }

  /** Number of entries waiting for the morning digest (tests, diagnostics). */
  get deferred(): number {
    return this.deps.db.select({ id: pushDigestItems.id }).from(pushDigestItems).all().length;
  }

  /** Stores held-back pushes for the digest, with the devices that would have got them. */
  private defer(items: readonly Alert[]): void {
    if (items.length === 0) return;
    const devices = this.deps.push.deviceIds();
    if (devices.length === 0) return;
    const now = this.deps.now();
    this.deps.db
      .insert(pushDigestItems)
      .values(
        items.map((a) => ({
          ts: now,
          level: a.level,
          title: clip(maskAddresses(a.title), 200),
          deviceIdsJson: JSON.stringify(devices),
        })),
      )
      .run();
  }

  /**
   * Sends the digest once the quiet hours are over (scheduler, every minute; also
   * right after a restart, the items are persisted). Nothing if there is nothing.
   */
  flushDigest(): void {
    const s = this.deps.settings();
    const now = this.deps.now();
    if (inQuietHours(now, s.quietStart, s.quietEnd)) return;
    const rows = this.deps.db
      .select()
      .from(pushDigestItems)
      .orderBy(asc(pushDigestItems.ts), asc(pushDigestItems.id))
      .all();
    if (rows.length === 0) return;
    this.deps.db
      .delete(pushDigestItems)
      .where(
        inArray(
          pushDigestItems.id,
          rows.map((r) => r.id),
        ),
      )
      .run();
    const payload = digestPayload(rows);
    if (!payload) return;
    const devices = new Set<string>();
    for (const r of rows) {
      try {
        for (const id of JSON.parse(r.deviceIdsJson) as unknown[]) {
          if (typeof id === 'string') devices.add(id);
        }
      } catch {
        // A broken row only loses its devices.
      }
    }
    if (devices.size === 0) return;
    void this.deps.push.sendTo([...devices], payload).catch(() => {
      this.deps.log.warn('push delivery failed');
    });
  }

  /**
   * Sends the collected warn/ok entries if the bundle window has passed.
   * Called on every new entry and by the scheduler every minute.
   */
  flush(): void {
    if (this.queue.length === 0) return;
    const s = this.deps.settings();
    const now = this.deps.now();
    if (inQuietHours(now, s.quietStart, s.quietEnd)) {
      // Quiet hours started while entries waited: they go into the morning digest.
      const items = this.queue;
      this.queue = [];
      this.defer(items);
      return;
    }
    if (this.lastBundleAt !== null && now - this.lastBundleAt < s.warnBundleMinutes * 60_000) {
      return;
    }
    const items = this.queue.filter((a) => {
      if (a.level !== 'warn') return true;
      // A warn that was resolved or escalated meanwhile is not news any more.
      const current = this.deps.alerts.get(a.id);
      return current !== null && current.state !== 'resolved' && current.level === 'warn';
    });
    this.queue = [];
    const payload = bundlePayload(items);
    if (!payload) return;
    this.lastBundleAt = now;
    this.send(payload);
  }

  private send(payload: PushPayload): void {
    void this.deps.push.sendAll(payload).catch(() => {
      this.deps.log.warn('push delivery failed');
    });
  }
}

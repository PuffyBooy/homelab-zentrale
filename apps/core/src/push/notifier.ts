import type { FastifyBaseLogger } from 'fastify';
import type { Alert, NotifySettings, PushPayload } from '@hz/shared';
import type { AlertEvent, AlertService } from '../alerts/service.js';
import { inQuietHours } from '../calendar.js';
import type { Clock } from '../clock.js';

/**
 * Push policy (SPEC 9):
 * - crit always, immediately (also during quiet hours)
 * - warn at most one push per `warnBundleMinutes`; what comes in between is
 *   collected and sent as one bundle
 * - quiet hours (default 23:00-07:00 Vienna): only crit, and the OK of a
 *   recovered crit
 * - recovery: OK of a crit immediately; OK of a warn goes with the warn bundle
 * - info (weekly report) immediately, not in quiet hours
 */
export type Decision = 'now' | 'bundle' | 'drop';

export function decide(event: AlertEvent, settings: NotifySettings, now: number): Decision {
  const quiet = inQuietHours(now, settings.quietStart, settings.quietEnd);
  const nonCrit = (d: Exclude<Decision, 'drop'>): Decision => (quiet ? 'drop' : d);
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

export interface PushSink {
  sendAll(payload: PushPayload): Promise<number>;
}

export class Notifier {
  private queue: Alert[] = [];
  private lastBundleAt: number | null = null;

  constructor(
    private readonly deps: {
      alerts: AlertService;
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
    else if (d === 'bundle') {
      this.queue.push(event.alert);
      this.flush();
    }
  }

  /** Number of entries waiting for the next bundle (tests, diagnostics). */
  get queued(): number {
    return this.queue.length;
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
      // Quiet hours started while entries waited: they stay in the alert log only.
      this.queue = [];
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

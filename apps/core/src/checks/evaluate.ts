/**
 * Pure check rules (SPEC 8): crit only after 2 failures in a row, warn for
 * slow answers (> 800 ms, twice in a row) and certificates/domains that expire
 * soon. Texts follow design/README.md "Stimme und Text".
 */
import type { z } from 'zod';
import type { checkStatusSchema } from '@hz/shared';

export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const DAY = 24 * 60 * 60 * 1000;
export const SLOW_MS = 800;
export const FAILURES_FOR_CRIT = 2;
export const SLOW_FOR_WARN = 2;
export const SSL_WARN_DAYS = 14;
export const SSL_CRIT_DAYS = 5;
export const DOMAIN_WARN_DAYS = 30;

const decimal = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 1 });
const percentFmt = new Intl.NumberFormat('de-AT', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** `950 ms`, `1,2 s` */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${decimal.format(Math.round(ms / 100) / 10)} s`;
}

/** `99,95 %` */
export function formatPercent(v: number): string {
  return `${percentFmt.format(v)} %`;
}

/** Whole days until `expiresAt` (negative when expired). */
export function daysLeft(expiresAt: number, now: number): number {
  return Math.floor((expiresAt - now) / DAY);
}

/** `heute`, `in 1 Tag`, `in 4 Tagen` */
export function inDays(days: number): string {
  if (days <= 0) return 'heute';
  return days === 1 ? 'in 1 Tag' : `in ${days} Tagen`;
}

export function sslLevel(days: number): 'warn' | 'crit' | null {
  if (days < SSL_CRIT_DAYS) return 'crit';
  if (days < SSL_WARN_DAYS) return 'warn';
  return null;
}

export function domainLevel(days: number): 'warn' | null {
  return days < DOMAIN_WARN_DAYS ? 'warn' : null;
}

/**
 * Uptime in percent with two decimals, rounded down (100 only without a single
 * failure). Null without data.
 */
export function uptimePercent(ok: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.floor((ok * 10_000) / total) / 100;
}

/** Counters carried from one result to the next. */
export interface Streak {
  consecutiveFailures: number;
  consecutiveSlow: number;
  /** Start of the current failure streak. */
  downSince: number | null;
}

export interface ResultInput {
  ok: boolean;
  ms: number | null;
  /** Short reason of a failure. */
  error?: string | undefined;
}

export function nextStreak(prev: Streak, r: ResultInput, now: number): Streak {
  if (!r.ok) {
    return {
      consecutiveFailures: prev.consecutiveFailures + 1,
      consecutiveSlow: 0,
      downSince: prev.downSince ?? now,
    };
  }
  const slow = r.ms !== null && r.ms > SLOW_MS;
  return {
    consecutiveFailures: 0,
    consecutiveSlow: slow ? prev.consecutiveSlow + 1 : 0,
    downSince: null,
  };
}

export interface StatusInput {
  enabled: boolean;
  /** Agent offline or not answering: the check could not run. */
  unavailable: string | null;
  /** Never ran yet. */
  pending: boolean;
  streak: Streak;
  lastError: string | null;
  lastMs: number | null;
  sslDays: number | null;
  domainDays: number | null;
}

export interface Evaluation {
  status: CheckStatus;
  reason: string | null;
  /** The check is down (crit alert). */
  down: boolean;
  slow: boolean;
  ssl: 'warn' | 'crit' | null;
  domain: 'warn' | null;
}

/** Combines the rules into the status shown in WebCheckRow and the alert flags. */
export function evaluate(i: StatusInput): Evaluation {
  const down = i.streak.consecutiveFailures >= FAILURES_FOR_CRIT;
  const slow = !down && i.streak.consecutiveSlow >= SLOW_FOR_WARN;
  const ssl = i.sslDays === null ? null : sslLevel(i.sslDays);
  const domain = i.domainDays === null ? null : domainLevel(i.domainDays);
  const flags = { down, slow, ssl, domain };
  const sslText = i.sslDays !== null ? `SSL läuft ${inDays(i.sslDays)} ab` : null;
  const domainText = i.domainDays !== null ? `Domain läuft ${inDays(i.domainDays)} ab` : null;

  if (!i.enabled) return { status: 'off', reason: 'Pausiert', ...flags };
  if (i.unavailable !== null) return { status: 'off', reason: i.unavailable, ...flags };
  if (i.pending) return { status: 'busy', reason: 'Wird geprüft', ...flags };
  if (down) return { status: 'crit', reason: i.lastError ?? 'Nicht erreichbar', ...flags };
  if (ssl === 'crit') return { status: 'crit', reason: sslText, ...flags };
  if (i.streak.consecutiveFailures > 0) {
    return {
      status: 'warn',
      reason: `${i.lastError ?? 'Fehlschlag'} · wird erneut geprüft`,
      ...flags,
    };
  }
  if (slow && i.lastMs !== null) {
    return { status: 'warn', reason: `Langsam: ${formatMs(i.lastMs)}`, ...flags };
  }
  if (ssl === 'warn') return { status: 'warn', reason: sslText, ...flags };
  if (domain === 'warn') return { status: 'warn', reason: domainText, ...flags };
  return { status: 'ok', reason: null, ...flags };
}

/**
 * Sparkline values: mean response time per bucket over [from, to), oldest
 * first; empty buckets are skipped.
 */
export function sparkline(
  points: readonly { ts: number; ms: number | null }[],
  from: number,
  to: number,
  buckets: number,
): number[] {
  const size = (to - from) / buckets;
  const sum = new Array<number>(buckets).fill(0);
  const n = new Array<number>(buckets).fill(0);
  for (const p of points) {
    if (p.ms === null || p.ts < from || p.ts >= to) continue;
    const b = Math.min(buckets - 1, Math.floor((p.ts - from) / size));
    sum[b] = (sum[b] ?? 0) + p.ms;
    n[b] = (n[b] ?? 0) + 1;
  }
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const c = n[b] ?? 0;
    if (c > 0) out.push(Math.round((sum[b] ?? 0) / c));
  }
  return out;
}

import type { ServerStatus, StatusReason, Thresholds } from '@hz/shared';
import { celsius, clockTimeRelative, percent } from '../format.js';

/**
 * Status rules of SPEC 5.1 as a pure function.
 *
 * crit: agent silent for more than offlineAfterS (90 s) or its socket closed for
 *       at least 30 s, disk >= diskCrit, RAM >= ramCrit for ramCritMinutes
 * warn: CPU >= cpuWarn for cpuWarnMinutes, RAM >= ramWarn, disk >= diskWarn,
 *       temperature >= tempWarn, security updates, reboot required,
 *       failed systemd units (M16)
 * ok:   otherwise
 */

/** A socket that has been closed this long counts as offline. */
export const DISCONNECT_GRACE_MS = 30_000;
/**
 * A sustained rule needs a sample this close to the start of its window
 * (1.5 x the 10 s metrics interval), so "for 10 min" really covers 10 min.
 */
export const WINDOW_TOLERANCE_MS = 15_000;

export interface Sample {
  ts: number;
  cpu: number;
  ramPct: number;
}

export interface StatusInput {
  connected: boolean;
  /** When the socket closed; null while connected or if it never closed since boot. */
  disconnectedAt: number | null;
  /** Last valid message from the agent. */
  lastSeen: number | null;
  /**
   * Start of observation (core boot). Silence before it does not count, so a
   * core restart gives agents offlineAfterS to reconnect before they are DOWN.
   */
  observedSince?: number;
  /** Raw samples, ascending by ts, covering at least the longest window. */
  samples: readonly Sample[];
  latest: {
    cpu: number;
    ramPct: number;
    disks: readonly { mount: string; pct: number }[];
    temp: number | null;
  } | null;
  updates: { total: number; security: number } | null;
  rebootRequired: boolean | null;
  /** M16: failed systemd units from the last inventory (absent: unknown). */
  failedServices?: readonly string[];
}

export type ReasonCode = StatusReason['code'];

/** Internal reason with the values behind the text (used for alert texts). */
export interface EvaluatedReason extends StatusReason {
  value?: number;
  mount?: string;
  /** Start of the condition, if known (offline: last seen; sustained: window start). */
  since?: number;
}

export interface StatusResult {
  status: ServerStatus;
  reasons: EvaluatedReason[];
}

/** Category of a reason. One alert per server and category. */
export function reasonCategory(code: ReasonCode): string {
  switch (code) {
    case 'offline':
    case 'never_seen':
      return 'offline';
    case 'disk_crit':
    case 'disk_warn':
      return 'disk';
    case 'ram_crit':
    case 'ram_warn':
      return 'ram';
    case 'cpu_warn':
      return 'cpu';
    case 'temp_warn':
      return 'temp';
    case 'security_updates':
      return 'updates';
    case 'reboot_required':
      return 'reboot';
    case 'service_failed':
      // One alert per unit (servers/service-alerts.ts), not per category.
      return 'services';
  }
}

/**
 * True if every sample in [now - windowMs, now] is >= threshold and the samples
 * reach back to the start of the window.
 */
export function sustainedAbove(
  samples: readonly Sample[],
  pick: (s: Sample) => number,
  threshold: number,
  windowMs: number,
  now: number,
): boolean {
  const start = now - windowMs;
  const inWindow = samples.filter((s) => s.ts >= start && s.ts <= now);
  if (inWindow.length === 0) return false;
  const first = inWindow[0];
  if (!first || first.ts > start + WINDOW_TOLERANCE_MS) return false;
  return inWindow.every((s) => pick(s) >= threshold);
}

export function isOffline(input: StatusInput, t: Thresholds, now: number): boolean {
  if (input.lastSeen === null) return false;
  const silentSince = Math.max(input.lastSeen, input.observedSince ?? -Infinity);
  if (now - silentSince > t.offlineAfterS * 1000) return true;
  return (
    !input.connected &&
    input.disconnectedAt !== null &&
    now - input.disconnectedAt >= DISCONNECT_GRACE_MS
  );
}

const ORDER: Record<ServerStatus, number> = { crit: 0, warn: 1, off: 2, ok: 3 };

export function evaluateStatus(input: StatusInput, t: Thresholds, now: number): StatusResult {
  if (input.lastSeen === null) {
    return {
      status: 'off',
      reasons: [{ level: 'warn', code: 'never_seen', text: 'Noch keine Meldung vom Agent' }],
    };
  }
  if (isOffline(input, t, now)) {
    return {
      status: 'crit',
      reasons: [
        {
          level: 'crit',
          code: 'offline',
          text: `Offline seit ${clockTimeRelative(input.lastSeen, now)}`,
          since: input.lastSeen,
        },
      ],
    };
  }

  const reasons: EvaluatedReason[] = [];
  const latest = input.latest;
  if (latest) {
    // Disk: the fullest disk decides.
    let worst: { mount: string; pct: number } | undefined;
    for (const d of latest.disks) if (!worst || d.pct > worst.pct) worst = d;
    if (worst && worst.pct >= t.diskCrit) {
      reasons.push({
        level: 'crit',
        code: 'disk_crit',
        text: `Disk ${worst.mount} bei ${percent(worst.pct)}`,
        value: worst.pct,
        mount: worst.mount,
      });
    } else if (worst && worst.pct >= t.diskWarn) {
      reasons.push({
        level: 'warn',
        code: 'disk_warn',
        text: `Disk ${worst.mount} bei ${percent(worst.pct)}`,
        value: worst.pct,
        mount: worst.mount,
      });
    }

    const ramWindow = t.ramCritMinutes * 60_000;
    if (sustainedAbove(input.samples, (s) => s.ramPct, t.ramCrit, ramWindow, now)) {
      reasons.push({
        level: 'crit',
        code: 'ram_crit',
        text: `RAM ${percent(latest.ramPct)} seit ${t.ramCritMinutes} Min`,
        value: latest.ramPct,
        since: now - ramWindow,
      });
    } else if (latest.ramPct >= t.ramWarn) {
      reasons.push({
        level: 'warn',
        code: 'ram_warn',
        text: `RAM ${percent(latest.ramPct)}`,
        value: latest.ramPct,
      });
    }

    const cpuWindow = t.cpuWarnMinutes * 60_000;
    if (sustainedAbove(input.samples, (s) => s.cpu, t.cpuWarn, cpuWindow, now)) {
      reasons.push({
        level: 'warn',
        code: 'cpu_warn',
        text: `CPU ${percent(latest.cpu)} seit ${t.cpuWarnMinutes} Min`,
        value: latest.cpu,
        since: now - cpuWindow,
      });
    }

    if (latest.temp !== null && latest.temp >= t.tempWarn) {
      reasons.push({
        level: 'warn',
        code: 'temp_warn',
        text: `Temperatur ${celsius(latest.temp)}`,
        value: latest.temp,
      });
    }
  }

  const security = input.updates?.security ?? 0;
  if (security > 0) {
    reasons.push({
      level: 'warn',
      code: 'security_updates',
      text: security === 1 ? '1 Sicherheitsupdate offen' : `${security} Sicherheitsupdates offen`,
      value: security,
    });
  }
  if (input.rebootRequired) {
    reasons.push({ level: 'warn', code: 'reboot_required', text: 'Neustart nötig' });
  }
  const failed = input.failedServices ?? [];
  const firstFailed = failed[0];
  if (firstFailed !== undefined) {
    reasons.push({
      level: 'warn',
      code: 'service_failed',
      text:
        failed.length === 1
          ? `Dienst ${firstFailed} fehlgeschlagen`
          : `${failed.length} Dienste fehlgeschlagen`,
      value: failed.length,
    });
  }

  reasons.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  const status: ServerStatus = reasons.some((r) => r.level === 'crit')
    ? 'crit'
    : reasons.length > 0
      ? 'warn'
      : 'ok';
  return { status, reasons };
}

/** The API shape of a reason (strips the internal values). */
export function publicReason(r: EvaluatedReason): StatusReason {
  return { level: r.level, code: r.code, text: r.text };
}

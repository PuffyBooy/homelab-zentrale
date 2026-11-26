import type { ScheduleWindow, Weekday } from '@hz/shared';
import { hhmmToMinutes, localTime } from '../calendar.js';

/** calendar.ts weekday (0 = Sunday) -> schedule day. */
const DAYS: readonly Weekday[] = ['so', 'mo', 'di', 'mi', 'do', 'fr', 'sa'];

/**
 * Whether a schedule window is active at `ms` in HZ_TIMEZONE. `days` are the
 * days the window starts on; `to` < `from` runs over midnight into the next day.
 */
export function windowActive(w: ScheduleWindow, ms: number): boolean {
  const lt = localTime(ms);
  const minute = lt.hour * 60 + lt.minute;
  const today = DAYS[lt.weekday] as Weekday;
  const yesterday = DAYS[(lt.weekday + 6) % 7] as Weekday;
  const from = hhmmToMinutes(w.from);
  const to = hhmmToMinutes(w.to);
  if (from < to) return w.days.includes(today) && minute >= from && minute < to;
  return (w.days.includes(today) && minute >= from) || (w.days.includes(yesterday) && minute < to);
}

/** Indices of the windows active at `ms`. */
export function activeWindows(windows: readonly ScheduleWindow[], ms: number): number[] {
  const out: number[] = [];
  windows.forEach((w, i) => {
    if (windowActive(w, ms)) out.push(i);
  });
  return out;
}

export type TierRule = { kind: 'none' } | { kind: 'no_throttle' } | { kind: 'cpus'; cpus: number };

/**
 * What the active windows mean for a tier: `no_throttle` wins over `cpus`;
 * several `cpus` windows: the highest share (the most generous one) counts.
 */
export function tierRule(
  windows: readonly ScheduleWindow[],
  active: readonly number[],
  tier: 'niedrig' | 'normal',
): TierRule {
  let cpus: number | null = null;
  for (const i of active) {
    const w = windows[i];
    if (!w || w.tier !== tier) continue;
    if (w.mode === 'no_throttle') return { kind: 'no_throttle' };
    if (w.cpus !== undefined) cpus = Math.max(cpus ?? 0, w.cpus);
  }
  return cpus === null ? { kind: 'none' } : { kind: 'cpus', cpus };
}

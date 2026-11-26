import { TIME_ZONE } from './format.js';

/**
 * Wall-clock helpers for Europe/Vienna (daily RDAP at 04:00, weekly report on
 * Sunday 19:00, quiet hours). Pure functions of a UTC timestamp, so tests can
 * use a fake clock across DST changes.
 */

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
}

export function viennaTime(ms: number): WallTime {
  const p: Record<string, number> = {};
  for (const part of partsFmt.formatToParts(ms)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const year = p.year ?? 1970;
  const month = p.month ?? 1;
  const day = p.day ?? 1;
  return {
    year,
    month,
    day,
    hour: p.hour ?? 0,
    minute: p.minute ?? 0,
    second: p.second ?? 0,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Offset of Vienna to UTC at this instant (ms, +1 h or +2 h). */
function offsetAt(ms: number): number {
  const w = viennaTime(ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/** UTC timestamp of a Vienna wall time (date fields may overflow, e.g. day 32). */
export function fromVienna(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

/** Minutes since local midnight in Vienna. */
export function viennaMinutes(ms: number): number {
  const w = viennaTime(ms);
  return w.hour * 60 + w.minute;
}

export interface WallClockRule {
  hour: number;
  minute: number;
  /** 0 = Sunday. Omit for every day. */
  weekday?: number;
}

/** First instant strictly after `from` that matches the rule in Vienna time. */
export function nextWallClock(from: number, rule: WallClockRule): number {
  const w = viennaTime(from);
  for (let i = 0; i <= 8; i++) {
    const date = new Date(Date.UTC(w.year, w.month - 1, w.day + i));
    if (rule.weekday !== undefined && date.getUTCDay() !== rule.weekday) continue;
    const at = fromVienna(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      rule.hour,
      rule.minute,
    );
    if (at > from) return at;
  }
  throw new Error('no matching wall-clock time');
}

/** "HH:MM" -> minutes since midnight. */
export function hhmmToMinutes(v: string): number {
  const [h, m] = v.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Whether `ms` falls in the quiet window [start, end) in Vienna time. The
 * window may wrap midnight (23:00-07:00). start == end means no quiet hours.
 */
export function inQuietHours(ms: number, start: string, end: string): boolean {
  const s = hhmmToMinutes(start);
  const e = hhmmToMinutes(end);
  if (s === e) return false;
  const m = viennaMinutes(ms);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

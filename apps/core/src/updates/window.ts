import type { UpdateWindow } from '@hz/shared';
import { fromLocal, hhmmToMinutes, localTime } from '../calendar.js';

/**
 * Maintenance windows of M17 in HZ_TIMEZONE. A window starts on each of its
 * `days` (ISO weekday, 1 = Monday) at `start` local time and lasts `durationMin`
 * real minutes, so it may run over midnight into the next day. Across a DST
 * change the start is the local wall time of that day (calendar.ts fromLocal).
 */

export interface WindowOccurrence {
  /** Unique per window and start day, e.g. "2026-11-26T03:00". */
  key: string;
  start: number;
  end: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** calendar.ts weekday (0 = Sunday) -> ISO weekday (7 = Sunday). */
const isoWeekday = (d: Date): number => (d.getUTCDay() === 0 ? 7 : d.getUTCDay());

function occurrenceOn(w: UpdateWindow, day: Date): WindowOccurrence | null {
  if (!w.days.includes(isoWeekday(day))) return null;
  const minutes = hhmmToMinutes(w.start);
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth() + 1;
  const d = day.getUTCDate();
  const start = fromLocal(y, m, d, Math.floor(minutes / 60), minutes % 60);
  return {
    key: `${y}-${pad(m)}-${pad(d)}T${w.start}`,
    start,
    end: start + w.durationMin * 60_000,
  };
}

/** Local calendar day `offset` days from the local day of `ms` (as a UTC date). */
function localDay(ms: number, offset: number): Date {
  const lt = localTime(ms);
  return new Date(Date.UTC(lt.year, lt.month - 1, lt.day + offset));
}

/** The occurrence that is open at `ms` (start <= ms < end), else null. */
export function openWindowAt(w: UpdateWindow, ms: number): WindowOccurrence | null {
  // durationMin <= 480: an open window started today or yesterday (local).
  for (const offset of [0, -1]) {
    const occ = occurrenceOn(w, localDay(ms, offset));
    if (occ && ms >= occ.start && ms < occ.end) return occ;
  }
  return null;
}

/** First occurrence that starts strictly after `ms`. */
export function nextWindowAfter(w: UpdateWindow, ms: number): WindowOccurrence | null {
  for (let offset = 0; offset <= 8; offset++) {
    const occ = occurrenceOn(w, localDay(ms, offset));
    if (occ && occ.start > ms) return occ;
  }
  return null;
}

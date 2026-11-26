import type { TaskSchedule } from '@hz/shared';
import { nextWallClock } from '../calendar.js';

const MIN = 60_000;

/**
 * First run of a schedule strictly after `from`. Weekly: ISO weekdays
 * (1 = Monday .. 7 = Sunday) at HH:MM in HZ_TIMEZONE (calendar.ts, DST-safe).
 * Interval: `from` + N minutes (`from` is the last start or the save time).
 */
export function nextTaskRun(s: TaskSchedule, from: number): number {
  if (s.type === 'interval') return from + s.minutes * MIN;
  let best: number | null = null;
  for (const d of s.days) {
    for (const t of s.times) {
      const [h, m] = t.split(':').map(Number);
      const at = nextWallClock(from, { hour: h ?? 0, minute: m ?? 0, weekday: d % 7 });
      if (best === null || at < best) best = at;
    }
  }
  if (best === null) throw new Error('empty schedule');
  return best;
}

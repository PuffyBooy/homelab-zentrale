import { afterEach, describe, expect, it } from 'vitest';
import { nextWeeklyReport } from '../src/alerts/weekly-report.js';
import { fromLocal, inQuietHours, nextWallClock, localTime } from '../src/calendar.js';
import { clockTime } from '../src/format.js';
import { Scheduler } from '../src/scheduler.js';
import { DEFAULT_TIME_ZONE, isValidTimeZone, setTimeZone } from '../src/timezone.js';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('calendar (Europe/Vienna)', () => {
  it('converts Vienna wall time to UTC in winter and summer', () => {
    expect(iso(fromLocal(2026, 11, 26, 4, 0))).toBe('2026-11-26T03:00:00.000Z');
    expect(iso(fromLocal(2026, 7, 1, 4, 0))).toBe('2026-07-01T02:00:00.000Z');
  });

  it('next 04:00 is later today or tomorrow', () => {
    // 02:00 Vienna -> today 04:00
    expect(iso(nextWallClock(Date.UTC(2026, 10, 26, 1, 0), { hour: 4, minute: 0 }))).toBe(
      '2026-11-26T03:00:00.000Z',
    );
    // exactly 04:00 -> tomorrow (strictly after)
    expect(iso(nextWallClock(Date.UTC(2026, 10, 26, 3, 0), { hour: 4, minute: 0 }))).toBe(
      '2026-11-27T03:00:00.000Z',
    );
  });

  it('weekly report: Sunday 19:00 Vienna, also across the DST change', () => {
    // Thursday 2026-11-26 -> Sunday 2026-11-29 19:00 CET = 18:00 UTC
    expect(iso(nextWeeklyReport(Date.UTC(2026, 10, 26, 12, 0)))).toBe('2026-11-29T18:00:00.000Z');
    // Sunday 19:00 itself -> next Sunday
    expect(iso(nextWeeklyReport(Date.UTC(2026, 10, 29, 18, 0)))).toBe('2026-12-06T18:00:00.000Z');
    // Sunday 18:59 -> same day
    expect(iso(nextWeeklyReport(Date.UTC(2026, 10, 29, 17, 59)))).toBe('2026-11-29T18:00:00.000Z');
    // 2027-03-28 is the switch to CEST: 19:00 = 17:00 UTC
    expect(iso(nextWeeklyReport(Date.UTC(2027, 2, 26, 12, 0)))).toBe('2027-03-28T17:00:00.000Z');
    const w = localTime(nextWeeklyReport(Date.UTC(2027, 2, 26, 12, 0)));
    expect([w.weekday, w.hour, w.minute]).toEqual([0, 19, 0]);
  });

  it('quiet hours wrap midnight, end is exclusive, equal start/end means none', () => {
    const at = (h: number, m: number): number => fromLocal(2026, 11, 26, h, m);
    expect(inQuietHours(at(22, 59), '23:00', '07:00')).toBe(false);
    expect(inQuietHours(at(23, 0), '23:00', '07:00')).toBe(true);
    expect(inQuietHours(at(3, 0), '23:00', '07:00')).toBe(true);
    expect(inQuietHours(at(6, 59), '23:00', '07:00')).toBe(true);
    expect(inQuietHours(at(7, 0), '23:00', '07:00')).toBe(false);
    expect(inQuietHours(at(13, 0), '12:00', '14:00')).toBe(true);
    expect(inQuietHours(at(14, 0), '12:00', '14:00')).toBe(false);
    expect(inQuietHours(at(3, 0), '00:00', '00:00')).toBe(false);
  });

  it('scheduler.at runs a wall-clock job when due and reschedules it', async () => {
    let now = Date.UTC(2026, 10, 29, 17, 0);
    const s = new Scheduler(() => now);
    let runs = 0;
    s.at('report', nextWeeklyReport, () => {
      runs++;
    });
    expect(iso(s.nextRunOf('report') ?? 0)).toBe('2026-11-29T18:00:00.000Z');
    now = Date.UTC(2026, 10, 29, 17, 59);
    await s.tick();
    expect(runs).toBe(0);
    now = Date.UTC(2026, 10, 29, 18, 0);
    await s.tick();
    expect(runs).toBe(1);
    expect(iso(s.nextRunOf('report') ?? 0)).toBe('2026-12-06T18:00:00.000Z');
  });
});

describe('configurable time zone (HZ_TIMEZONE)', () => {
  afterEach(() => setTimeZone(DEFAULT_TIME_ZONE));

  it('validates zone names with Intl', () => {
    expect(isValidTimeZone('Europe/Vienna')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    for (const tz of ['', 'Mars/Olympus', 'Europe/Vienna; rm -rf /', 'x'.repeat(65)]) {
      expect(isValidTimeZone(tz), tz).toBe(false);
    }
    expect(() => setTimeZone('Mars/Olympus')).toThrow();
  });

  it('wall-clock times, quiet hours and alert times follow the zone', () => {
    setTimeZone('America/New_York');
    // 04:00 in New York in November is 09:00 UTC.
    expect(iso(fromLocal(2026, 11, 26, 4, 0))).toBe('2026-11-26T09:00:00.000Z');
    const at = Date.UTC(2026, 10, 26, 4, 30);
    expect(localTime(at).hour).toBe(23);
    expect(inQuietHours(at, '23:00', '07:00')).toBe(true);
    expect(clockTime(at)).toBe('23:30');
    expect(iso(nextWallClock(Date.UTC(2026, 10, 26, 12, 0), { hour: 7, minute: 0 }))).toBe(
      '2026-11-27T12:00:00.000Z',
    );
    setTimeZone('UTC');
    expect(localTime(at).hour).toBe(4);
    expect(inQuietHours(at, '23:00', '07:00')).toBe(true);
    expect(clockTime(at)).toBe('04:30');
  });
});

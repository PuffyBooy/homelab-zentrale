import { eq } from 'drizzle-orm';
import { viennaTime } from '../calendar.js';
import type { Db } from '../db/index.js';
import { haEnergyMonths, type HaEnergyMonthRow } from '../db/schema.js';

/** "2026-11" for a timestamp, in Europe/Vienna. */
export function viennaMonth(ms: number): string {
  const w = viennaTime(ms);
  return `${w.year}-${String(w.month).padStart(2, '0')}`;
}

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Meter value in kWh from a sensor state and its unit; null if not usable. */
export function toKwh(state: string, unit: string | null): number | null {
  const v = Number(state);
  if (state.trim() === '' || !Number.isFinite(v)) return null;
  switch (unit) {
    case 'Wh':
      return v / 1000;
    case 'MWh':
      return v * 1000;
    default:
      return v;
  }
}

/** Power in W from a sensor state and its unit; null if not usable. */
export function toWatts(state: string, unit: string | null): number | null {
  const v = Number(state);
  if (state.trim() === '' || !Number.isFinite(v)) return null;
  return unit === 'kW' ? v * 1000 : v;
}

/** Relative drop that counts as a meter reset (HA uses the same 10 %). */
const RESET_DROP = 0.1;

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/**
 * "kWh im Monat" from a total energy meter (state_class total_increasing):
 * current value minus the value at the start of the month (Europe/Vienna).
 *
 * - First reading of a month: the month starts at the last reading of the
 *   previous month (same sensor, not above the current value), else here.
 * - A drop by more than 10 % is a meter reset (to 0, like HA's
 *   total_increasing): the consumption counted so far this month stays and the
 *   new meter value is added. Smaller dips are noise and ignored.
 * - Another sensor than the stored one starts a new baseline.
 */
export class EnergyStore {
  constructor(private readonly db: Db) {}

  private row(month: string): HaEnergyMonthRow | undefined {
    return this.db.select().from(haEnergyMonths).where(eq(haEnergyMonths.month, month)).get();
  }

  record(entityId: string, totalKwh: number, now: number): void {
    const month = viennaMonth(now);
    const row = this.row(month);
    if (!row || row.entityId !== entityId) {
      const prev = this.row(previousMonth(month));
      const start =
        prev && prev.entityId === entityId && prev.lastKwh <= totalKwh ? prev.lastKwh : totalKwh;
      const values = { month, entityId, startKwh: start, lastKwh: totalKwh, updatedAt: now };
      this.db
        .insert(haEnergyMonths)
        .values(values)
        .onConflictDoUpdate({ target: haEnergyMonths.month, set: values })
        .run();
      return;
    }
    if (totalKwh === row.lastKwh) return;
    const set: Partial<HaEnergyMonthRow> = { lastKwh: totalKwh, updatedAt: now };
    if (totalKwh < row.lastKwh) {
      // Like HA's total_increasing: a small dip is noise and ignored; a drop of more
      // than 10 % is a reset to 0, and the new value already counts this month.
      if (totalKwh >= row.lastKwh * (1 - RESET_DROP)) return;
      set.startKwh = -(row.lastKwh - row.startKwh);
    }
    this.db.update(haEnergyMonths).set(set).where(eq(haEnergyMonths.month, month)).run();
  }

  /** kWh of the current month for this sensor, null without a reading this month. */
  monthKwh(entityId: string, now: number): number | null {
    const row = this.row(viennaMonth(now));
    if (!row || row.entityId !== entityId) return null;
    return round(Math.max(0, row.lastKwh - row.startKwh), 3);
  }

  static euro(kwh: number | null, pricePerKwh: number): number | null {
    return kwh === null ? null : round(kwh * pricePerKwh, 2);
  }
}

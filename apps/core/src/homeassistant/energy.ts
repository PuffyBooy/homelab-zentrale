import { eq } from 'drizzle-orm';
import { localTime } from '../calendar.js';
import type { Db } from '../db/index.js';
import { haEnergyMonths, type HaEnergyMonthRow } from '../db/schema.js';

/** "2026-11" for a timestamp, in the configured time zone (HZ_TIMEZONE). */
export function viennaMonth(ms: number): string {
  const w = localTime(ms);
  return `${w.year}-${String(w.month).padStart(2, '0')}`;
}

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export const HA_ENERGY_UNITS = ['Wh', 'kWh', 'MWh'] as const;
export const HA_POWER_UNITS = ['W', 'kW'] as const;

/** Meter value in kWh from a sensor state and its unit; null if not usable or unknown unit. */
export function toKwh(state: string, unit: string | null): number | null {
  const v = Number(state);
  if (state.trim() === '' || !Number.isFinite(v)) return null;
  switch (unit) {
    case 'Wh':
      return v / 1000;
    case 'kWh':
      return v;
    case 'MWh':
      return v * 1000;
    default:
      return null;
  }
}

/** Power in W from a sensor state and its unit; null if not usable or unknown unit. */
export function toWatts(state: string, unit: string | null): number | null {
  const v = Number(state);
  if (state.trim() === '' || !Number.isFinite(v)) return null;
  switch (unit) {
    case 'W':
      return v;
    case 'kW':
      return v * 1000;
    default:
      return null;
  }
}

/** Relative drop that counts as a meter reset (HA uses the same 10 %). */
const RESET_DROP = 0.1;
/**
 * Plausibility cap for a rise between two readings: 100 kWh plus 50 kW times the
 * time since the last reading. A flat uses far less (a 3 x 25 A connection is
 * about 17 kW); the 100 kWh cover meters that report rarely. A larger jump is a
 * glitch (unit flip, wrong value) until the next reading confirms it.
 */
export const MAX_JUMP_KWH = 100;
export const MAX_POWER_KW = 50;
/** A suspicious reading is confirmed by a second one, or by itself after this long. */
export const CONFIRM_AFTER_MS = 5 * 60_000;

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

type Step = 'normal' | 'dip' | 'drop' | 'jump';

function step(from: number, to: number, elapsedMs: number): Step {
  if (to < from) return to >= from * (1 - RESET_DROP) ? 'dip' : 'drop';
  const allowed = MAX_JUMP_KWH + (MAX_POWER_KW * Math.max(0, elapsedMs)) / 3_600_000;
  return to - from > allowed ? 'jump' : 'normal';
}

interface Suspect {
  entityId: string;
  month: string;
  kind: 'drop' | 'jump';
  kwh: number;
  at: number;
}

/**
 * "kWh im Monat" from a total energy meter (state_class total_increasing):
 * current value minus the value at the start of the local month (HZ_TIMEZONE).
 *
 * - First reading of a month: the month starts at the last reading of the
 *   previous month (same sensor, not above the current value), else here.
 * - Small dips (up to 10 %) are noise and ignored.
 * - A drop by more than 10 % or a rise above the plausibility cap is only a
 *   suspect at first and changes nothing. If the next reading is back in line
 *   with the old value, it was a glitch (meter reboot showing 0, a wrong value)
 *   and the old baseline stays. If the next reading continues from the suspect
 *   (or the suspect holds for 5 min), it is confirmed: a drop is a meter reset
 *   to 0 (like HA's total_increasing: the month so far stays and the new value
 *   counts on top), a jump is a new meter (the month so far stays, counting
 *   goes on from the jumped value). Suspects live in memory only.
 * - Another sensor than the stored one starts a new baseline.
 */
export class EnergyStore {
  private suspect: Suspect | null = null;

  constructor(private readonly db: Db) {}

  private row(month: string): HaEnergyMonthRow | undefined {
    return this.db.select().from(haEnergyMonths).where(eq(haEnergyMonths.month, month)).get();
  }

  /** A suspicious reading waits for confirmation (the tick re-records it). */
  hasSuspect(entityId: string): boolean {
    return this.suspect?.entityId === entityId;
  }

  record(entityId: string, totalKwh: number, now: number): void {
    const month = viennaMonth(now);
    const row = this.row(month);
    if (!row || row.entityId !== entityId) {
      this.suspect = null;
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
    const sus =
      this.suspect && this.suspect.entityId === entityId && this.suspect.month === month
        ? this.suspect
        : null;
    if (!sus) this.suspect = null;
    const st = step(row.lastKwh, totalKwh, now - row.updatedAt);
    if (st === 'normal' || st === 'dip') {
      // In line with the stored value: a pending suspect was a glitch.
      this.suspect = null;
      if (st === 'dip' || totalKwh === row.lastKwh) return;
      this.update(month, { lastKwh: totalKwh, updatedAt: now });
      return;
    }
    if (sus && sus.kind === st) {
      const cont = step(sus.kwh, totalKwh, now - sus.at);
      const confirmed =
        cont === 'normal' || cont === 'dip'
          ? totalKwh !== sus.kwh || now - sus.at >= CONFIRM_AFTER_MS
          : false;
      if (confirmed) {
        this.suspect = null;
        const consumed = row.lastKwh - row.startKwh;
        // drop: reset to 0, the new value counts; jump: count on from the jumped value.
        const startKwh = st === 'drop' ? -consumed : sus.kwh - consumed;
        this.update(month, { startKwh, lastKwh: totalKwh, updatedAt: now });
        return;
      }
      if (cont === 'normal' || cont === 'dip') return;
    }
    this.suspect = { entityId, month, kind: st, kwh: totalKwh, at: now };
  }

  private update(month: string, set: Partial<HaEnergyMonthRow>): void {
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

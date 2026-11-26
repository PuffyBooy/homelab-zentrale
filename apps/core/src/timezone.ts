/**
 * The time zone of all wall-clock logic (quiet hours, weekly report, morning digest,
 * wall night mode, daily jobs, export file name, energy month, alert times). Set
 * once at start from HZ_TIMEZONE (config.ts, default Europe/Vienna). Number and
 * date formats stay de-AT regardless of the zone.
 */
export const DEFAULT_TIME_ZONE = 'Europe/Vienna';

let current = DEFAULT_TIME_ZONE;
let generation = 0;

/** True if Intl knows the IANA zone name (e.g. "Europe/Berlin", "UTC"). */
export function isValidTimeZone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function timeZone(): string {
  return current;
}

/** Switches the zone for the whole process (buildApp; tests reset it). */
export function setTimeZone(tz: string): void {
  if (!isValidTimeZone(tz)) throw new Error('invalid time zone');
  if (tz === current) return;
  current = tz;
  generation += 1;
}

/**
 * A DateTimeFormat in the current zone, rebuilt only when the zone changes
 * (formatters are expensive to create).
 */
export function zonedFormat(
  locale: string,
  options: Omit<Intl.DateTimeFormatOptions, 'timeZone'>,
): () => Intl.DateTimeFormat {
  let gen = -1;
  let fmt: Intl.DateTimeFormat | null = null;
  return () => {
    if (fmt === null || gen !== generation) {
      fmt = new Intl.DateTimeFormat(locale, { ...options, timeZone: current });
      gen = generation;
    }
    return fmt;
  };
}

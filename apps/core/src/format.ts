/**
 * German (Austrian) text formatting for status reasons and alerts
 * (design/README.md, "Stimme und Text"): comma decimals, a space before the
 * unit, 24-hour clock in Europe/Vienna.
 */
export const TIME_ZONE = 'Europe/Vienna';

const timeFmt = new Intl.DateTimeFormat('de-AT', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const dateFmt = new Intl.DateTimeFormat('de-AT', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
});
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const decimalFmt = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 1 });

/** `23:04` in Vienna time. */
export function clockTime(ms: number): string {
  return timeFmt.format(ms);
}

/** `23:04`, or `24.11. 23:04` if `ms` is not on the same Vienna day as `now`. */
export function clockTimeRelative(ms: number, now: number): string {
  if (dayKeyFmt.format(ms) === dayKeyFmt.format(now)) return clockTime(ms);
  return `${dateFmt.format(ms)} ${clockTime(ms)}`;
}

/**
 * Percent without decimals, rounded down, so a value at or above a threshold
 * never shows a number below it (95.0 -> `95 %`, 94.99 -> `94 %`).
 */
export function percent(value: number): string {
  return `${Math.floor(value)} %`;
}

const GIB = 1024 ** 3;

/** `2,1 GB` (binary gigabytes, one decimal). */
export function gigabytes(bytes: number): string {
  return `${decimalFmt.format(Math.round((bytes / GIB) * 10) / 10)} GB`;
}

/** `21,4 °C` */
export function celsius(value: number): string {
  return `${decimalFmt.format(Math.round(value * 10) / 10)} °C`;
}

/** `45 s`, `6 Min`, `2 Std 5 Min`, `3 T 4 Std`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} Min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${h} Std` : `${h} Std ${min % 60} Min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} T` : `${d} T ${h % 24} Std`;
}

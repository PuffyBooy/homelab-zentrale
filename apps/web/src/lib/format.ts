/** Austrian formats from the brand book: 23:04, 25.11.2026, "vor 4 Min". */

let zone: string | undefined;
let timeFmt = makeTimeFmt(undefined);
let dateFmt = makeDateFmt(undefined);
let dayFmt = makeDayFmt(undefined);

function makeTimeFmt(timeZone: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('de-AT', {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

function makeDateFmt(timeZone: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('de-AT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** Day and month as numbers, for "today?" and "24.11.". */
function makeDayFmt(timeZone: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
}

function validZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('de-AT', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Zone for all times shown (HZ_TIMEZONE of the core, from GET /api/auth/state).
 * Undefined or unknown: the zone of the device.
 */
export function setDisplayTimeZone(timeZone: string | undefined): void {
  const next = timeZone && validZone(timeZone) ? timeZone : undefined;
  if (next === zone) return;
  zone = next;
  timeFmt = makeTimeFmt(zone);
  dateFmt = makeDateFmt(zone);
  dayFmt = makeDayFmt(zone);
}

export function displayTimeZone(): string | undefined {
  return zone;
}

export function formatTime(d: Date): string {
  return timeFmt.format(d);
}

export function formatDateTime(d: Date): string {
  return `${dateFmt.format(d)} ${timeFmt.format(d)}`;
}

function dayParts(d: Date): { day: number; month: number; year: number } {
  const out = { day: 0, month: 0, year: 0 };
  for (const p of dayFmt.formatToParts(d)) {
    if (p.type === 'day') out.day = Number(p.value);
    else if (p.type === 'month') out.month = Number(p.value);
    else if (p.type === 'year') out.year = Number(p.value);
  }
  return out;
}

export function formatAgo(d: Date, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return 'gerade eben';
  const m = Math.floor(s / 60);
  if (m < 60) return `vor ${m} Min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} Std`;
  const days = Math.floor(h / 24);
  return days === 1 ? 'vor 1 Tag' : `vor ${days} Tagen`;
}

/** Minutes until retry, at least 1 ("Wieder möglich in 3 Min."). */
export function retryMinutes(retryAfterSeconds: number | undefined): number {
  if (!retryAfterSeconds || retryAfterSeconds <= 0) return 1;
  return Math.max(1, Math.ceil(retryAfterSeconds / 60));
}

/** Short device name from a user agent, e.g. "Firefox · Linux". */
export function describeUserAgent(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} · ${os}`;
  return browser ?? os ?? (ua.trim().slice(0, 40) || 'Unbekanntes Gerät');
}

// ---------------------------------------------------------------------------
// Numbers and units (brand book: "7,8 GB", "23 %", "21,4 °C").

const numFmt = new Map<number, Intl.NumberFormat>();
function nf(digits: number): Intl.NumberFormat {
  let f = numFmt.get(digits);
  if (!f) {
    f = new Intl.NumberFormat('de-AT', {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
      useGrouping: false,
    });
    numFmt.set(digits, f);
  }
  return f;
}

/** Decimal comma, at most `digits` fraction digits, no grouping: 7,8 · 1024 · 0. */
export function formatNumber(v: number, digits = 1): string {
  // Intl prints "-0" for tiny negatives.
  const r = Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v;
  return nf(digits).format(r);
}

/** de-AT with a dot as group separator (Intl uses a narrow space for de-AT): "1.024", "1.234,5". */
export function formatGrouped(v: number, minDigits: number, maxDigits: number): string {
  return new Intl.NumberFormat('de-AT', {
    minimumFractionDigits: minDigits,
    maximumFractionDigits: maxDigits,
    useGrouping: true,
  })
    .formatToParts(v)
    .map((p) => (p.type === 'group' ? '.' : p.value))
    .join('');
}

/** "23 %", rounded to whole percent. Null-safe: "—". */
export function formatPercent(v: number | null | undefined): string {
  return v == null ? '—' : `${formatNumber(Math.round(v), 0)} %`;
}

/** "21,4 °C". */
export function formatTemp(v: number | null | undefined): string {
  return v == null ? '—' : `${formatNumber(v, 1)} °C`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

function byteParts(bytes: number): { value: number; unit: string } {
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return { value: v, unit: UNITS[i] ?? 'B' };
}

/** "7,8 GB", "512 MB", "0 B". Binary steps (like df -h), one decimal below 100. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const { value, unit } = byteParts(bytes);
  return `${formatNumber(value, value >= 100 || unit === 'B' ? 0 : 1)} ${unit}`;
}

/** "5,8 / 8 GB": both values in the unit of the total. */
export function formatBytesOf(used: number, total: number): string {
  const { unit } = byteParts(total);
  const div = 1024 ** UNITS.indexOf(unit as (typeof UNITS)[number]);
  const digits = (n: number): number => (n >= 100 || unit === 'B' ? 0 : 1);
  const u = used / div;
  const t = total / div;
  return `${formatNumber(u, digits(u))} / ${formatNumber(t, digits(t))} ${unit}`;
}

/** Network rate: "1,2 MB/s", "340 KB/s". */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Uptime "12 T 4 h", "4 h 12 Min", "12 Min". */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return h % 24 ? `${d} T ${h % 24} h` : `${d} T`;
  if (h > 0) return m % 60 ? `${h} h ${m % 60} Min` : `${h} h`;
  return `${m} Min`;
}

/** Short uptime for narrow list columns: "41 T", "4 h", "12 Min". */
export function formatUptimeShort(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d} T`;
  if (h > 0) return `${h} h`;
  return `${m} Min`;
}

/** "23:04" for today, "24.11. 23:04" for other days. */
export function formatWhen(d: Date, now: Date = new Date()): string {
  const a = dayParts(d);
  const b = dayParts(now);
  if (a.day === b.day && a.month === b.month && a.year === b.year) return formatTime(d);
  const day = String(a.day).padStart(2, '0');
  const month = String(a.month).padStart(2, '0');
  return `${day}.${month}. ${formatTime(d)}`;
}

/** Plural helper: plural(1, 'Problem', 'Probleme') -> "1 Problem". */
export function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n, 0)} ${n === 1 ? one : many}`;
}

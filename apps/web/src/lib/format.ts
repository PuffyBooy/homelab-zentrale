/** Austrian formats from the brand book: 23:04, 25.11.2026, "vor 4 Min". */

const timeFmt = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('de-AT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export function formatTime(d: Date): string {
  return timeFmt.format(d);
}

export function formatDateTime(d: Date): string {
  return `${dateFmt.format(d)} ${timeFmt.format(d)}`;
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

import { isIP } from 'node:net';

/**
 * Domain expiry over RDAP (rdap.org bootstraps to the registry). Runs daily at
 * 04:00 Vienna time; failures are tolerated (the value just stays unknown).
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const RDAP_BASE = 'https://rdap.org/domain/';
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

/**
 * Public suffixes with two labels that are common for Alex' domains. Without a
 * full public suffix list, `a.b.co.at` becomes `b.co.at`, everything else the
 * last two labels.
 */
const TWO_LABEL_SUFFIXES = new Set([
  'co.at',
  'or.at',
  'gv.at',
  'ac.at',
  'priv.at',
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'co.jp',
  'com.tr',
  'com.cn',
]);

/** Hosts that never have a public registration. */
const PRIVATE_SUFFIXES = [
  '.ts.net',
  '.local',
  '.localhost',
  '.lan',
  '.home',
  '.internal',
  '.home.arpa',
  '.intranet',
  '.corp',
  '.test',
  '.example',
  '.invalid',
];

/** Registrable domain for an RDAP lookup, or null (IP, tailnet, local names). */
export function registrableDomain(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || isIP(host.replace(/^\[|\]$/g, '')) !== 0) return null;
  if (!host.includes('.')) return null;
  if (
    host === 'localhost' ||
    PRIVATE_SUFFIXES.some((s) => host.endsWith(s) || host === s.slice(1))
  ) {
    return null;
  }
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const labels = host.split('.');
  if (labels.some((l) => l === '')) return null;
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.length >= 3 ? labels.slice(-3).join('.') : null;
  }
  return lastTwo;
}

async function readLimited(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface RdapEvent {
  eventAction?: unknown;
  eventDate?: unknown;
}

/** Expiry from an RDAP domain object, or null. */
export function expiryFromRdap(json: unknown): number | null {
  if (typeof json !== 'object' || json === null || !('events' in json)) return null;
  const events = (json as { events: unknown }).events;
  if (!Array.isArray(events)) return null;
  for (const e of events as RdapEvent[]) {
    if (e?.eventAction === 'expiration' && typeof e.eventDate === 'string') {
      const t = Date.parse(e.eventDate);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

/**
 * Looks up the expiry date. Follows redirects manually, https only. Returns
 * null on any failure (network, 404, unexpected JSON).
 */
export async function lookupDomainExpiry(
  domain: string,
  fetchImpl: FetchLike = fetch,
): Promise<number | null> {
  let url = `${RDAP_BASE}${encodeURIComponent(domain)}`;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchImpl(url, {
        redirect: 'manual',
        headers: { accept: 'application/rdap+json, application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel();
        if (!loc) return null;
        const next = new URL(loc, url);
        if (next.protocol !== 'https:') return null;
        url = next.toString();
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        return null;
      }
      const text = await readLimited(res);
      if (text === null) return null;
      return expiryFromRdap(JSON.parse(text));
    }
    return null;
  } catch {
    return null;
  }
}

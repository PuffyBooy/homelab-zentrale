import { z } from 'zod';
import type { FetchLike } from '../checks/rdap.js';

/**
 * M15 DNS providers for fixed game addresses (A record -> ingress IPv4).
 *
 * Only two hosts are ever contacted: api.cloudflare.com and www.duckdns.org
 * (checked before every request), redirects are refused, every request has a
 * 10 s timeout, answers are parsed with zod and capped in size. The token is
 * never part of an error: errors carry fixed German texts only (never the URL,
 * which contains the DuckDNS token, and never the provider's message).
 */

export const DNS_TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 256 * 1024;
export const DNS_HOSTS: ReadonlySet<string> = new Set(['api.cloudflare.com', 'www.duckdns.org']);
const CLOUDFLARE_BASE = 'https://api.cloudflare.com/client/v4/zones/';
const DUCKDNS_UPDATE = 'https://www.duckdns.org/update';

export type DnsProvider = 'cloudflare' | 'duckdns';

export interface DnsConfig {
  provider: DnsProvider;
  token: string;
  /** Cloudflare zone id (32 hex), null for DuckDNS. */
  zoneId: string | null;
}

/** Failure with a fixed German text (safe for API, log and audit). */
export class DnsError extends Error {
  constructor(public readonly text: string) {
    super('dns_failed');
    this.name = 'DnsError';
  }
}

const ZONE_RE = /^[0-9a-f]{32}$/;
const RECORD_ID_RE = /^[0-9a-f]{32}$/;
const DUCK_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.duckdns\.org$/;

/** "<sub>.duckdns.org" -> "<sub>", null for other names (nested names are refused too). */
export function duckSubdomain(name: string): string | null {
  return DUCK_RE.exec(name)?.[1] ?? null;
}

/** Whether `name` can be managed by the provider. */
export function nameAllowed(provider: DnsProvider, name: string): boolean {
  return provider === 'duckdns' ? duckSubdomain(name) !== null : true;
}

const cfRecordSchema = z.object({
  id: z.string().regex(RECORD_ID_RE),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean().optional(),
  ttl: z.number().optional(),
});
const cfListSchema = z.object({ success: z.boolean(), result: z.array(cfRecordSchema).nullable() });
const cfWriteSchema = z.object({ success: z.boolean(), result: cfRecordSchema.nullable() });
const cfDeleteSchema = z.object({ success: z.boolean() });

async function request(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<string> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new DnsError('DNS-Anbieter nicht erreichbar');
  }
  if (!url.startsWith('https://') || !DNS_HOSTS.has(host)) {
    throw new DnsError('DNS-Anbieter nicht erlaubt');
  }
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
    });
  } catch {
    throw new DnsError('DNS-Anbieter nicht erreichbar');
  }
  if (res.status === 401 || res.status === 403) {
    throw new DnsError('DNS-Anbieter lehnt das Token ab');
  }
  const text = await readLimited(res);
  if (!res.ok) throw new DnsError(`DNS-Anbieter antwortet mit ${res.status}`);
  return text;
}

/** Reads at most MAX_ANSWER_BYTES (Content-Length checked first, then while streaming). */
async function readLimited(res: Response): Promise<string> {
  const tooLarge = () => new DnsError('Ungültige Antwort des DNS-Anbieters');
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ANSWER_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      parts.push(value);
    }
  } catch (err) {
    if (err instanceof DnsError) throw err;
    throw new DnsError('DNS-Anbieter nicht erreichbar');
  }
  return Buffer.concat(parts).toString('utf8');
}

function parseJson<T>(schema: z.ZodType<T>, text: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DnsError('Ungültige Antwort des DNS-Anbieters');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new DnsError('Ungültige Antwort des DNS-Anbieters');
  return parsed.data;
}

function cloudflareBase(cfg: DnsConfig): { base: string; headers: Record<string, string> } {
  if (cfg.zoneId === null || !ZONE_RE.test(cfg.zoneId)) {
    throw new DnsError('Cloudflare-Zone fehlt');
  }
  return {
    base: `${CLOUDFLARE_BASE}${cfg.zoneId}/dns_records`,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
  };
}

async function cloudflareFind(fetchImpl: FetchLike, cfg: DnsConfig, name: string) {
  const { base, headers } = cloudflareBase(cfg);
  const query = new URLSearchParams({ type: 'A', name });
  const list = parseJson(
    cfListSchema,
    await request(fetchImpl, `${base}?${query.toString()}`, { method: 'GET', headers }),
  );
  if (!list.success) throw new DnsError('Cloudflare hat die Anfrage abgelehnt');
  return (list.result ?? []).find((r) => r.type === 'A' && r.name === name);
}

async function cloudflareSetA(
  fetchImpl: FetchLike,
  cfg: DnsConfig,
  name: string,
  ip: string,
): Promise<void> {
  const { base, headers } = cloudflareBase(cfg);
  const existing = await cloudflareFind(fetchImpl, cfg, name);
  if (existing && existing.content === ip && existing.proxied !== true && existing.ttl === 60) {
    return;
  }
  const body = JSON.stringify({ type: 'A', name, content: ip, ttl: 60, proxied: false });
  const written = parseJson(
    cfWriteSchema,
    await request(fetchImpl, existing ? `${base}/${existing.id}` : base, {
      method: existing ? 'PUT' : 'POST',
      headers,
      body,
    }),
  );
  if (!written.success || written.result?.content !== ip) {
    throw new DnsError('Cloudflare hat die Änderung abgelehnt');
  }
}

async function duckdnsSetA(
  fetchImpl: FetchLike,
  cfg: DnsConfig,
  name: string,
  ip: string,
): Promise<void> {
  const sub = duckSubdomain(name);
  if (sub === null) throw new DnsError('Nur Namen unter duckdns.org möglich');
  const query = new URLSearchParams({ domains: sub, token: cfg.token, ip });
  const text = await request(fetchImpl, `${DUCKDNS_UPDATE}?${query.toString()}`, {
    method: 'GET',
    headers: { accept: 'text/plain' },
  });
  if (text.trim() !== 'OK') throw new DnsError('DuckDNS hat die Änderung abgelehnt');
}

/** Points `name` (A record) to `ip`. Throws DnsError with a fixed text. */
export async function setARecord(
  fetchImpl: FetchLike,
  cfg: DnsConfig,
  name: string,
  ip: string,
): Promise<void> {
  if (cfg.provider === 'cloudflare') await cloudflareSetA(fetchImpl, cfg, name, ip);
  else await duckdnsSetA(fetchImpl, cfg, name, ip);
}

/**
 * Removes the A record of `name`, but only if it still points to `ip` (the value
 * the core set). Cloudflare only: DuckDNS has no delete, its record stays.
 * Returns whether a record was deleted.
 */
export async function deleteARecord(
  fetchImpl: FetchLike,
  cfg: DnsConfig,
  name: string,
  ip: string,
): Promise<boolean> {
  if (cfg.provider !== 'cloudflare') return false;
  const existing = await cloudflareFind(fetchImpl, cfg, name);
  if (!existing || existing.content !== ip) return false;
  const { base, headers } = cloudflareBase(cfg);
  const done = parseJson(
    cfDeleteSchema,
    await request(fetchImpl, `${base}/${existing.id}`, { method: 'DELETE', headers }),
  );
  if (!done.success) throw new DnsError('Cloudflare hat das Löschen abgelehnt');
  return true;
}

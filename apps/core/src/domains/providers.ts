import { z } from 'zod';
import { fqdnSchema, nameInZone, type DnsProviderKind, type DnsRecordType } from '@hz/shared';
import { DomainsHttpError, type DomainsHttp, type HttpResult } from './http.js';

/**
 * DNS provider adapters (Cloudflare API v4, DuckDNS). The token only ever goes
 * into the Authorization header (Cloudflare) or the query of the DuckDNS update
 * URL; it never appears in an error, a log line or a return value.
 */

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
export const DUCKDNS_UPDATE = 'https://www.duckdns.org/update';
export const DUCKDNS_SUFFIX = '.duckdns.org';
const CF_MAX_ZONE_PAGES = 2;

/** Expected failure with a short German reason (safe to show and store). */
export class ProviderError extends Error {
  constructor(
    public readonly reason: string,
    /** The provider rejected the token (401/403, DuckDNS "KO"). */
    public readonly auth = false,
  ) {
    super('provider_error');
    this.name = 'ProviderError';
  }
}

export function reasonOf(err: unknown): string {
  if (err instanceof ProviderError || err instanceof DomainsHttpError) return err.reason;
  return 'Unbekannter Fehler';
}

export interface RecordValue {
  name: string;
  type: DnsRecordType;
  value: string;
  ttl: number;
  proxied: boolean;
}

export interface ProviderRecord {
  id: string;
  value: string;
}

export interface ProviderConfig {
  tokenHint?: string;
  /** DuckDNS. */
  subdomains?: string[];
  /** Cloudflare: zone name -> zone id. */
  zoneIds?: Record<string, string>;
}

export interface VerifyResult {
  zones: string[];
  config: ProviderConfig;
}

export interface DnsApi {
  /** Checks the token; returns the zones it can edit. */
  verify(): Promise<VerifyResult>;
  /** Records of exactly this name and type at the provider. */
  find(name: string, type: DnsRecordType): Promise<ProviderRecord[]>;
  /** Returns the provider record id. */
  create(rec: RecordValue): Promise<string>;
  /** 'missing' when the record no longer exists at the provider. */
  update(id: string, rec: RecordValue): Promise<'ok' | 'missing'>;
  /** Missing is success. */
  remove(id: string, rec: Pick<RecordValue, 'name' | 'type'>): Promise<void>;
  /** Sets a TXT record (ACME DNS-01); returns a handle for removeTxt. */
  addTxt(name: string, value: string): Promise<string>;
  removeTxt(name: string, handle: string): Promise<void>;
}

// ---- Cloudflare ------------------------------------------------------------------

const cfEnvelope = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  result_info: z.object({ total_pages: z.number().int().optional() }).nullish(),
});
const cfZone = z.object({ id: z.string().regex(/^[A-Za-z0-9]{1,64}$/), name: z.string() });
const cfRecord = z.object({
  id: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
  content: z.string().max(4096),
});
const cfVerify = z.object({ status: z.string() });

function parseEnvelope(text: string): z.infer<typeof cfEnvelope> | null {
  try {
    const parsed = cfEnvelope.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function cfStatusReason(status: number): ProviderError {
  if (status === 401 || status === 403)
    return new ProviderError('Token ungültig oder ohne Berechtigung', true);
  if (status === 404) return new ProviderError('Bei Cloudflare nicht gefunden');
  if (status === 429) return new ProviderError('Cloudflare-Rate-Limit erreicht');
  if (status === 400) return new ProviderError('Cloudflare hat die Anfrage abgelehnt');
  return new ProviderError(`Cloudflare-Fehler (HTTP ${status})`);
}

export class CloudflareApi implements DnsApi {
  constructor(
    private readonly http: DomainsHttp,
    private readonly token: string,
    private readonly zoneIds: Record<string, string>,
  ) {}

  private async call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ res: HttpResult; data: z.infer<typeof cfEnvelope> | null }> {
    const res = await this.http.request(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { res, data: parseEnvelope(res.text) };
  }

  private async ok(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<z.infer<typeof cfEnvelope>> {
    const { res, data } = await this.call(method, path, body);
    if (res.status < 200 || res.status >= 300) throw cfStatusReason(res.status);
    if (!data?.success) throw new ProviderError('Unerwartete Antwort von Cloudflare');
    return data;
  }

  async verify(): Promise<VerifyResult> {
    const v = await this.ok('GET', '/user/tokens/verify');
    const parsed = cfVerify.safeParse(v.result);
    if (!parsed.success || parsed.data.status !== 'active')
      throw new ProviderError('Token ist nicht aktiv', true);
    const zoneIds: Record<string, string> = {};
    for (let page = 1; page <= CF_MAX_ZONE_PAGES; page++) {
      const r = await this.ok('GET', `/zones?per_page=50&page=${page}`);
      const list = z.array(cfZone).safeParse(r.result);
      if (!list.success) throw new ProviderError('Unerwartete Antwort von Cloudflare');
      for (const zone of list.data) {
        const name = zone.name.toLowerCase();
        if (fqdnSchema.safeParse(name).success && !name.startsWith('*.')) zoneIds[name] = zone.id;
      }
      if ((r.result_info?.total_pages ?? 1) <= page) break;
    }
    const zones = Object.keys(zoneIds).sort().slice(0, 100);
    return { zones, config: { zoneIds } };
  }

  private zoneId(name: string): string {
    let best: string | null = null;
    for (const zone of Object.keys(this.zoneIds)) {
      if (nameInZone(name, zone) && (best === null || zone.length > best.length)) best = zone;
    }
    const id = best === null ? undefined : this.zoneIds[best];
    if (id === undefined) throw new ProviderError('Name liegt in keiner Zone des Tokens');
    return id;
  }

  async find(name: string, type: DnsRecordType | 'TXT'): Promise<ProviderRecord[]> {
    const zid = this.zoneId(name);
    const q = new URLSearchParams({ name, type, per_page: '100' });
    const r = await this.ok('GET', `/zones/${zid}/dns_records?${q.toString()}`);
    const list = z.array(cfRecord).safeParse(r.result);
    if (!list.success) throw new ProviderError('Unerwartete Antwort von Cloudflare');
    return list.data.map((x) => ({ id: x.id, value: x.content }));
  }

  private body(rec: RecordValue): Record<string, unknown> {
    return {
      type: rec.type,
      name: rec.name,
      content: rec.value,
      ttl: rec.ttl,
      proxied: rec.proxied,
    };
  }

  async create(rec: RecordValue): Promise<string> {
    const r = await this.ok('POST', `/zones/${this.zoneId(rec.name)}/dns_records`, this.body(rec));
    const parsed = cfRecord.safeParse(r.result);
    if (!parsed.success) throw new ProviderError('Unerwartete Antwort von Cloudflare');
    return parsed.data.id;
  }

  async update(id: string, rec: RecordValue): Promise<'ok' | 'missing'> {
    const path = `/zones/${this.zoneId(rec.name)}/dns_records/${encodeURIComponent(id)}`;
    const { res, data } = await this.call('PUT', path, this.body(rec));
    if (res.status === 404) return 'missing';
    if (res.status < 200 || res.status >= 300) throw cfStatusReason(res.status);
    if (!data?.success) throw new ProviderError('Unerwartete Antwort von Cloudflare');
    return 'ok';
  }

  async remove(id: string, rec: Pick<RecordValue, 'name'>): Promise<void> {
    const path = `/zones/${this.zoneId(rec.name)}/dns_records/${encodeURIComponent(id)}`;
    const { res } = await this.call('DELETE', path);
    if (res.status === 404) return;
    if (res.status < 200 || res.status >= 300) throw cfStatusReason(res.status);
  }

  async addTxt(name: string, value: string): Promise<string> {
    const r = await this.ok('POST', `/zones/${this.zoneId(name)}/dns_records`, {
      type: 'TXT',
      name,
      content: value,
      ttl: 60,
    });
    const parsed = cfRecord.safeParse(r.result);
    if (!parsed.success) throw new ProviderError('Unerwartete Antwort von Cloudflare');
    return parsed.data.id;
  }

  async removeTxt(name: string, handle: string): Promise<void> {
    await this.remove(handle, { name });
  }
}

// ---- DuckDNS ---------------------------------------------------------------------

/** "<sub>.duckdns.org" or "_acme-challenge.<sub>.duckdns.org" -> "<sub>". */
export function duckSubdomain(name: string, subdomains: readonly string[]): string | null {
  if (!name.endsWith(DUCKDNS_SUFFIX)) return null;
  const labels = name.slice(0, -DUCKDNS_SUFFIX.length).split('.');
  const sub = labels[labels.length - 1] ?? '';
  return subdomains.includes(sub) ? sub : null;
}

/**
 * DuckDNS has no record ids and no listing: a subdomain belongs to the token's
 * account and carries one A, one AAAA and one TXT value. The provider record id
 * is always "duckdns". Deleting clears both addresses (DuckDNS has no per-type
 * clear); the service pushes a remaining sibling record again.
 */
export class DuckDnsApi implements DnsApi {
  constructor(
    private readonly http: DomainsHttp,
    private readonly token: string,
    private readonly subdomains: readonly string[],
  ) {}

  private async send(params: Record<string, string>): Promise<void> {
    const q = new URLSearchParams({ ...params, token: this.token });
    const res = await this.http.request(`${DUCKDNS_UPDATE}?${q.toString()}`, {
      method: 'GET',
      headers: { accept: 'text/plain' },
    });
    if (res.status !== 200) throw new ProviderError(`DuckDNS-Fehler (HTTP ${res.status})`);
    const body = res.text.trim().split('\n')[0]?.trim();
    if (body === 'KO')
      throw new ProviderError('DuckDNS hat abgelehnt (Token oder Subdomain falsch)', true);
    if (body !== 'OK') throw new ProviderError('Unerwartete Antwort von DuckDNS');
  }

  private sub(name: string): string {
    const s = duckSubdomain(name, this.subdomains);
    if (s === null) throw new ProviderError('Name gehört zu keiner Subdomain des Tokens');
    return s;
  }

  private addressParams(rec: RecordValue): Record<string, string> {
    const domains = this.sub(rec.name);
    if (rec.type === 'A') return { domains, ip: rec.value };
    if (rec.type === 'AAAA') return { domains, ipv6: rec.value };
    throw new ProviderError('DuckDNS kann nur A und AAAA');
  }

  async verify(): Promise<VerifyResult> {
    // Clearing the TXT value is the only DuckDNS call that checks token and
    // subdomains without touching an address.
    await this.send({ domains: this.subdomains.join(','), txt: 'removed', clear: 'true' });
    return {
      zones: this.subdomains.map((s) => `${s}${DUCKDNS_SUFFIX}`),
      config: { subdomains: [...this.subdomains] },
    };
  }

  find(): Promise<ProviderRecord[]> {
    return Promise.resolve([]);
  }

  async create(rec: RecordValue): Promise<string> {
    await this.send(this.addressParams(rec));
    return 'duckdns';
  }

  async update(_id: string, rec: RecordValue): Promise<'ok' | 'missing'> {
    await this.send(this.addressParams(rec));
    return 'ok';
  }

  async remove(_id: string, rec: Pick<RecordValue, 'name'>): Promise<void> {
    await this.send({ domains: this.sub(rec.name), clear: 'true' });
  }

  async addTxt(name: string, value: string): Promise<string> {
    await this.send({ domains: this.sub(name), txt: value });
    return 'duckdns';
  }

  async removeTxt(name: string): Promise<void> {
    await this.send({ domains: this.sub(name), txt: 'removed', clear: 'true' });
  }
}

export function providerApi(
  http: DomainsHttp,
  kind: DnsProviderKind,
  token: string,
  config: ProviderConfig,
): DnsApi {
  if (kind === 'cloudflare') return new CloudflareApi(http, token, config.zoneIds ?? {});
  return new DuckDnsApi(http, token, config.subdomains ?? []);
}

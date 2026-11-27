import {
  CERT_CRIT_DAYS,
  CERT_RENEW_DAYS,
  CERT_WARN_DAYS,
  certNameSchema,
  certificateSchema,
  dnsProviderSchema,
  dnsProviderTestResponseSchema,
  dnsRecordSchema,
  domainSettingsSchema,
  domainsResponseSchema,
  fqdnSchema,
  nameInZone,
  type AcmeCa,
  type CertStatus,
  type Certificate,
  type CertificateCreate,
  type DnsProvider,
  type DnsProviderCreate,
  type DnsProviderKind,
  type DnsRecord,
  type DnsRecordCreate,
  type DnsRecordType,
  type DomainSettings,
  type DomainsResponse,
  type ServerSummary,
} from '@hz/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Status } from '@hz/ui';
import { api } from './api.js';
import { formatDateTime, formatNumber, plural } from './format.js';

/** M20 "Domains und Zertifikate" (packages/shared/src/api/domains.ts). */

export { CERT_RENEW_DAYS, CERT_WARN_DAYS, nameInZone };
export type { Certificate, DnsProvider, DnsRecord, DomainsResponse };

export const domainsKey = ['domains'] as const;

const enc = encodeURIComponent;
const noBody = { parse: (d: unknown): unknown => d };
type Out<S> = S extends { parse(data: unknown): infer T } ? T : never;
export type DnsProviderTest = Out<typeof dnsProviderTestResponseSchema>;
export type CertDeployTarget = { serverId: string; name: string };

export function fetchDomains(signal?: AbortSignal): Promise<DomainsResponse> {
  return api('/api/domains', { schema: domainsResponseSchema, signal });
}

export function saveDomainSettings(body: DomainSettings): Promise<DomainSettings> {
  return api('/api/domains/settings', { method: 'PUT', body, schema: domainSettingsSchema });
}

/** Step-up (api() asks). The token goes to the core only, never back. */
export function createProvider(body: DnsProviderCreate): Promise<DnsProvider> {
  return api('/api/domains/providers', { method: 'POST', body, schema: dnsProviderSchema });
}

/** Step-up. */
export function updateProvider(
  id: string,
  body: { label?: string; token?: string; subdomains?: string[] },
): Promise<DnsProvider> {
  return api(`/api/domains/providers/${enc(id)}`, {
    method: 'PUT',
    body,
    schema: dnsProviderSchema,
  });
}

/** Step-up; 409 while records or certificates use it. */
export async function deleteProvider(id: string): Promise<void> {
  await api(`/api/domains/providers/${enc(id)}`, { method: 'DELETE', schema: noBody });
}

export function testProvider(id: string): Promise<DnsProviderTest> {
  return api(`/api/domains/providers/${enc(id)}/test`, {
    method: 'POST',
    body: {},
    schema: dnsProviderTestResponseSchema,
  });
}

export function createRecord(body: DnsRecordCreate): Promise<DnsRecord> {
  return api('/api/domains/records', { method: 'POST', body, schema: dnsRecordSchema });
}

export function updateRecord(
  id: string,
  body: Partial<Pick<DnsRecordCreate, 'target' | 'ttl' | 'proxied'>>,
): Promise<DnsRecord> {
  return api(`/api/domains/records/${enc(id)}`, { method: 'PUT', body, schema: dnsRecordSchema });
}

export async function deleteRecord(id: string): Promise<void> {
  await api(`/api/domains/records/${enc(id)}`, { method: 'DELETE', schema: noBody });
}

export function syncRecord(id: string): Promise<DnsRecord> {
  return api(`/api/domains/records/${enc(id)}/sync`, {
    method: 'POST',
    body: {},
    schema: dnsRecordSchema,
  });
}

/** Step-up. */
export function createCertificate(body: CertificateCreate): Promise<Certificate> {
  return api('/api/domains/certificates', { method: 'POST', body, schema: certificateSchema });
}

/**
 * True when `next` adds a target (serverId + name) the certificate is not deployed to yet:
 * the core then asks for step-up (403 step_up_required, api() asks for the code and repeats).
 */
export function deployAddsTarget(
  cert: Pick<Certificate, 'deploy'>,
  next: readonly CertDeployTarget[],
): boolean {
  const known = new Set(cert.deploy.map((d) => `${d.serverId}/${d.name}`));
  return next.some((d) => !known.has(`${d.serverId}/${d.name}`));
}

/** Step-up when deploy adds a target (deployAddsTarget). */
export function updateCertificate(
  id: string,
  body: { autoRenew?: boolean; deploy?: CertDeployTarget[] },
): Promise<Certificate> {
  return api(`/api/domains/certificates/${enc(id)}`, {
    method: 'PUT',
    body,
    schema: certificateSchema,
  });
}

export function renewCertificate(id: string): Promise<Certificate> {
  return api(`/api/domains/certificates/${enc(id)}/renew`, {
    method: 'POST',
    body: {},
    schema: certificateSchema,
  });
}

/** Step-up; removes the files on the servers too. */
export async function deleteCertificate(id: string): Promise<void> {
  await api(`/api/domains/certificates/${enc(id)}`, { method: 'DELETE', schema: noBody });
}

// ---------------------------------------------------------------------------
// Texts (pure, unit tested)

export const PROVIDER_LABEL: Record<DnsProviderKind, string> = {
  cloudflare: 'Cloudflare',
  duckdns: 'DuckDNS',
};

export const CA_LABEL: Record<AcmeCa, string> = {
  letsencrypt: 'Let’s Encrypt',
  'letsencrypt-staging': 'Let’s Encrypt Staging (zum Testen)',
};

export const RECORD_TYPES: readonly DnsRecordType[] = ['A', 'AAAA', 'CNAME'];

export const RECORD_STATUS: Record<DnsRecord['status'], Status> = {
  ok: 'ok',
  pending: 'busy',
  error: 'crit',
};

export const RECORD_STATUS_TEXT: Record<DnsRecord['status'], string> = {
  ok: 'aktuell',
  pending: 'wird gesetzt',
  error: 'Fehler',
};

export const CERT_STATUS_TEXT: Record<CertStatus, string> = {
  pending: 'wird ausgestellt',
  valid: 'gültig',
  renewing: 'wird erneuert',
  error: 'Fehler',
  expired: 'abgelaufen',
};

const DAY = 86_400_000;

/** Whole days until `at` (negative when past). */
export function daysLeft(at: number, now: Date): number {
  return Math.floor((at - now.getTime()) / DAY);
}

/** Status with shape: valid but close to expiry turns warn, then crit. */
export function certStatus(c: Pick<Certificate, 'status' | 'notAfter'>, now: Date): Status {
  if (c.status === 'pending' || c.status === 'renewing') return 'busy';
  if (c.status === 'error' || c.status === 'expired') return 'crit';
  if (c.notAfter == null) return 'info';
  const d = daysLeft(c.notAfter, now);
  if (d < 0 || d <= CERT_CRIT_DAYS) return 'crit';
  if (d <= CERT_WARN_DAYS) return 'warn';
  return 'ok';
}

/** "läuft ab am 24.02.2027 04:00 · in 90 Tagen", "abgelaufen seit 3 Tagen". */
export function expiryText(notAfter: number | null, now: Date): string {
  if (notAfter == null) return 'noch nicht ausgestellt';
  const d = daysLeft(notAfter, now);
  const when = formatDateTime(new Date(notAfter));
  if (d < 0) return `abgelaufen am ${when}`;
  if (d === 0) return `läuft heute ab (${when})`;
  return `läuft ab am ${when} · in ${plural(d, 'Tag', 'Tagen')}`;
}

/** "öffentliche IP von heimserver", "fest 203.0.113.7". */
export function targetText(
  r: Pick<DnsRecord, 'target'>,
  servers: readonly Pick<ServerSummary, 'id' | 'name'>[],
): string {
  if (r.target.kind === 'static') return `fest ${r.target.value}`;
  const id = r.target.serverId;
  const name = servers.find((s) => s.id === id)?.name ?? id;
  return `öffentliche IP von ${name}`;
}

/** "TTL 5 Min", "TTL 1 Std". */
export function ttlText(ttl: number): string {
  if (ttl % 3600 === 0) return `TTL ${formatNumber(ttl / 3600, 0)} Std`;
  if (ttl % 60 === 0) return `TTL ${formatNumber(ttl / 60, 0)} Min`;
  return `TTL ${formatNumber(ttl, 0)} s`;
}

/** "a.example.com, *.example.com" -> list; null entries are invalid. */
export function parseNames(raw: string): { names: string[]; bad: string[] } {
  const parts = raw
    .split(/[,\s]+/)
    .map((p) => p.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
  const names: string[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    if (fqdnSchema.safeParse(p).success) names.push(p);
    else bad.push(p);
  }
  return { names: [...new Set(names)], bad };
}

export function isFqdn(v: string): boolean {
  return fqdnSchema.safeParse(v).success;
}

export function isCertName(v: string): boolean {
  return certNameSchema.safeParse(v).success;
}

/** Folder name below /opt/homelab/certs/ from the first name: "*.example.com" -> "example-com". */
export function defaultCertName(names: readonly string[]): string {
  const first = (names[0] ?? '').replace(/^\*\./, '');
  const slug = first
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return isCertName(slug) ? slug : 'cert';
}

/** Zone of the provider the name lies in, if any. */
export function zoneOf(name: string, p: Pick<DnsProvider, 'zones'>): string | undefined {
  return p.zones.find((z) => nameInZone(name, z));
}

/** Statussatz of the domains part: problems first. */
export function domainsSentence(
  d: DomainsResponse | undefined,
  now: Date,
): { em: string | null; rest: string } {
  if (!d) return { em: null, rest: 'Domains' };
  const badCerts = d.certificates.filter((c) => certStatus(c, now) === 'crit');
  const warnCerts = d.certificates.filter((c) => certStatus(c, now) === 'warn');
  const badRecords = d.records.filter((r) => r.status === 'error');
  const oneCert =
    badCerts.length + warnCerts.length === 1 ? (badCerts[0] ?? warnCerts[0]) : undefined;
  if (oneCert && badRecords.length === 0) {
    const name = oneCert.names[0] ?? 'Zertifikat';
    if (oneCert.notAfter != null && oneCert.status === 'valid') {
      return {
        em: `Zertifikat ${name} läuft in ${plural(Math.max(0, daysLeft(oneCert.notAfter, now)), 'Tag', 'Tagen')} ab`,
        rest: '',
      };
    }
    return { em: `Zertifikat ${name}: ${CERT_STATUS_TEXT[oneCert.status]}`, rest: '' };
  }
  const problems = badCerts.length + warnCerts.length + badRecords.length;
  if (problems) return { em: plural(problems, 'Problem', 'Probleme'), rest: ' bei Domains' };
  return {
    em: null,
    rest: `${plural(d.records.length, 'Eintrag', 'Einträge')} und ${plural(d.certificates.length, 'Zertifikat', 'Zertifikate')} aktuell.`,
  };
}

/** Providers, records and certificates. Polled, no live topic. */
export function useDomains(enabled = true): UseQueryResult<DomainsResponse> {
  return useQuery({
    queryKey: domainsKey,
    queryFn: ({ signal }) => fetchDomains(signal),
    enabled,
    refetchInterval: 30_000,
  });
}

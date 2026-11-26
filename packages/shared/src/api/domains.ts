import { z } from 'zod';
import { certNameSchema, fqdnSchema } from '../agent-automation.js';
import { serverIdSchema } from './servers.js';

/**
 * M20 "Domains und Zertifikate" (ROADMAP M20, SPEC 18.4). Module `domains`
 * (off by default, switching it on needs step-up).
 *
 * The hub itself stays reachable only via Tailscale. This module manages DNS records
 * and certificates for the admin's *public* things: game relay names (M15), apps
 * on a VPS, a home server behind a dynamic IP.
 *
 * DNS providers: Cloudflare (API token with Zone:DNS:Edit, api.cloudflare.com) and
 * DuckDNS (token, www.duckdns.org; A/AAAA/TXT of <name>.duckdns.org only). Outgoing
 * requests only to those hosts and to the ACME directory (Let's Encrypt production
 * or staging), https only, no redirects, 10 s timeout. Tokens are stored encrypted
 * (AAD `dns_providers.token`), never returned (only `tokenHint`, last 4 chars), not
 * logged. Changing a token needs step-up and a successful test.
 *
 * Records (A, AAAA, CNAME) managed by the hub:
 * - target `server`: the server's public IP from its inventory (dynamic DNS), checked
 *   every minute, pushed to the provider on change (at most once per minute per record),
 * - target `static`: a fixed value.
 * The hub only touches records it created (stores the provider record id); a name
 * that already exists at the provider and was not created by the hub is refused with
 * 409 `exists` unless `adopt: true` (step-up). Deleting a hub record deletes it at the
 * provider too. Records with owner `relay` are managed by the game relay (M15) through
 * DomainService.ensureRecord/removeRecord in the core and are read-only in the UI.
 *
 * Certificates: ACME (RFC 8555) with DNS-01 over the chosen provider, EC P-256 keys
 * generated in the core, stored encrypted (AAD `certificates.key`), never in an API
 * response. Renewal CERT_RENEW_DAYS before expiry (daily check 04:00 HZ_TIMEZONE, retry
 * with backoff 1 h, 6 h, 24 h). Deployed to chosen servers with agent action cert.write
 * (/opt/homelab/certs/<name>/), again after each renewal. Alerts: `cert:<id>` warn at
 * CERT_WARN_DAYS left, crit at CERT_CRIT_DAYS or when issuing failed twice; DNS sync
 * errors: `dns:<recordId>` warn.
 *
 * Routes (admin session; step-up where noted):
 * GET    /api/domains                               -> DomainsResponse
 * PUT    /api/domains/settings                      DomainSettings -> DomainSettings
 * POST   /api/domains/providers          (step-up)  DnsProviderCreate -> DnsProvider (201)
 * PUT    /api/domains/providers/:id      (step-up)  DnsProviderUpdate -> DnsProvider
 * DELETE /api/domains/providers/:id      (step-up)  -> 204; 409 in_use while records/certs use it
 * POST   /api/domains/providers/:id/test            -> DnsProviderTestResponse
 * POST   /api/domains/records                       DnsRecordCreate -> DnsRecord (201)
 * PUT    /api/domains/records/:id                   DnsRecordUpdate -> DnsRecord
 * DELETE /api/domains/records/:id                   -> 204 (also at the provider)
 * POST   /api/domains/records/:id/sync              -> DnsRecord
 * POST   /api/domains/certificates       (step-up)  CertificateCreate -> Certificate (201, status pending)
 * PUT    /api/domains/certificates/:id              CertificateUpdate -> Certificate
 * POST   /api/domains/certificates/:id/renew        -> 202 Certificate
 * DELETE /api/domains/certificates/:id   (step-up)  -> 204 (cert.remove on the deployed servers)
 */

export const domainIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const domainIdParamsSchema = z.strictObject({ id: domainIdSchema });

export const DNS_PROVIDER_KINDS = ['cloudflare', 'duckdns'] as const;
export const dnsProviderKindSchema = z.enum(DNS_PROVIDER_KINDS);
export type DnsProviderKind = z.infer<typeof dnsProviderKindSchema>;

/** Hosts the domains module may talk to (checked again in the core's HTTP client). */
export const DOMAINS_ALLOWED_HOSTS = [
  'api.cloudflare.com',
  'www.duckdns.org',
  'acme-v02.api.letsencrypt.org',
  'acme-staging-v02.api.letsencrypt.org',
] as const;

export const ACME_DIRECTORIES = {
  letsencrypt: 'https://acme-v02.api.letsencrypt.org/directory',
  'letsencrypt-staging': 'https://acme-staging-v02.api.letsencrypt.org/directory',
} as const;
export const acmeCaSchema = z.enum(['letsencrypt', 'letsencrypt-staging']);
export type AcmeCa = z.infer<typeof acmeCaSchema>;

export const CERT_RENEW_DAYS = 30;
export const CERT_WARN_DAYS = 14;
export const CERT_CRIT_DAYS = 3;
export const DNS_PROVIDERS_MAX = 10;
export const DNS_RECORDS_MAX = 200;
export const CERTIFICATES_MAX = 50;

const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}\p{N} .,:()_+/-]+$/u);
/** Cloudflare API tokens are 40 chars; DuckDNS tokens are UUIDs. */
const tokenSchema = z
  .string()
  .min(20)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

export const dnsProviderSchema = z.strictObject({
  id: domainIdSchema,
  kind: dnsProviderKindSchema,
  label: labelSchema,
  /** Last 4 characters of the token. */
  tokenHint: z.string().max(8),
  /** Cloudflare: zone names the token can edit; DuckDNS: the configured subdomains. */
  zones: z.array(fqdnSchema).max(100),
  createdAt: z.number().int(),
  lastOkAt: z.number().int().nullable(),
  lastError: z.string().max(200).nullable(),
});
export type DnsProvider = z.infer<typeof dnsProviderSchema>;

export const dnsProviderCreateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cloudflare'), label: labelSchema, token: tokenSchema }),
  z.strictObject({
    kind: z.literal('duckdns'),
    label: labelSchema,
    token: tokenSchema,
    /** Subdomains without .duckdns.org ("meinheim"). */
    subdomains: z
      .array(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/))
      .min(1)
      .max(5),
  }),
]);
export type DnsProviderCreate = z.infer<typeof dnsProviderCreateSchema>;

export const dnsProviderUpdateSchema = z
  .strictObject({
    label: labelSchema.optional(),
    token: tokenSchema.optional(),
    subdomains: z
      .array(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/))
      .min(1)
      .max(5)
      .optional(),
  })
  .refine((v) => Object.keys(v).length >= 1, { message: 'nothing to update' });

export const dnsProviderTestResponseSchema = z.strictObject({
  ok: z.boolean(),
  zones: z.array(fqdnSchema),
  error: z.string().max(200).nullable(),
});

export const dnsRecordTypeSchema = z.enum(['A', 'AAAA', 'CNAME']);
export type DnsRecordType = z.infer<typeof dnsRecordTypeSchema>;

export const dnsTargetSchema = z.discriminatedUnion('kind', [
  /** Public IP of the server (A: IPv4, AAAA: IPv6 from the inventory). */
  z.strictObject({ kind: z.literal('server'), serverId: serverIdSchema }),
  z.strictObject({
    kind: z.literal('static'),
    value: z.union([z.ipv4(), z.ipv6(), fqdnSchema]),
  }),
]);
export type DnsTarget = z.infer<typeof dnsTargetSchema>;

export const dnsRecordStatusSchema = z.enum(['ok', 'pending', 'error']);

export const dnsRecordSchema = z.strictObject({
  id: domainIdSchema,
  providerId: domainIdSchema,
  /** Full name, must be inside one of the provider's zones. No wildcards. */
  name: fqdnSchema,
  type: dnsRecordTypeSchema,
  target: dnsTargetSchema,
  ttl: z.number().int().min(60).max(86_400),
  /** Cloudflare proxy (orange cloud). Always false for DuckDNS and game ports. */
  proxied: z.boolean(),
  owner: z.enum(['admin', 'relay']),
  /** Value currently at the provider (as last written/read). */
  value: z.string().max(253).nullable(),
  status: dnsRecordStatusSchema,
  lastSyncAt: z.number().int().nullable(),
  lastError: z.string().max(200).nullable(),
});
export type DnsRecord = z.infer<typeof dnsRecordSchema>;

export const dnsRecordCreateSchema = z
  .strictObject({
    providerId: domainIdSchema,
    name: fqdnSchema,
    type: dnsRecordTypeSchema,
    target: dnsTargetSchema,
    ttl: z.number().int().min(60).max(86_400).default(300),
    proxied: z.boolean().default(false),
    /** Take over an existing record of that name and type at the provider (step-up). */
    adopt: z.boolean().default(false),
  })
  .refine((r) => !r.name.startsWith('*.'), { message: 'no wildcard records', path: ['name'] })
  .refine((r) => r.type !== 'CNAME' || r.target.kind === 'static', {
    message: 'CNAME needs a static target',
    path: ['target'],
  });
export type DnsRecordCreate = z.input<typeof dnsRecordCreateSchema>;

export const dnsRecordUpdateSchema = z
  .strictObject({
    target: dnsTargetSchema.optional(),
    ttl: z.number().int().min(60).max(86_400).optional(),
    proxied: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length >= 1, { message: 'nothing to update' });

export const certStatusSchema = z.enum(['pending', 'valid', 'renewing', 'error', 'expired']);
export type CertStatus = z.infer<typeof certStatusSchema>;

export const certDeployTargetSchema = z.strictObject({
  serverId: serverIdSchema,
  /** Folder name below /opt/homelab/certs/ on that server. */
  name: certNameSchema,
});

export const certificateSchema = z.strictObject({
  id: domainIdSchema,
  providerId: domainIdSchema,
  /** First name is the common name. Wildcards allowed ("*.example.com"). */
  names: z.array(fqdnSchema).min(1).max(10),
  ca: acmeCaSchema,
  status: certStatusSchema,
  issuedAt: z.number().int().nullable(),
  notAfter: z.number().int().nullable(),
  autoRenew: z.boolean(),
  deploy: z.array(
    certDeployTargetSchema.extend({
      deployedAt: z.number().int().nullable(),
      lastError: z.string().max(200).nullable(),
    }),
  ),
  lastError: z.string().max(200).nullable(),
  nextAttemptAt: z.number().int().nullable(),
});
export type Certificate = z.infer<typeof certificateSchema>;

export const certificateCreateSchema = z.strictObject({
  providerId: domainIdSchema,
  names: z
    .array(fqdnSchema)
    .min(1)
    .max(10)
    .refine((n) => new Set(n).size === n.length, { message: 'duplicate name' }),
  ca: acmeCaSchema.default('letsencrypt'),
  autoRenew: z.boolean().default(true),
  deploy: z.array(certDeployTargetSchema).max(20).default([]),
});
export type CertificateCreate = z.input<typeof certificateCreateSchema>;

export const certificateUpdateSchema = z
  .strictObject({
    autoRenew: z.boolean().optional(),
    deploy: z.array(certDeployTargetSchema).max(20).optional(),
  })
  .refine((v) => Object.keys(v).length >= 1, { message: 'nothing to update' });

export const domainSettingsSchema = z.strictObject({
  /** ACME account contact (optional, Let's Encrypt sends expiry mails there). */
  acmeEmail: z.email().max(200).nullable(),
});
export type DomainSettings = z.infer<typeof domainSettingsSchema>;

export const domainsResponseSchema = z.strictObject({
  settings: domainSettingsSchema,
  providers: z.array(dnsProviderSchema),
  records: z.array(dnsRecordSchema),
  certificates: z.array(certificateSchema),
});
export type DomainsResponse = z.infer<typeof domainsResponseSchema>;

export const certAlertKey = (id: string) => `cert:${id}`;
export const dnsAlertKey = (id: string) => `dns:${id}`;

/**
 * True when `name` lies inside `zone` ("relay.example.com" in "example.com",
 * "*.example.com" too, "example.com" itself too).
 */
export function nameInZone(name: string, zone: string): boolean {
  const n = name.startsWith('*.') ? name.slice(2) : name;
  return n === zone || n.endsWith(`.${zone}`);
}

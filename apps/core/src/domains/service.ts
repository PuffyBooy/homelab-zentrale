import { generateKeyPairSync, X509Certificate, type KeyObject } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type {
  dnsProviderTestResponseSchema,
  certificateCreateSchema,
  certificateUpdateSchema,
  dnsProviderCreateSchema,
  dnsProviderUpdateSchema,
  dnsRecordUpdateSchema,
} from '@hz/shared';
import {
  ACME_DIRECTORIES,
  CERT_CRIT_DAYS,
  CERT_RENEW_DAYS,
  CERT_WARN_DAYS,
  CERTIFICATES_MAX,
  DNS_PROVIDERS_MAX,
  DNS_RECORDS_MAX,
  DOMAINS_ALLOWED_HOSTS,
  certAlertKey,
  certificateSchema,
  certStatusSchema,
  dnsAlertKey,
  dnsProviderKindSchema,
  dnsProviderSchema,
  dnsRecordCreateSchema,
  dnsRecordSchema,
  dnsRecordTypeSchema,
  dnsTargetSchema,
  domainSettingsSchema,
  domainsResponseSchema,
  fqdnSchema,
  nameInZone,
  type AcmeCa,
  type Certificate,
  type CertStatus,
  type DnsProvider,
  type DnsRecord,
  type DnsRecordType,
  type DnsTarget,
  type DomainSettings,
  type DomainsResponse,
} from '@hz/shared';
import { RpcError } from '../agents/hub.js';
import type { FetchLike } from '../checks/rdap.js';
import { randomToken } from '../crypto.js';
import {
  certificates,
  dnsProviders,
  dnsRecords,
  type CertificateRow,
  type DnsProviderRow,
  type DnsRecordRow,
} from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import type { FeatureContext } from '../features.js';
import { HttpError } from '../http/errors.js';
import { AcmeClient, AcmeError } from './acme.js';
import { keyFromPem, privateKeyPem } from './der.js';
import { DomainsHttp, DomainsHttpError } from './http.js';
import {
  ProviderError,
  providerApi,
  reasonOf,
  type DnsApi,
  type ProviderConfig,
} from './providers.js';

/**
 * Domains, DNS and certificates (packages/shared/src/api/domains.ts). Owns the
 * three tables of migration 17 and the settings `domains.settings` (ACME
 * contact) and `domains.acme` (account key, encrypted, and account URLs).
 */

export const TOKEN_AAD = 'dns_providers.token';
export const CERT_KEY_AAD = 'certificates.key';
export const ACME_KEY_AAD = 'settings.domains.acme_key';
export const SETTINGS_KEY = 'domains.settings';
export const ACME_SETTING = 'domains.acme';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A record is pushed to the provider at most once per minute (automatic sync). */
export const RECORD_PUSH_INTERVAL_MS = MINUTE;
/** Retry after a failed issue/renewal: 1 h, 6 h, then every 24 h. */
export const CERT_BACKOFF_MS = [60 * MINUTE, 6 * 60 * MINUTE, DAY] as const;
const CERT_RPC_TIMEOUT_MS = 30_000;

export interface DomainsDeps {
  /** HTTP transport (tests: fake Cloudflare, DuckDNS and ACME). */
  fetch?: FetchLike;
  /** TXT lookup for the DNS-01 propagation check (tests: the fake DNS). */
  resolveTxt?: (name: string) => Promise<string[][]>;
  /** Tests only: other ACME directory URLs; their hosts join the allowlist. */
  acmeDirectories?: Partial<Record<AcmeCa, string>>;
  /** Waiting between polls (tests: instant). */
  sleep?: (ms: number) => Promise<void>;
  acmePollMs?: number;
  acmeMaxPolls?: number;
  dnsPollMs?: number;
  dnsMaxPolls?: number;
  httpTimeoutMs?: number;
}

export interface EnsureRecordInput {
  /** The game server id (relay). */
  ownerRef: string;
  providerId: string;
  name: string;
  type: DnsRecordType;
  target: DnsTarget;
}

type DeployEntry = Certificate['deploy'][number];
const deployListSchema = z.array(
  z.object({
    serverId: z.string(),
    name: z.string(),
    deployedAt: z.number().int().nullable().default(null),
    lastError: z.string().nullable().default(null),
  }),
);

const acmeSettingSchema = z.object({
  keyEnc: z.string(),
  accounts: z.record(z.string(), z.object({ url: z.string(), email: z.string().nullable() })),
});
type AcmeSetting = z.infer<typeof acmeSettingSchema>;

const providerConfigSchema = z.object({
  tokenHint: z.string().max(8).optional(),
  subdomains: z.array(z.string()).optional(),
  zoneIds: z.record(z.string(), z.string()).optional(),
});

/** Addresses that are never a server's public address (private, CGNAT/Tailscale, ...). */
const NOT_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3],
] as const) {
  NOT_PUBLIC.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fd7a:115c:a1e0::', 48],
  ['ff00::', 8],
] as const) {
  NOT_PUBLIC.addSubnet(net, prefix, 'ipv6');
}

const clip = (s: string | null, n = 200): string | null => (s === null ? null : s.slice(0, n));

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function zonesOf(row: DnsProviderRow): string[] {
  const p = z.array(fqdnSchema).max(100).safeParse(parseJson(row.zonesJson));
  return p.success ? p.data : [];
}

function configOf(row: DnsProviderRow): ProviderConfig {
  const p = providerConfigSchema.safeParse(parseJson(row.configJson));
  if (!p.success) return {};
  const c: ProviderConfig = {};
  if (p.data.tokenHint !== undefined) c.tokenHint = p.data.tokenHint;
  if (p.data.subdomains !== undefined) c.subdomains = p.data.subdomains;
  if (p.data.zoneIds !== undefined) c.zoneIds = p.data.zoneIds;
  return c;
}

function namesOf(row: CertificateRow): string[] {
  const p = z.array(fqdnSchema).safeParse(parseJson(row.namesJson));
  return p.success ? p.data : [];
}

function deployOf(row: CertificateRow): DeployEntry[] {
  const p = deployListSchema.safeParse(parseJson(row.deployJson));
  return p.success ? p.data : [];
}

function targetOf(row: Pick<DnsRecordRow, 'targetJson'>): DnsTarget | null {
  const p = dnsTargetSchema.safeParse(parseJson(row.targetJson));
  return p.success ? p.data : null;
}

/** First PEM certificate block and the whole chain in LF form. */
export function normalizeChain(pem: string): { chain: string; leaf: string } {
  const blocks = pem
    .replace(/\r\n/g, '\n')
    .match(/-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length === 0 || blocks.length > 10)
    throw new AcmeError('Zertifikat vom ACME-Server unlesbar');
  return { chain: `${blocks.join('\n')}\n`, leaf: `${blocks[0]}\n` };
}

/** Whether `name` is allowed for a provider (DuckDNS: exactly the subdomain). */
export function nameAllowed(kind: string, zones: readonly string[], name: string): boolean {
  if (kind === 'duckdns') {
    const base = name.startsWith('*.') ? name.slice(2) : name;
    return zones.includes(base);
  }
  return zones.some((z) => nameInZone(name, z));
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DomainsHttpError('network'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    t.unref();
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DomainsHttpError('network'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

function defaultResolveTxt(): (name: string) => Promise<string[][]> {
  // Public resolvers instead of the host's (which may cache or be a tailnet DNS).
  const r = new Resolver({ timeout: 5_000, tries: 2 });
  r.setServers(['1.1.1.1', '8.8.8.8']);
  return (name) => r.resolveTxt(name);
}

function rpcReason(err: unknown): string {
  if (err instanceof RpcError) {
    if (err.code === 'offline' || err.code === 'disconnected') return 'Server offline';
    if (err.code === 'timeout') return 'Agent antwortet nicht';
    if (err.code === 'not_allowed') return 'Agent kennt cert.write nicht (Update nötig)';
    return `Agent-Fehler (${err.code})`.slice(0, 200);
  }
  return 'Verteilen fehlgeschlagen';
}

export class DomainService {
  private enabled: boolean;
  private abort = new AbortController();
  private readonly background = new Set<Promise<unknown>>();
  private readonly recordLocks = new Map<string, Promise<unknown>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly lastPush = new Map<string, number>();
  private readonly fetchImpl: FetchLike;
  private readonly resolveTxt: (name: string) => Promise<string[][]>;
  private readonly directories: Record<AcmeCa, string>;
  private readonly allowedHosts: ReadonlySet<string>;

  constructor(
    private readonly ctx: FeatureContext,
    private readonly deps: DomainsDeps = {},
  ) {
    this.enabled = ctx.modules.enabled('domains');
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.resolveTxt = deps.resolveTxt ?? defaultResolveTxt();
    this.directories = { ...ACME_DIRECTORIES, ...deps.acmeDirectories };
    const hosts = new Set<string>(DOMAINS_ALLOWED_HOSTS);
    for (const url of Object.values(deps.acmeDirectories ?? {})) {
      if (url) hosts.add(new URL(url).hostname.toLowerCase());
    }
    this.allowedHosts = hosts;
  }

  // ---- infrastructure ---------------------------------------------------------------

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) {
      this.abort.abort();
      this.abort = new AbortController();
      this.ctx.alerts.resolveAllWithPrefix('dns:');
      this.ctx.alerts.resolveAllWithPrefix('cert:');
    }
  }

  private http(): DomainsHttp {
    return new DomainsHttp({
      fetch: this.fetchImpl,
      allowedHosts: this.allowedHosts,
      signal: this.abort.signal,
      ...(this.deps.httpTimeoutMs !== undefined ? { timeoutMs: this.deps.httpTimeoutMs } : {}),
    });
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) {
      const signal = this.abort.signal;
      return this.deps.sleep(ms).then(() => {
        if (signal.aborted) throw new DomainsHttpError('network');
      });
    }
    return realSleep(ms, this.abort.signal);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const q = p.catch(() => undefined);
    this.background.add(q);
    void q.finally(() => this.background.delete(q));
    return p;
  }

  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  stop(): void {
    this.abort.abort();
  }

  private withRecordLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.recordLocks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.recordLocks.set(id, tail);
    void tail.then(() => {
      if (this.recordLocks.get(id) === tail) this.recordLocks.delete(id);
    });
    return this.track(next);
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new HttpError(404, 'module_disabled');
  }

  // ---- reads ------------------------------------------------------------------------

  private providerRow(id: string): DnsProviderRow | undefined {
    return this.ctx.db.select().from(dnsProviders).where(eq(dnsProviders.id, id)).get();
  }

  private recordRow(id: string): DnsRecordRow | undefined {
    return this.ctx.db.select().from(dnsRecords).where(eq(dnsRecords.id, id)).get();
  }

  private certRow(id: string): CertificateRow | undefined {
    return this.ctx.db.select().from(certificates).where(eq(certificates.id, id)).get();
  }

  private toProvider(row: DnsProviderRow): DnsProvider {
    return dnsProviderSchema.parse({
      id: row.id,
      kind: dnsProviderKindSchema.parse(row.kind),
      label: row.label,
      tokenHint: configOf(row).tokenHint ?? '',
      zones: zonesOf(row),
      createdAt: row.createdAt,
      lastOkAt: row.lastOkAt,
      lastError: clip(row.lastError),
    });
  }

  private toRecord(row: DnsRecordRow): DnsRecord {
    return dnsRecordSchema.parse({
      id: row.id,
      providerId: row.providerId,
      name: row.name,
      type: row.type,
      target: targetOf(row) ?? { kind: 'static', value: row.value ?? '0.0.0.0' },
      ttl: row.ttl,
      proxied: row.proxied,
      owner: row.owner === 'relay' ? 'relay' : 'admin',
      value: clip(row.value, 253),
      status: row.status,
      lastSyncAt: row.lastSyncAt,
      lastError: clip(row.lastError),
    });
  }

  private certStatus(row: CertificateRow): CertStatus {
    if (row.status === 'valid' && row.notAfter !== null && row.notAfter <= this.ctx.now())
      return 'expired';
    return certStatusSchema.catch('error').parse(row.status);
  }

  private toCertificate(row: CertificateRow): Certificate {
    return certificateSchema.parse({
      id: row.id,
      providerId: row.providerId,
      names: namesOf(row),
      ca: row.ca,
      status: this.certStatus(row),
      issuedAt: row.issuedAt,
      notAfter: row.notAfter,
      autoRenew: row.autoRenew,
      deploy: deployOf(row).map((d) => ({ ...d, lastError: clip(d.lastError) })),
      lastError: clip(row.lastError),
      nextAttemptAt: row.nextAttemptAt,
    });
  }

  settings(): DomainSettings {
    const p = domainSettingsSchema.safeParse(readSetting(this.ctx.db, SETTINGS_KEY));
    return p.success ? p.data : { acmeEmail: null };
  }

  setSettings(s: DomainSettings): DomainSettings {
    writeSetting(this.ctx.db, SETTINGS_KEY, domainSettingsSchema.parse(s), this.ctx.now());
    return this.settings();
  }

  list(): DomainsResponse {
    const db = this.ctx.db;
    return domainsResponseSchema.parse({
      settings: this.settings(),
      providers: db
        .select()
        .from(dnsProviders)
        .all()
        .map((r) => this.toProvider(r)),
      records: db
        .select()
        .from(dnsRecords)
        .all()
        .map((r) => this.toRecord(r)),
      certificates: db
        .select()
        .from(certificates)
        .all()
        .map((r) => this.toCertificate(r)),
    });
  }

  provider(id: string): DnsProvider {
    const row = this.providerRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    return this.toProvider(row);
  }

  record(id: string): DnsRecord {
    const row = this.recordRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    return this.toRecord(row);
  }

  certificate(id: string): Certificate {
    const row = this.certRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    return this.toCertificate(row);
  }

  // ---- providers --------------------------------------------------------------------

  private api(row: DnsProviderRow): DnsApi {
    const token = this.ctx.box.decrypt(row.tokenEnc, TOKEN_AAD);
    return providerApi(this.http(), dnsProviderKindSchema.parse(row.kind), token, configOf(row));
  }

  private async verify(
    kind: 'cloudflare' | 'duckdns',
    token: string,
    config: ProviderConfig,
  ): Promise<{ zones: string[]; config: ProviderConfig }> {
    try {
      const v = await providerApi(this.http(), kind, token, config).verify();
      return { zones: v.zones, config: { ...config, ...v.config, tokenHint: token.slice(-4) } };
    } catch (err) {
      this.ctx.log.info({ kind, reason: reasonOf(err) }, 'dns provider token check failed');
      throw new HttpError(400, 'invalid_input', undefined, `Token-Prüfung: ${reasonOf(err)}`);
    }
  }

  async createProvider(input: z.infer<typeof dnsProviderCreateSchema>): Promise<DnsProvider> {
    this.requireEnabled();
    const count = this.ctx.db.select({ id: dnsProviders.id }).from(dnsProviders).all().length;
    if (count >= DNS_PROVIDERS_MAX) throw new HttpError(409, 'conflict');
    const base: ProviderConfig =
      input.kind === 'duckdns' ? { subdomains: [...new Set(input.subdomains)] } : {};
    const v = await this.verify(input.kind, input.token, base);
    const now = this.ctx.now();
    const id = randomToken(12);
    this.ctx.db
      .insert(dnsProviders)
      .values({
        id,
        kind: input.kind,
        label: input.label,
        tokenEnc: this.ctx.box.encrypt(input.token, TOKEN_AAD),
        configJson: JSON.stringify(v.config),
        zonesJson: JSON.stringify(v.zones),
        lastOkAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.provider(id);
  }

  private namesInUse(providerId: string): string[] {
    const db = this.ctx.db;
    const recs = db
      .select({ name: dnsRecords.name })
      .from(dnsRecords)
      .where(eq(dnsRecords.providerId, providerId))
      .all()
      .map((r) => r.name);
    const certs = db
      .select()
      .from(certificates)
      .where(eq(certificates.providerId, providerId))
      .all()
      .flatMap((r) => namesOf(r));
    return [...recs, ...certs];
  }

  async updateProvider(
    id: string,
    input: z.infer<typeof dnsProviderUpdateSchema>,
  ): Promise<{ provider: DnsProvider; tokenChanged: boolean }> {
    this.requireEnabled();
    const row = this.providerRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    if (input.subdomains !== undefined && row.kind !== 'duckdns')
      throw new HttpError(400, 'invalid_input');
    const set: Partial<DnsProviderRow> = { updatedAt: this.ctx.now() };
    if (input.label !== undefined) set.label = input.label;
    if (input.token !== undefined || input.subdomains !== undefined) {
      const token = input.token ?? this.ctx.box.decrypt(row.tokenEnc, TOKEN_AAD);
      const config = configOf(row);
      if (input.subdomains !== undefined) config.subdomains = [...new Set(input.subdomains)];
      const v = await this.verify(dnsProviderKindSchema.parse(row.kind), token, config);
      const lost = this.namesInUse(id).filter((n) => !nameAllowed(row.kind, v.zones, n));
      if (lost.length > 0)
        throw new HttpError(
          409,
          'in_use',
          undefined,
          'Einträge oder Zertifikate nutzen eine Zone, die wegfallen würde.',
        );
      if (input.token !== undefined) set.tokenEnc = this.ctx.box.encrypt(input.token, TOKEN_AAD);
      set.configJson = JSON.stringify(v.config);
      set.zonesJson = JSON.stringify(v.zones);
      set.lastOkAt = this.ctx.now();
      set.lastError = null;
    }
    this.ctx.db.update(dnsProviders).set(set).where(eq(dnsProviders.id, id)).run();
    return { provider: this.provider(id), tokenChanged: input.token !== undefined };
  }

  deleteProvider(id: string): void {
    this.requireEnabled();
    if (!this.providerRow(id)) throw new HttpError(404, 'not_found');
    if (this.namesInUse(id).length > 0)
      throw new HttpError(
        409,
        'in_use',
        undefined,
        'Der Anbieter wird noch von Einträgen oder Zertifikaten genutzt.',
      );
    this.ctx.db.delete(dnsProviders).where(eq(dnsProviders.id, id)).run();
  }

  async testProvider(id: string): Promise<z.infer<typeof dnsProviderTestResponseSchema>> {
    this.requireEnabled();
    const row = this.providerRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    const now = this.ctx.now();
    try {
      const v = await this.api(row).verify();
      const config = { ...configOf(row), ...v.config };
      this.ctx.db
        .update(dnsProviders)
        .set({
          configJson: JSON.stringify(config),
          zonesJson: JSON.stringify(v.zones),
          lastOkAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(dnsProviders.id, id))
        .run();
      return { ok: true, zones: zonesOf(this.providerRow(id) ?? row), error: null };
    } catch (err) {
      const reason = reasonOf(err);
      this.ctx.db
        .update(dnsProviders)
        .set({ lastError: reason, updatedAt: now })
        .where(eq(dnsProviders.id, id))
        .run();
      return { ok: false, zones: zonesOf(row), error: reason };
    }
  }

  // ---- records ----------------------------------------------------------------------

  /** Value the record should have, or a reason why there is none. */
  private desired(row: Pick<DnsRecordRow, 'type' | 'targetJson'>):
    | { value: string }
    | {
        error: string;
      } {
    const target = targetOf(row);
    if (!target) return { error: 'Ziel ungültig' };
    if (target.kind === 'static') return { value: target.value };
    const server = this.ctx.servers.row(target.serverId);
    if (!server) return { error: 'Server nicht gefunden' };
    const ip = server.publicIp?.trim() ?? '';
    const family = isIP(ip);
    if (family === 0) return { error: 'Server meldet keine öffentliche IP' };
    if (row.type === 'A' && family !== 4) return { error: 'Server meldet keine öffentliche IPv4' };
    if (row.type === 'AAAA' && family !== 6)
      return { error: 'Server meldet keine öffentliche IPv6' };
    if (NOT_PUBLIC.check(ip, family === 4 ? 'ipv4' : 'ipv6'))
      return { error: 'Adresse des Servers ist nicht öffentlich' };
    return { value: ip };
  }

  private checkTarget(type: DnsRecordType, target: DnsTarget): void {
    if (target.kind === 'server') {
      if (type === 'CNAME') throw new HttpError(400, 'invalid_input');
      if (!this.ctx.servers.row(target.serverId))
        throw new HttpError(400, 'invalid_input', undefined, 'Server unbekannt.');
      return;
    }
    const family = isIP(target.value);
    const ok =
      (type === 'A' && family === 4) ||
      (type === 'AAAA' && family === 6) ||
      (type === 'CNAME' && family === 0 && !target.value.startsWith('*.'));
    if (!ok)
      throw new HttpError(400, 'invalid_input', undefined, 'Wert passt nicht zum Eintragstyp.');
  }

  private async createRecordRow(
    input: z.output<typeof dnsRecordCreateSchema>,
    owner: { owner: 'admin' | 'relay'; ownerRef: string | null },
  ): Promise<string> {
    const provider = this.providerRow(input.providerId);
    if (!provider) throw new HttpError(400, 'invalid_input', undefined, 'DNS-Anbieter unbekannt.');
    if (!nameAllowed(provider.kind, zonesOf(provider), input.name))
      throw new HttpError(
        400,
        'invalid_input',
        undefined,
        'Name liegt in keiner Zone des Anbieters.',
      );
    if (provider.kind === 'duckdns' && (input.type === 'CNAME' || input.proxied))
      throw new HttpError(400, 'invalid_input', undefined, 'DuckDNS kann nur A und AAAA.');
    this.checkTarget(input.type, input.target);
    const db = this.ctx.db;
    if (db.select({ id: dnsRecords.id }).from(dnsRecords).all().length >= DNS_RECORDS_MAX)
      throw new HttpError(409, 'conflict');
    const sameName = db
      .select()
      .from(dnsRecords)
      .where(and(eq(dnsRecords.providerId, provider.id), eq(dnsRecords.name, input.name)))
      .all();
    if (sameName.some((r) => r.type === input.type || r.type === 'CNAME' || input.type === 'CNAME'))
      throw new HttpError(409, 'exists', undefined, 'Diesen Eintrag gibt es schon.');

    let existing: { id: string; value: string }[];
    try {
      existing = await this.api(provider).find(input.name, input.type);
    } catch (err) {
      throw new HttpError(502, 'internal', undefined, `DNS-Anbieter: ${reasonOf(err)}`);
    }
    if (existing.length > 0 && (!input.adopt || existing.length > 1))
      throw new HttpError(
        409,
        'exists',
        undefined,
        existing.length > 1
          ? 'Beim Anbieter gibt es mehrere Einträge mit diesem Namen.'
          : 'Diesen Eintrag gibt es beim Anbieter schon (nicht von der Zentrale).',
      );
    const adopted = existing[0];
    const now = this.ctx.now();
    const id = randomToken(12);
    db.insert(dnsRecords)
      .values({
        id,
        providerId: provider.id,
        name: input.name,
        type: input.type,
        targetJson: JSON.stringify(input.target),
        ttl: input.ttl,
        proxied: input.proxied,
        owner: owner.owner,
        ownerRef: owner.ownerRef,
        providerRecordId: adopted?.id ?? null,
        value: adopted?.value.slice(0, 253) ?? null,
        status: 'pending',
        lastSyncAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  async createRecord(input: z.output<typeof dnsRecordCreateSchema>): Promise<DnsRecord> {
    this.requireEnabled();
    const id = await this.createRecordRow(input, { owner: 'admin', ownerRef: null });
    await this.syncRecord(id, 'manual');
    return this.record(id);
  }

  async updateRecord(id: string, input: z.infer<typeof dnsRecordUpdateSchema>): Promise<DnsRecord> {
    this.requireEnabled();
    const row = this.recordRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    if (row.owner !== 'admin')
      throw new HttpError(403, 'forbidden', undefined, 'Eintrag gehört dem Game-Relay.');
    const type = dnsRecordTypeSchema.parse(row.type);
    const provider = this.providerRow(row.providerId);
    if (input.target !== undefined) this.checkTarget(type, input.target);
    if (input.proxied === true && provider?.kind === 'duckdns')
      throw new HttpError(400, 'invalid_input', undefined, 'DuckDNS kann keinen Proxy.');
    const set: Partial<DnsRecordRow> = { updatedAt: this.ctx.now(), status: 'pending' };
    if (input.target !== undefined) set.targetJson = JSON.stringify(input.target);
    if (input.ttl !== undefined) set.ttl = input.ttl;
    if (input.proxied !== undefined) set.proxied = input.proxied;
    this.ctx.db.update(dnsRecords).set(set).where(eq(dnsRecords.id, id)).run();
    await this.syncRecord(id, 'manual');
    return this.record(id);
  }

  async deleteRecord(id: string, opts: { relay?: boolean } = {}): Promise<void> {
    this.requireEnabled();
    const row = this.recordRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    if (!opts.relay && row.owner !== 'admin')
      throw new HttpError(403, 'forbidden', undefined, 'Eintrag gehört dem Game-Relay.');
    await this.withRecordLock(id, async () => {
      const cur = this.recordRow(id);
      if (!cur) return;
      const provider = this.providerRow(cur.providerId);
      if (provider && cur.providerRecordId) {
        try {
          await this.api(provider).remove(cur.providerRecordId, {
            name: cur.name,
            type: dnsRecordTypeSchema.parse(cur.type),
          });
        } catch (err) {
          throw new HttpError(502, 'internal', undefined, `DNS-Anbieter: ${reasonOf(err)}`);
        }
      }
      this.ctx.db.delete(dnsRecords).where(eq(dnsRecords.id, id)).run();
      this.lastPush.delete(id);
      const alert = this.ctx.alerts.active(dnsAlertKey(id));
      if (alert) this.ctx.alerts.resolveById(alert.id);
      // DuckDNS clears both addresses: push the remaining sibling again.
      if (provider?.kind === 'duckdns' && cur.providerRecordId) {
        const siblings = this.ctx.db
          .select()
          .from(dnsRecords)
          .where(
            and(
              eq(dnsRecords.providerId, provider.id),
              eq(dnsRecords.name, cur.name),
              ne(dnsRecords.id, id),
            ),
          )
          .all();
        for (const s of siblings) {
          this.ctx.db
            .update(dnsRecords)
            .set({ value: null, status: 'pending' })
            .where(eq(dnsRecords.id, s.id))
            .run();
          void this.syncRecord(s.id, 'manual').catch(() => undefined);
        }
      }
    });
  }

  private recordError(row: DnsRecordRow, reason: string): void {
    const now = this.ctx.now();
    this.ctx.db
      .update(dnsRecords)
      .set({ status: 'error', lastError: reason.slice(0, 200), updatedAt: now })
      .where(eq(dnsRecords.id, row.id))
      .run();
    if (!this.enabled) return;
    const target = targetOf(row);
    this.ctx.alerts.raise(
      dnsAlertKey(row.id),
      'warn',
      `DNS-Eintrag ${row.name} nicht aktuell`,
      `${row.type} ${row.name}: ${reason}`.slice(0, 300),
      target?.kind === 'server' && this.ctx.servers.row(target.serverId) ? target.serverId : null,
      'system',
    );
  }

  /**
   * Brings one record in line with its target. `auto` (the minute job) skips
   * records that are up to date and pushes at most once per minute per record;
   * `manual` (admin action, relay) always pushes.
   */
  syncRecord(id: string, mode: 'auto' | 'manual'): Promise<void> {
    return this.withRecordLock(id, async () => {
      const row = this.recordRow(id);
      if (!row || !this.enabled) return;
      const want = this.desired(row);
      const now = this.ctx.now();
      if ('error' in want) {
        if (row.status !== 'error' || row.lastError !== want.error)
          this.recordError(row, want.error);
        return;
      }
      if (mode === 'auto') {
        if (row.status === 'ok' && row.providerRecordId !== null && row.value === want.value)
          return;
        const last = this.lastPush.get(id);
        if (last !== undefined && now - last < RECORD_PUSH_INTERVAL_MS) return;
      }
      const provider = this.providerRow(row.providerId);
      if (!provider) return this.recordError(row, 'DNS-Anbieter fehlt');
      this.lastPush.set(id, now);
      const type = dnsRecordTypeSchema.parse(row.type);
      const rec = { name: row.name, type, value: want.value, ttl: row.ttl, proxied: row.proxied };
      try {
        const api = this.api(provider);
        let recordId = row.providerRecordId;
        if (recordId !== null && (await api.update(recordId, rec)) === 'missing') recordId = null;
        if (recordId === null) {
          // Never overwrite a record the hub did not create.
          if ((await api.find(row.name, type)).length > 0)
            throw new ProviderError('Name beim Anbieter schon vergeben (nicht von der Zentrale)');
          recordId = await api.create(rec);
        }
        const done = this.ctx.now();
        this.ctx.db
          .update(dnsRecords)
          .set({
            providerRecordId: recordId,
            value: want.value,
            status: 'ok',
            lastSyncAt: done,
            lastError: null,
            updatedAt: done,
          })
          .where(eq(dnsRecords.id, id))
          .run();
        this.ctx.db
          .update(dnsProviders)
          .set({ lastOkAt: done, lastError: null })
          .where(eq(dnsProviders.id, provider.id))
          .run();
        this.ctx.alerts.resolve(dnsAlertKey(id));
      } catch (err) {
        const reason = reasonOf(err);
        this.ctx.log.warn({ recordId: id, reason }, 'dns record sync failed');
        this.ctx.db
          .update(dnsProviders)
          .set({ lastError: reason })
          .where(eq(dnsProviders.id, provider.id))
          .run();
        const cur = this.recordRow(id);
        if (cur) this.recordError(cur, reason);
      }
    });
  }

  async manualSync(id: string): Promise<DnsRecord> {
    this.requireEnabled();
    if (!this.recordRow(id)) throw new HttpError(404, 'not_found');
    await this.syncRecord(id, 'manual');
    return this.record(id);
  }

  /** Minute job: every record against its target. */
  async syncAll(): Promise<void> {
    if (!this.enabled) return;
    const ids = this.ctx.db.select({ id: dnsRecords.id }).from(dnsRecords).all();
    for (const { id } of ids) await this.syncRecord(id, 'auto');
  }

  // ---- interface for the game relay (M15) --------------------------------------------

  /**
   * Creates or updates the relay record of `ownerRef` with this type. A relay
   * record of the same owner and type under another name or provider is replaced.
   * A name that exists at the provider (not created by the hub) or as an admin
   * record is refused with HttpError 409 exists; a name outside the provider's
   * zones with 400. Throws 404 module_disabled while the module is off.
   */
  async ensureRecord(input: EnsureRecordInput): Promise<DnsRecord> {
    this.requireEnabled();
    const parsed = dnsRecordCreateSchema.parse({
      providerId: input.providerId,
      name: input.name,
      type: input.type,
      target: input.target,
      ttl: 60,
      proxied: false,
      adopt: false,
    });
    const ownerRef = z.string().min(1).max(64).parse(input.ownerRef);
    const mine = this.ctx.db
      .select()
      .from(dnsRecords)
      .where(
        and(
          eq(dnsRecords.owner, 'relay'),
          eq(dnsRecords.ownerRef, ownerRef),
          eq(dnsRecords.type, parsed.type),
        ),
      )
      .all();
    const same = mine.find((r) => r.providerId === parsed.providerId && r.name === parsed.name);
    for (const r of mine) if (r !== same) await this.deleteRecord(r.id, { relay: true });
    if (same) {
      this.checkTarget(parsed.type, parsed.target);
      const targetJson = JSON.stringify(parsed.target);
      if (same.targetJson !== targetJson) {
        this.ctx.db
          .update(dnsRecords)
          .set({ targetJson, status: 'pending', updatedAt: this.ctx.now() })
          .where(eq(dnsRecords.id, same.id))
          .run();
      }
      await this.syncRecord(same.id, same.targetJson !== targetJson ? 'manual' : 'auto');
      return this.record(same.id);
    }
    const id = await this.createRecordRow(parsed, { owner: 'relay', ownerRef });
    await this.syncRecord(id, 'manual');
    return this.record(id);
  }

  /** Removes every relay record of `ownerRef` (also at the provider). */
  async removeRecord(ownerRef: string): Promise<void> {
    const rows = this.ctx.db
      .select()
      .from(dnsRecords)
      .where(and(eq(dnsRecords.owner, 'relay'), eq(dnsRecords.ownerRef, ownerRef)))
      .all();
    for (const r of rows) await this.deleteRecord(r.id, { relay: true });
  }

  // ---- certificates -----------------------------------------------------------------

  private accountKey(): { key: KeyObject; setting: AcmeSetting } {
    const p = acmeSettingSchema.safeParse(readSetting(this.ctx.db, ACME_SETTING));
    if (p.success) {
      return {
        key: keyFromPem(this.ctx.box.decrypt(p.data.keyEnc, ACME_KEY_AAD)),
        setting: p.data,
      };
    }
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const setting: AcmeSetting = {
      keyEnc: this.ctx.box.encrypt(privateKeyPem(privateKey), ACME_KEY_AAD),
      accounts: {},
    };
    writeSetting(this.ctx.db, ACME_SETTING, setting, this.ctx.now());
    return { key: privateKey, setting };
  }

  private checkDeploy(
    certId: string | null,
    deploy: readonly { serverId: string; name: string }[],
  ): void {
    const seen = new Set<string>();
    for (const d of deploy) {
      if (!this.ctx.servers.row(d.serverId))
        throw new HttpError(400, 'invalid_input', undefined, 'Server unbekannt.');
      const k = `${d.serverId}/${d.name}`;
      if (seen.has(k)) throw new HttpError(400, 'invalid_input');
      seen.add(k);
    }
    for (const other of this.ctx.db.select().from(certificates).all()) {
      if (other.id === certId) continue;
      if (deployOf(other).some((d) => seen.has(`${d.serverId}/${d.name}`)))
        throw new HttpError(
          409,
          'in_use',
          undefined,
          'Ein anderes Zertifikat nutzt diesen Ordner schon.',
        );
    }
  }

  createCertificate(input: z.output<typeof certificateCreateSchema>): Certificate {
    this.requireEnabled();
    const provider = this.providerRow(input.providerId);
    if (!provider) throw new HttpError(400, 'invalid_input', undefined, 'DNS-Anbieter unbekannt.');
    const zones = zonesOf(provider);
    if (input.names.some((n) => !nameAllowed(provider.kind, zones, n)))
      throw new HttpError(
        400,
        'invalid_input',
        undefined,
        'Name liegt in keiner Zone des Anbieters.',
      );
    const db = this.ctx.db;
    if (db.select({ id: certificates.id }).from(certificates).all().length >= CERTIFICATES_MAX)
      throw new HttpError(409, 'conflict');
    this.checkDeploy(null, input.deploy);
    const now = this.ctx.now();
    const id = randomToken(12);
    db.insert(certificates)
      .values({
        id,
        providerId: provider.id,
        namesJson: JSON.stringify(input.names),
        ca: input.ca,
        status: 'pending',
        keyEnc: null,
        certPem: null,
        issuedAt: null,
        notAfter: null,
        autoRenew: input.autoRenew,
        deployJson: JSON.stringify(
          input.deploy.map((d) => ({ ...d, deployedAt: null, lastError: null })),
        ),
        failures: 0,
        lastError: null,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    this.startIssue(id);
    return this.certificate(id);
  }

  /**
   * Whether `deploy` names a target the certificate does not have yet. Sending
   * the private key to a new server needs step-up (routes.ts).
   */
  addsDeployTargets(id: string, deploy: readonly { serverId: string; name: string }[]): boolean {
    const row = this.certRow(id);
    if (!row) return false;
    const prev = deployOf(row);
    return deploy.some((d) => !prev.some((p) => p.serverId === d.serverId && p.name === d.name));
  }

  updateCertificate(id: string, input: z.infer<typeof certificateUpdateSchema>): Certificate {
    this.requireEnabled();
    const row = this.certRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    const set: Partial<CertificateRow> = { updatedAt: this.ctx.now() };
    if (input.autoRenew !== undefined) set.autoRenew = input.autoRenew;
    let added: { serverId: string; name: string }[] = [];
    if (input.deploy !== undefined) {
      this.checkDeploy(id, input.deploy);
      const prev = deployOf(row);
      const key = (d: { serverId: string; name: string }): string => `${d.serverId}/${d.name}`;
      const next = input.deploy.map(
        (d) =>
          prev.find((p) => key(p) === key(d)) ?? {
            serverId: d.serverId,
            name: d.name,
            deployedAt: null,
            lastError: null,
          },
      );
      const removed = prev.filter((p) => !next.some((n) => key(n) === key(p)));
      added = next.filter((n) => !prev.some((p) => key(p) === key(n)));
      set.deployJson = JSON.stringify(next);
      for (const r of removed) void this.track(this.removeFrom(r.serverId, r.name));
    }
    this.ctx.db.update(certificates).set(set).where(eq(certificates.id, id)).run();
    if (added.length > 0 && row.certPem !== null && row.keyEnc !== null) {
      void this.track(this.deploy(id, added));
    }
    return this.certificate(id);
  }

  renewCertificate(id: string): Certificate {
    this.requireEnabled();
    const row = this.certRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    if (this.running.has(id)) throw new HttpError(409, 'busy');
    this.ctx.db
      .update(certificates)
      .set({ nextAttemptAt: this.ctx.now(), updatedAt: this.ctx.now() })
      .where(eq(certificates.id, id))
      .run();
    this.startIssue(id);
    return this.certificate(id);
  }

  async deleteCertificate(id: string): Promise<void> {
    this.requireEnabled();
    const row = this.certRow(id);
    if (!row) throw new HttpError(404, 'not_found');
    this.ctx.db.delete(certificates).where(eq(certificates.id, id)).run();
    const alert = this.ctx.alerts.active(certAlertKey(id));
    if (alert) this.ctx.alerts.resolveById(alert.id);
    await Promise.all(deployOf(row).map((d) => this.track(this.removeFrom(d.serverId, d.name))));
  }

  private async removeFrom(serverId: string, name: string): Promise<void> {
    if (!this.ctx.hub.isConnected(serverId)) return;
    try {
      await this.ctx.hub.call(
        serverId,
        'cert.remove',
        { name },
        { timeoutMs: CERT_RPC_TIMEOUT_MS },
      );
    } catch (err) {
      this.ctx.log.warn({ serverId, name, reason: rpcReason(err) }, 'cert.remove failed');
    }
  }

  /** Starts issuing/renewing in the background unless already running. */
  private startIssue(id: string): boolean {
    if (this.running.has(id) || !this.enabled) return false;
    const p = this.issue(id).finally(() => this.running.delete(id));
    this.running.set(id, p);
    void this.track(p);
    return true;
  }

  private async issue(id: string): Promise<void> {
    const row = this.certRow(id);
    if (!row) return;
    const provider = this.providerRow(row.providerId);
    const names = namesOf(row);
    const hadCert = row.certPem !== null && row.notAfter !== null && row.notAfter > this.ctx.now();
    this.ctx.db
      .update(certificates)
      .set({ status: hadCert ? 'renewing' : 'pending', updatedAt: this.ctx.now() })
      .where(eq(certificates.id, id))
      .run();
    const signal = this.abort.signal;
    try {
      if (!provider || names.length === 0) throw new ProviderError('DNS-Anbieter fehlt');
      const ca = row.ca === 'letsencrypt-staging' ? 'letsencrypt-staging' : 'letsencrypt';
      const directoryUrl = this.directories[ca];
      const { key: accountKey, setting } = this.accountKey();
      const acme = new AcmeClient({
        http: this.http(),
        directoryUrl,
        accountKey,
        sleep: (ms) => this.sleep(ms),
        pollMs: this.deps.acmePollMs ?? 2_000,
        maxPolls: this.deps.acmeMaxPolls ?? 30,
      });
      const email = this.settings().acmeEmail;
      const known = setting.accounts[directoryUrl];
      const accountUrl = await acme.account(email, known ? known.email : undefined);
      writeSetting(
        this.ctx.db,
        ACME_SETTING,
        {
          ...setting,
          accounts: { ...setting.accounts, [directoryUrl]: { url: accountUrl, email } },
        },
        this.ctx.now(),
      );
      const certKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
      const api = this.api(provider);
      const pem = await acme.issue(names, certKey, {
        set: (name, value) => api.addTxt(name, value),
        wait: (name, value) => this.waitTxt(name, value),
        clear: (name, handle) => api.removeTxt(name, handle),
      });
      const { chain, leaf } = normalizeChain(pem);
      let notAfter: number;
      try {
        const x = new X509Certificate(leaf);
        if (!x.checkPrivateKey(certKey))
          throw new AcmeError('Zertifikat passt nicht zum Schlüssel');
        const san = x.subjectAltName ?? '';
        const sans = san.split(',').map((s) => s.trim());
        if (names.some((n) => !sans.includes(`DNS:${n}`)))
          throw new AcmeError('Zertifikat deckt nicht alle Namen ab');
        notAfter = Date.parse(x.validTo);
        if (!Number.isFinite(notAfter)) throw new AcmeError('Zertifikat ohne Ablaufdatum');
      } catch (err) {
        if (err instanceof AcmeError) throw err;
        throw new AcmeError('Zertifikat vom ACME-Server unlesbar');
      }
      const now = this.ctx.now();
      this.ctx.db
        .update(certificates)
        .set({
          keyEnc: this.ctx.box.encrypt(privateKeyPem(certKey), CERT_KEY_AAD),
          certPem: chain,
          issuedAt: now,
          notAfter,
          status: 'valid',
          failures: 0,
          lastError: null,
          nextAttemptAt: null,
          updatedAt: now,
        })
        .where(eq(certificates.id, id))
        .run();
      this.ctx.log.info({ certId: id, notAfter }, 'certificate issued');
      this.evaluateAlert(id);
      await this.deploy(id, null);
    } catch (err) {
      const cur = this.certRow(id);
      if (!cur) return;
      const now = this.ctx.now();
      const stillValid = cur.certPem !== null && cur.notAfter !== null && cur.notAfter > now;
      if (signal.aborted) {
        // Module switched off or core stopping: try again later, not a failure.
        this.ctx.db
          .update(certificates)
          .set({ status: stillValid ? 'valid' : 'pending', nextAttemptAt: now, updatedAt: now })
          .where(eq(certificates.id, id))
          .run();
        return;
      }
      const reason =
        err instanceof AcmeError || err instanceof ProviderError || err instanceof DomainsHttpError
          ? err.reason
          : 'Unbekannter Fehler';
      this.ctx.log.warn({ certId: id, reason }, 'certificate issue failed');
      const failures = cur.failures + 1;
      const delay = CERT_BACKOFF_MS[Math.min(failures - 1, CERT_BACKOFF_MS.length - 1)] ?? DAY;
      // Without auto renew only a first issue is retried; a renewal waits for the admin.
      const retry = cur.autoRenew || cur.certPem === null;
      this.ctx.db
        .update(certificates)
        .set({
          status: stillValid ? 'valid' : 'error',
          failures,
          lastError: reason.slice(0, 200),
          nextAttemptAt: retry ? now + delay : null,
          updatedAt: now,
        })
        .where(eq(certificates.id, id))
        .run();
      this.evaluateAlert(id);
    }
  }

  private async waitTxt(name: string, value: string): Promise<void> {
    const max = this.deps.dnsMaxPolls ?? 36;
    for (let i = 0; i < max; i++) {
      try {
        const records = await this.resolveTxt(name);
        if (records.some((r) => r.join('') === value)) return;
      } catch {
        // NXDOMAIN / no data yet: keep waiting.
      }
      await this.sleep(this.deps.dnsPollMs ?? 5_000);
    }
    throw new ProviderError('TXT-Eintrag wurde im DNS nicht sichtbar');
  }

  /** cert:<id>: warn at CERT_WARN_DAYS, crit at CERT_CRIT_DAYS or after two failed attempts. */
  private evaluateAlert(id: string): void {
    if (!this.enabled) return;
    const row = this.certRow(id);
    if (!row) return;
    const name = namesOf(row)[0] ?? id;
    const key = certAlertKey(id);
    const now = this.ctx.now();
    const daysLeft = row.notAfter === null ? null : Math.floor((row.notAfter - now) / DAY);
    if (row.failures >= 2) {
      this.ctx.alerts.raise(
        key,
        'crit',
        `Zertifikat ${name} konnte nicht ausgestellt werden`,
        `${row.failures} Versuche fehlgeschlagen: ${row.lastError ?? 'unbekannt'}`.slice(0, 300),
        null,
        'system',
      );
      return;
    }
    if (daysLeft !== null && daysLeft <= CERT_WARN_DAYS) {
      const crit = daysLeft <= CERT_CRIT_DAYS;
      this.ctx.alerts.raise(
        key,
        crit ? 'crit' : 'warn',
        daysLeft < 0 ? `Zertifikat ${name} abgelaufen` : `Zertifikat ${name} läuft bald ab`,
        daysLeft < 0
          ? 'Das Zertifikat ist abgelaufen.'
          : `Noch ${daysLeft} ${daysLeft === 1 ? 'Tag' : 'Tage'} gültig.`,
        null,
        'system',
      );
      return;
    }
    this.ctx.alerts.resolve(key);
  }

  /**
   * cert.write to the deploy targets (all when `only` is null). Results are
   * merged into deploy_json in one synchronous step.
   */
  private async deploy(
    id: string,
    only: readonly { serverId: string; name: string }[] | null,
  ): Promise<void> {
    const row = this.certRow(id);
    if (!row?.certPem || !row.keyEnc || !this.enabled) return;
    const targets = deployOf(row).filter(
      (d) => only === null || only.some((o) => o.serverId === d.serverId && o.name === d.name),
    );
    if (targets.length === 0) return;
    const privkeyPem = this.ctx.box.decrypt(row.keyEnc, CERT_KEY_AAD);
    const fullchainPem = row.certPem;
    const results = await Promise.all(
      targets.map(async (t) => {
        try {
          if (!this.ctx.hub.isConnected(t.serverId)) throw new RpcError('offline');
          await this.ctx.hub.call(
            t.serverId,
            'cert.write',
            { name: t.name, fullchainPem, privkeyPem },
            { timeoutMs: CERT_RPC_TIMEOUT_MS },
          );
          return { t, error: null };
        } catch (err) {
          const reason = rpcReason(err);
          this.ctx.log.warn({ certId: id, serverId: t.serverId, reason }, 'cert.write failed');
          return { t, error: reason };
        }
      }),
    );
    const cur = this.certRow(id);
    if (!cur || cur.issuedAt !== row.issuedAt) return;
    const now = this.ctx.now();
    const next = deployOf(cur).map((d) => {
      const r = results.find((x) => x.t.serverId === d.serverId && x.t.name === d.name);
      if (!r) return d;
      return r.error === null
        ? { ...d, deployedAt: now, lastError: null }
        : { ...d, lastError: r.error };
    });
    this.ctx.db
      .update(certificates)
      .set({ deployJson: JSON.stringify(next) })
      .where(eq(certificates.id, id))
      .run();
  }

  /** A server came back: deploy what it missed. */
  onServerConnected(serverId: string): void {
    if (!this.enabled) return;
    for (const row of this.ctx.db.select().from(certificates).all()) {
      if (!row.certPem || row.issuedAt === null) continue;
      const issuedAt = row.issuedAt;
      const missing = deployOf(row).filter(
        (d) => d.serverId === serverId && (d.deployedAt === null || d.deployedAt < issuedAt),
      );
      if (missing.length > 0) void this.track(this.deploy(row.id, missing));
    }
  }

  /** Minute job: retries whose time has come (backoff) and new certificates. */
  certTick(): void {
    if (!this.enabled) return;
    const now = this.ctx.now();
    for (const row of this.ctx.db.select().from(certificates).all()) {
      if (row.nextAttemptAt === null || row.nextAttemptAt > now) continue;
      this.startIssue(row.id);
    }
  }

  /** Daily 04:00: expiry alerts and renewal CERT_RENEW_DAYS before expiry. */
  dailyRenew(): void {
    if (!this.enabled) return;
    const now = this.ctx.now();
    for (const row of this.ctx.db.select().from(certificates).all()) {
      if (row.status === 'valid' && row.notAfter !== null && row.notAfter <= now) {
        this.ctx.db
          .update(certificates)
          .set({ status: 'expired', updatedAt: now })
          .where(eq(certificates.id, row.id))
          .run();
      }
      this.evaluateAlert(row.id);
      if (!row.autoRenew || row.notAfter === null || row.nextAttemptAt !== null) continue;
      if (row.notAfter - now > CERT_RENEW_DAYS * DAY) continue;
      this.ctx.db
        .update(certificates)
        .set({ nextAttemptAt: now, updatedAt: now })
        .where(eq(certificates.id, row.id))
        .run();
      this.startIssue(row.id);
    }
  }
}

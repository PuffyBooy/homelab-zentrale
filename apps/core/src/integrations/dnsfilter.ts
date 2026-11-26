import { z } from 'zod';
import type { DnsFilterStatus, DnsFilterVariant, dnsFilterBlockingRequestSchema } from '@hz/shared';
import { IntegrationService, type IntegrationDeps, type ReadyConfig } from './base.js';
import {
  IntegrationError,
  jsonBody,
  requireOk,
  type IntegrationRequest,
  type IntegrationResponse,
} from './http.js';
import type { IntegrationConfig } from './store.js';

type BlockingRequest = z.output<typeof dnsFilterBlockingRequestSchema>;

export const DNS_POLL_MS = 30_000;
export const DNS_CACHE_MS = 10_000;

export interface DnsData {
  variant: DnsFilterVariant;
  blocking: boolean | null;
  pausedUntil: number | null;
  queriesToday: number | null;
  blockedToday: number | null;
  percentBlocked: number | null;
  domainsOnLists: number | null;
}

const count = z.number().finite().min(0).nullable().optional().catch(null);
const int = (v: number | null | undefined): number | null =>
  v === null || v === undefined ? null : Math.floor(v);
const percent = (v: number | null): number | null =>
  v === null ? null : Math.min(100, Math.max(0, Math.round(v * 10) / 10));

function parse<T>(schema: z.ZodType<T>, res: IntegrationResponse): T {
  const p = schema.safeParse(jsonBody(requireOk(res)));
  if (!p.success) throw new IntegrationError('Unerwartete Antwort');
  return p.data;
}

// ---- Pi-hole v6 ----------------------------------------------------------------------

const piAuthSchema = z.object({
  session: z.object({ valid: z.boolean(), sid: z.string().max(200).nullable().optional() }),
});
const piSummarySchema = z.object({
  queries: z.object({ total: count, blocked: count, percent_blocked: count }).optional(),
  gravity: z.object({ domains_being_blocked: count }).optional(),
});
const piBlockingSchema = z.object({
  blocking: z.string(),
  timer: z.number().finite().min(0).nullable().optional().catch(null),
});

// ---- AdGuard Home -----------------------------------------------------------------------

const agStatsSchema = z.object({ num_dns_queries: count, num_blocked_filtering: count });
const agStatusSchema = z.object({
  protection_enabled: z.boolean(),
  protection_disabled_duration: count,
});
const agFilteringSchema = z.object({
  filters: z
    .array(z.object({ rules_count: count, enabled: z.boolean().optional().catch(undefined) }))
    .nullable()
    .optional()
    .catch(null),
});

/**
 * DNS filter (SPEC 16): Pi-hole v6 (REST API, session id) or AdGuard Home
 * (Basic auth). Statistics and pausing for 5/15/30/60 minutes; a pause always
 * has an end, the filter turns blocking on again by itself.
 */
export class DnsFilterService extends IntegrationService<DnsData> {
  /** Pi-hole session id (memory only, never logged). */
  private sid: string | null = null;

  constructor(deps: IntegrationDeps) {
    super(deps, 'dnsfilter', 'DNS-Filter', DNS_POLL_MS, DNS_CACHE_MS);
  }

  private variantOf(cfg: { variant: DnsFilterVariant | null }): DnsFilterVariant {
    return cfg.variant ?? 'pihole';
  }

  protected override needsUsername(cfg: IntegrationConfig): boolean {
    return this.variantOf(cfg) === 'adguard';
  }

  protected override onReset(): void {
    this.sid = null;
  }

  // ---- Pi-hole ---------------------------------------------------------------------

  private async piAuth(cfg: ReadyConfig): Promise<string | null> {
    const res = await this.deps.http.request({
      base: cfg.url,
      path: '/api/auth',
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ password: cfg.secret }),
      ca: cfg.caCert,
    });
    const auth = parse(piAuthSchema, res);
    if (!auth.session.valid) throw new IntegrationError('Zugangsdaten ungültig');
    return auth.session.sid ?? null;
  }

  /** Request with the session id; on 401 authenticate again once. */
  private async pi(
    cfg: ReadyConfig,
    req: Omit<IntegrationRequest, 'base' | 'ca'>,
  ): Promise<IntegrationResponse> {
    const send = (sid: string | null): Promise<IntegrationResponse> =>
      this.deps.http.request({
        ...req,
        base: cfg.url,
        ca: cfg.caCert,
        headers: {
          accept: 'application/json',
          ...req.headers,
          ...(sid !== null ? { 'x-ftl-sid': sid } : {}),
        },
      });
    const gen = this.generation;
    if (this.sid === null) {
      const sid = await this.piAuth(cfg);
      if (gen === this.generation) this.sid = sid;
    }
    let res = await send(this.sid);
    if (res.status === 401) {
      const sid = await this.piAuth(cfg);
      if (gen === this.generation) this.sid = sid;
      res = await send(sid);
    }
    return res;
  }

  private async piFetch(cfg: ReadyConfig): Promise<DnsData> {
    const summary = parse(piSummarySchema, await this.pi(cfg, { path: '/api/stats/summary' }));
    const blocking = parse(piBlockingSchema, await this.pi(cfg, { path: '/api/dns/blocking' }));
    const now = this.deps.now();
    const on =
      blocking.blocking === 'enabled' ? true : blocking.blocking === 'disabled' ? false : null;
    return {
      variant: 'pihole',
      blocking: on,
      pausedUntil:
        on === false && blocking.timer !== null && blocking.timer !== undefined
          ? now + Math.round(blocking.timer * 1000)
          : null,
      queriesToday: int(summary.queries?.total),
      blockedToday: int(summary.queries?.blocked),
      percentBlocked: percent(summary.queries?.percent_blocked ?? null),
      domainsOnLists: int(summary.gravity?.domains_being_blocked),
    };
  }

  // ---- AdGuard Home ------------------------------------------------------------------

  private ag(
    cfg: ReadyConfig,
    req: Omit<IntegrationRequest, 'base' | 'ca'>,
  ): Promise<IntegrationResponse> {
    const basic = Buffer.from(`${cfg.username ?? ''}:${cfg.secret}`, 'utf8').toString('base64');
    return this.deps.http.request({
      ...req,
      base: cfg.url,
      ca: cfg.caCert,
      headers: { accept: 'application/json', ...req.headers, authorization: `Basic ${basic}` },
    });
  }

  private async agFetch(cfg: ReadyConfig): Promise<DnsData> {
    const stats = parse(agStatsSchema, await this.ag(cfg, { path: '/control/stats' }));
    const status = parse(agStatusSchema, await this.ag(cfg, { path: '/control/status' }));
    const filtering = parse(
      agFilteringSchema,
      await this.ag(cfg, { path: '/control/filtering/status' }),
    );
    const queries = int(stats.num_dns_queries);
    const blocked = int(stats.num_blocked_filtering);
    let rules: number | null = null;
    for (const f of filtering.filters ?? []) {
      if (f.enabled === false || f.rules_count === null || f.rules_count === undefined) continue;
      rules = (rules ?? 0) + Math.floor(f.rules_count);
    }
    const remaining = status.protection_disabled_duration;
    return {
      variant: 'adguard',
      blocking: status.protection_enabled,
      pausedUntil:
        !status.protection_enabled && remaining !== null && remaining !== undefined && remaining > 0
          ? this.deps.now() + Math.round(remaining)
          : null,
      queriesToday: queries,
      blockedToday: blocked,
      percentBlocked:
        queries !== null && blocked !== null && queries > 0
          ? percent((blocked / queries) * 100)
          : 0,
      domainsOnLists: rules,
    };
  }

  protected fetch(cfg: ReadyConfig): Promise<DnsData> {
    return this.variantOf(cfg) === 'adguard' ? this.agFetch(cfg) : this.piFetch(cfg);
  }

  async filterStatus(): Promise<DnsFilterStatus> {
    return this.view(await this.current());
  }

  private view(c: {
    data: DnsData | null;
    fetchedAt: number | null;
    error: string | null;
  }): DnsFilterStatus {
    const cfg = this.store.config();
    const d = c.data;
    return {
      variant: cfg.url === null ? null : this.variantOf(cfg),
      blocking: d?.blocking ?? null,
      pausedUntil: this.iso(d?.pausedUntil ?? null),
      queriesToday: d?.queriesToday ?? null,
      blockedToday: d?.blockedToday ?? null,
      percentBlocked: d?.percentBlocked ?? null,
      domainsOnLists: d?.domainsOnLists ?? null,
      fetchedAt: this.iso(c.fetchedAt),
      error: c.error,
    };
  }

  /** Pause (always with an end) or turn blocking on again. */
  async setBlocking(body: BlockingRequest): Promise<DnsFilterStatus> {
    await this.act(async (cfg) => {
      if (this.variantOf(cfg) === 'adguard') {
        const payload = body.enabled
          ? { enabled: true }
          : { enabled: false, duration: body.minutes * 60_000 };
        requireOk(
          await this.ag(cfg, {
            path: '/control/protection',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        );
      } else {
        const payload = body.enabled
          ? { blocking: true }
          : { blocking: false, timer: body.minutes * 60 };
        requireOk(
          await this.pi(cfg, {
            path: '/api/dns/blocking',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        );
      }
    });
    this.invalidate();
    return this.view(await this.current());
  }
}

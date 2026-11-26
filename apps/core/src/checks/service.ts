import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  checkDefSchema,
  checkResultDataSchema,
  urlHasUserinfo,
  type CheckDef,
  type CheckSummary,
} from '@hz/shared';
import { RpcError, type AgentHub } from '../agents/hub.js';
import type { AlertService } from '../alerts/service.js';
import { nextWallClock } from '../calendar.js';
import { zonedFormat } from '../timezone.js';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import type { Db } from '../db/index.js';
import {
  certStatus,
  checkResults,
  checks,
  servers,
  type CertStatusRow,
  type CheckRow,
} from '../db/schema.js';
import { clockTime, clockTimeRelative, duration } from '../format.js';
import type { Scheduler } from '../scheduler.js';
import {
  DAY,
  daysLeft,
  evaluate,
  formatMs,
  inDays,
  nextStreak,
  sparkline,
  uptimePercent,
  type CheckStatus,
  type Evaluation,
  type Streak,
} from './evaluate.js';
import {
  httpProbe,
  PROBE_TIMEOUT_MS,
  reasonForAgentError,
  tcpProbe,
  type ProbeResult,
} from './probe.js';
import { lookupDomainExpiry, registrableDomain, type FetchLike } from './rdap.js';

const HOUR = 60 * 60 * 1000;
/** Raw results are kept this long (uptime 30 d needs them). */
export const RESULT_RETENTION_MS = 30 * DAY;
/** The agent gets the probe timeout plus this margin to answer the RPC. */
const AGENT_RPC_MARGIN_MS = 5_000;
const SPARK_BUCKETS = 48;
const MAX_REASON = 160;

export type CheckListener = (id: string, deleted: boolean) => void;
export type HistoryRange = '24h' | '7d' | '30d';
export interface HistoryPoint {
  ts: string;
  ok: boolean;
  ms: number | null;
  code: number | null;
}

type Outcome = { kind: 'result'; result: ProbeResult } | { kind: 'unavailable'; reason: string };

const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

const STATUS_ORDER: Record<CheckStatus, number> = { crit: 0, warn: 1, busy: 2, ok: 3, off: 4 };

/** Agent texts go into alerts and the UI: no credentials, short. */
export function sanitizeReason(text: string): string {
  const cleaned = text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1')
    .trim();
  return cleaned.length > MAX_REASON ? `${cleaned.slice(0, MAX_REASON - 1)}…` : cleaned;
}

function targetOf(def: CheckDef): string {
  if (def.kind === 'http') {
    const u = new URL(def.url);
    return u.host;
  }
  return def.kind === 'tcp' ? `${def.host}:${def.port}` : def.host;
}

function helpText(def: CheckDef): string {
  switch (def.kind) {
    case 'http':
      return 'Prüfe, ob der Dienst läuft und die Adresse stimmt.';
    case 'tcp':
      return `Prüfe, ob der Dienst auf Port ${def.port} läuft.`;
    case 'ping':
      return 'Prüfe, ob das Gerät eingeschaltet und im Netz ist.';
  }
}

const dateFmt = zonedFormat('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' });

export interface CheckServiceDeps {
  db: Db;
  now: Clock;
  scheduler: Scheduler;
  alerts: AlertService;
  hub: Pick<AgentHub, 'call'>;
  log: FastifyBaseLogger;
  /** RDAP transport (tests inject one; production uses global fetch). */
  rdapFetch?: FetchLike;
}

/**
 * Website and port checks (SPEC 8): definitions, scheduling per interval,
 * execution in the core or on an agent, results, status rules, alerts and
 * domain expiry.
 */
export class CheckService {
  private readonly listeners = new Set<CheckListener>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly background = new Set<Promise<void>>();
  private readonly jobs = new Map<string, () => void>();

  constructor(private readonly deps: CheckServiceDeps) {}

  onChange(fn: CheckListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(id: string, deleted = false): void {
    for (const fn of this.listeners) fn(id, deleted);
  }

  /** Registers the jobs of all checks plus pruning and the daily RDAP run. */
  start(): void {
    const s = this.deps.scheduler;
    for (const row of this.deps.db.select().from(checks).all()) this.schedule(row);
    s.every('checks.prune', HOUR, () => this.prune());
    s.at(
      'checks.rdap',
      (from) => nextWallClock(from, { hour: 4, minute: 0 }),
      () => this.refreshDomains(),
    );
  }

  private schedule(row: CheckRow): void {
    this.unschedule(row.id);
    if (!row.enabled) return;
    const id = row.id;
    const remove = this.deps.scheduler.every(
      `check:${id}`,
      row.intervalS * 1000,
      () => {
        // Not awaited: a slow check (10 s timeout) must not hold up other jobs.
        void this.run(id);
      },
      { immediate: true },
    );
    this.jobs.set(id, remove);
  }

  private unschedule(id: string): void {
    this.jobs.get(id)?.();
    this.jobs.delete(id);
  }

  /** Resolves once all running checks and background lookups are done (tests). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0 || this.background.size > 0) {
      await Promise.allSettled([...this.inflight.values(), ...this.background]);
    }
  }

  private track(p: Promise<void>): void {
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  // ---- definitions -----------------------------------------------------------

  row(id: string): CheckRow | undefined {
    return this.deps.db.select().from(checks).where(eq(checks.id, id)).get();
  }

  private defOf(row: CheckRow): CheckDef {
    const def = checkDefSchema.parse(JSON.parse(row.defJson));
    return { ...def, serverId: row.serverId };
  }

  private serverExists(id: string): boolean {
    return (
      this.deps.db.select({ id: servers.id }).from(servers).where(eq(servers.id, id)).get() !==
      undefined
    );
  }

  /** Extra rules beyond the schema. Returns false if the definition is invalid. */
  validate(def: CheckDef): boolean {
    if (def.kind === 'http') {
      if (urlHasUserinfo(def.url)) return false;
      if (def.expectStatusMin > def.expectStatusMax) return false;
    }
    if (def.runFrom !== 'core' && !this.serverExists(def.runFrom)) return false;
    if (def.serverId !== null && !this.serverExists(def.serverId)) return false;
    return true;
  }

  create(def: CheckDef): CheckSummary {
    const now = this.deps.now();
    const row: CheckRow = {
      id: randomToken(12),
      name: def.name,
      kind: def.kind,
      defJson: JSON.stringify(def),
      runFrom: def.runFrom,
      serverId: def.serverId,
      intervalS: def.intervalS,
      enabled: def.enabled,
      status: def.enabled ? 'busy' : 'off',
      reason: null,
      lastCode: null,
      lastMs: null,
      lastCheckedAt: null,
      consecutiveFailures: 0,
      consecutiveSlow: 0,
      downSince: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db.insert(checks).values(row).run();
    this.schedule(row);
    this.track(this.refreshDomainOf(row.id));
    this.emit(row.id);
    return this.summaryOf(row);
  }

  /**
   * Replaces the definition. State, certificate data and alerts start fresh,
   * because the target may have changed; the history stays.
   */
  update(id: string, def: CheckDef): CheckSummary | null {
    const existing = this.row(id);
    if (!existing) return null;
    const now = this.deps.now();
    this.deps.db
      .update(checks)
      .set({
        name: def.name,
        kind: def.kind,
        defJson: JSON.stringify(def),
        runFrom: def.runFrom,
        serverId: def.serverId,
        intervalS: def.intervalS,
        enabled: def.enabled,
        status: def.enabled ? 'busy' : 'off',
        reason: null,
        lastCode: null,
        lastMs: null,
        lastCheckedAt: null,
        consecutiveFailures: 0,
        consecutiveSlow: 0,
        downSince: null,
        updatedAt: now,
      })
      .where(eq(checks.id, id))
      .run();
    this.deps.db.delete(certStatus).where(eq(certStatus.checkId, id)).run();
    this.deps.alerts.resolveAllWithPrefix(`check:${id}:`);
    const row = this.row(id);
    if (!row) return null;
    this.schedule(row);
    this.track(this.refreshDomainOf(id));
    this.emit(id);
    return this.summaryOf(row);
  }

  remove(id: string): boolean {
    if (!this.row(id)) return false;
    this.unschedule(id);
    this.deps.alerts.resolveAllWithPrefix(`check:${id}:`);
    this.deps.db.delete(checks).where(eq(checks.id, id)).run();
    this.emit(id, true);
    return true;
  }

  // ---- execution ---------------------------------------------------------------

  /** Runs a check now. Concurrent calls for the same check share one run. */
  run(id: string): Promise<void> {
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.execute(id)
      .catch((err: unknown) => {
        this.deps.log.error(
          { checkId: id, err: err instanceof Error ? err.name : 'error' },
          'check run failed',
        );
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async probe(def: CheckDef): Promise<Outcome> {
    if (def.runFrom === 'core') {
      if (def.kind === 'http') {
        return {
          kind: 'result',
          result: await httpProbe({
            url: def.url,
            expectStatusMin: def.expectStatusMin,
            expectStatusMax: def.expectStatusMax,
            contains: def.contains,
          }),
        };
      }
      if (def.kind === 'tcp') {
        return { kind: 'result', result: await tcpProbe(def.host, def.port) };
      }
      // Ping (ICMP) only runs on an agent; the schema already requires one.
      return { kind: 'unavailable', reason: 'Ping nur über einen Agent' };
    }
    const opts = { timeoutMs: PROBE_TIMEOUT_MS + AGENT_RPC_MARGIN_MS };
    let data: unknown;
    try {
      if (def.kind === 'http') {
        data = await this.deps.hub.call(
          def.runFrom,
          'check.http',
          {
            url: def.url,
            expectStatusMin: def.expectStatusMin,
            expectStatusMax: def.expectStatusMax,
            ...(def.contains !== undefined ? { contains: def.contains } : {}),
            timeoutMs: PROBE_TIMEOUT_MS,
          },
          opts,
        );
      } else if (def.kind === 'tcp') {
        data = await this.deps.hub.call(
          def.runFrom,
          'check.tcp',
          { host: def.host, port: def.port, timeoutMs: PROBE_TIMEOUT_MS },
          opts,
        );
      } else {
        data = await this.deps.hub.call(
          def.runFrom,
          'check.ping',
          { host: def.host, timeoutMs: PROBE_TIMEOUT_MS },
          opts,
        );
      }
    } catch (err) {
      if (err instanceof RpcError && (err.code === 'offline' || err.code === 'disconnected')) {
        return { kind: 'unavailable', reason: 'Agent offline' };
      }
      if (err instanceof RpcError && err.code === 'timeout') {
        return { kind: 'unavailable', reason: 'Agent antwortet nicht' };
      }
      return { kind: 'unavailable', reason: 'Agent kann den Check nicht ausführen' };
    }
    const parsed = checkResultDataSchema.safeParse(data);
    if (!parsed.success) return { kind: 'unavailable', reason: 'Antwort des Agents ungültig' };
    const r = parsed.data;
    const tls = r.tlsExpiresAt !== undefined ? Date.parse(r.tlsExpiresAt) : Number.NaN;
    return {
      kind: 'result',
      result: {
        ok: r.ok,
        ms: r.ms,
        ...(r.code !== undefined ? { code: r.code } : {}),
        ...(!r.ok
          ? {
              error: r.error
                ? reasonForAgentError(r.error, PROBE_TIMEOUT_MS)
                : r.code
                  ? `HTTP ${r.code}`
                  : 'Fehlschlag',
            }
          : {}),
        ...(Number.isFinite(tls) ? { tlsExpiresAt: tls } : {}),
      },
    };
  }

  private async execute(id: string): Promise<void> {
    const before = this.row(id);
    if (!before?.enabled) return;
    const def = this.defOf(before);
    const outcome = await this.probe(def);
    // The check may have been edited or deleted while the probe ran.
    const row = this.row(id);
    if (!row?.enabled || row.updatedAt !== before.updatedAt) return;
    const now = this.deps.now();
    const prev: Streak = {
      consecutiveFailures: row.consecutiveFailures,
      consecutiveSlow: row.consecutiveSlow,
      downSince: row.downSince,
    };

    if (outcome.kind === 'unavailable') {
      this.deps.db
        .update(checks)
        .set({ status: 'off', reason: outcome.reason, lastCheckedAt: now })
        .where(eq(checks.id, id))
        .run();
      this.emit(id);
      return;
    }

    const r = outcome.result;
    this.deps.db
      .insert(checkResults)
      .values({
        checkId: id,
        ts: now,
        ok: r.ok,
        code: r.code ?? null,
        ms: r.ms,
        error: r.ok ? null : (r.error ?? null),
      })
      .run();
    if (def.kind === 'http' && def.certCheck && r.tlsExpiresAt !== undefined) {
      this.upsertCert(id, { sslExpiresAt: r.tlsExpiresAt, checkedAt: now });
    }
    const streak = nextStreak(prev, r, now);
    const ev = this.evaluation(row, def, {
      streak,
      lastError: r.ok ? null : (r.error ?? null),
      lastMs: r.ms,
      pending: false,
      unavailable: null,
    });
    this.deps.db
      .update(checks)
      .set({
        status: ev.status,
        reason: ev.reason,
        lastCode: r.code ?? null,
        lastMs: r.ms,
        lastCheckedAt: now,
        consecutiveFailures: streak.consecutiveFailures,
        consecutiveSlow: streak.consecutiveSlow,
        downSince: streak.downSince,
      })
      .where(eq(checks.id, id))
      .run();
    this.applyAlerts(row, def, ev, { ok: r.ok, ms: r.ms, reason: ev.reason, prev, now });
    this.emit(id);
  }

  private cert(id: string): CertStatusRow | undefined {
    return this.deps.db.select().from(certStatus).where(eq(certStatus.checkId, id)).get();
  }

  private upsertCert(id: string, values: Partial<Omit<CertStatusRow, 'checkId'>>): void {
    this.deps.db
      .insert(certStatus)
      .values({ checkId: id, ...values })
      .onConflictDoUpdate({ target: certStatus.checkId, set: values })
      .run();
  }

  private evaluation(
    row: CheckRow,
    def: CheckDef,
    s: {
      streak: Streak;
      lastError: string | null;
      lastMs: number | null;
      pending: boolean;
      unavailable: string | null;
    },
  ): Evaluation {
    const now = this.deps.now();
    const cert = this.cert(row.id);
    const certOn = def.kind === 'http' && def.certCheck;
    const https = def.kind === 'http' && def.url.startsWith('https:');
    const ssl = certOn && https && cert?.sslExpiresAt != null ? cert.sslExpiresAt : null;
    const domain = certOn && cert?.domainExpiresAt != null ? cert.domainExpiresAt : null;
    return evaluate({
      enabled: row.enabled,
      unavailable: s.unavailable,
      pending: s.pending,
      streak: s.streak,
      lastError: s.lastError,
      lastMs: s.lastMs,
      sslDays: ssl === null ? null : daysLeft(ssl, now),
      domainDays: domain === null ? null : daysLeft(domain, now),
    });
  }

  private alertServerId(row: CheckRow): string | null {
    if (row.serverId && this.serverExists(row.serverId)) return row.serverId;
    if (row.runFrom !== 'core' && this.serverExists(row.runFrom)) return row.runFrom;
    return null;
  }

  private fromText(row: CheckRow): string {
    if (row.runFrom === 'core') return '';
    const s = this.deps.db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, row.runFrom))
      .get();
    return s ? ` Geprüft von ${s.name} aus.` : '';
  }

  /**
   * Check alerts (dedupe keys `check:<id>:down|slow|ssl|domain`). Down and
   * slow only react to real results; certificate and domain alerts also to the
   * daily RDAP refresh.
   */
  private applyAlerts(
    row: CheckRow,
    def: CheckDef,
    ev: Evaluation,
    result: {
      ok: boolean;
      ms: number | null;
      reason: string | null;
      prev: Streak;
      now: number;
    } | null,
  ): void {
    const a = this.deps.alerts;
    const key = (k: string): string => `check:${row.id}:${k}`;
    const serverId = this.alertServerId(row);
    const now = this.deps.now();
    const name = row.name;

    if (result) {
      if (ev.down) {
        const since = result.prev.downSince ?? now;
        a.raise(
          key('down'),
          'crit',
          `${name} ist nicht erreichbar`,
          `Seit ${clockTimeRelative(since, now)}: ${result.reason ?? 'keine Antwort'} (${targetOf(def)}). ${helpText(def)}${this.fromText(row)}`,
          serverId,
          'check',
        );
      } else if (result.ok) {
        const active = a.active(key('down'));
        if (active) {
          const since = result.prev.downSince ?? Date.parse(active.openedAt);
          a.resolve(key('down'), {
            title: `${name} ist wieder erreichbar`,
            body: `Nach ${duration(now - since)} Ausfall wieder erreichbar, seit ${clockTime(now)}.`,
          });
        }
      }
      if (ev.slow && result.ms !== null) {
        a.raise(
          key('slow'),
          'warn',
          `${name} antwortet langsam`,
          `${formatMs(result.ms)} seit ${clockTime(now)}, mehr als 800 ms. Prüfe die Last auf dem Server.`,
          serverId,
          'check',
        );
      } else if (result.ok) {
        a.resolve(key('slow'), {
          title: `${name} antwortet wieder schnell`,
          body: `${result.ms !== null ? formatMs(result.ms) : 'Normal'} seit ${clockTime(now)}.`,
        });
      }
    }

    const cert = this.cert(row.id);
    if (ev.ssl && cert?.sslExpiresAt != null) {
      a.raise(
        key('ssl'),
        ev.ssl,
        `SSL-Zertifikat von ${name} läuft ab`,
        `Läuft ${inDays(daysLeft(cert.sslExpiresAt, now))} ab, am ${dateFmt().format(cert.sslExpiresAt)}. Zertifikat erneuern.`,
        serverId,
        'check',
      );
    } else if (cert?.sslExpiresAt != null) {
      a.resolve(key('ssl'), {
        title: `SSL-Zertifikat von ${name} erneuert`,
        body: `Gültig bis ${dateFmt().format(cert.sslExpiresAt)}.`,
      });
    }
    if (ev.domain && cert?.domainExpiresAt != null) {
      a.raise(
        key('domain'),
        'warn',
        `Domain von ${name} läuft ab`,
        `Läuft ${inDays(daysLeft(cert.domainExpiresAt, now))} ab, am ${dateFmt().format(cert.domainExpiresAt)}. Beim Registrar verlängern.`,
        serverId,
        'check',
      );
    } else if (cert?.domainExpiresAt != null) {
      a.resolve(key('domain'), {
        title: `Domain von ${name} verlängert`,
        body: `Registriert bis ${dateFmt().format(cert.domainExpiresAt)}.`,
      });
    }
  }

  /** Recomputes status and cert/domain alerts from stored state (after RDAP). */
  private reevaluate(id: string): void {
    const row = this.row(id);
    if (!row) return;
    const def = this.defOf(row);
    const last = this.deps.db
      .select({ error: checkResults.error })
      .from(checkResults)
      .where(eq(checkResults.checkId, id))
      .orderBy(sql`${checkResults.ts} DESC`)
      .limit(1)
      .get();
    const ev = this.evaluation(row, def, {
      streak: {
        consecutiveFailures: row.consecutiveFailures,
        consecutiveSlow: row.consecutiveSlow,
        downSince: row.downSince,
      },
      lastError: last?.error ?? null,
      lastMs: row.lastMs,
      pending: row.lastCheckedAt === null,
      unavailable: row.status === 'off' && row.enabled ? row.reason : null,
    });
    this.deps.db
      .update(checks)
      .set({ status: ev.status, reason: ev.reason })
      .where(eq(checks.id, id))
      .run();
    this.applyAlerts(row, def, ev, null);
    this.emit(id);
  }

  // ---- RDAP --------------------------------------------------------------------

  private domainOf(row: CheckRow): string | null {
    if (row.kind !== 'http' || !row.enabled) return null;
    const def = this.defOf(row);
    if (def.kind !== 'http' || !def.certCheck) return null;
    return registrableDomain(new URL(def.url).hostname);
  }

  private async refreshDomainOf(id: string): Promise<void> {
    const row = this.row(id);
    const domain = row ? this.domainOf(row) : null;
    if (!domain) return;
    const expiry = await lookupDomainExpiry(domain, this.deps.rdapFetch);
    if (!this.row(id)) return;
    this.storeDomain(id, expiry);
    this.reevaluate(id);
  }

  private storeDomain(id: string, expiry: number | null): void {
    const now = this.deps.now();
    this.upsertCert(id, {
      domainCheckedAt: now,
      ...(expiry !== null ? { domainExpiresAt: expiry } : {}),
    });
  }

  /** Daily job: domain expiry for every https/http check with certCheck. */
  async refreshDomains(): Promise<void> {
    const byDomain = new Map<string, string[]>();
    for (const row of this.deps.db.select().from(checks).all()) {
      const d = this.domainOf(row);
      if (!d) continue;
      byDomain.set(d, [...(byDomain.get(d) ?? []), row.id]);
    }
    for (const [domain, ids] of byDomain) {
      const expiry = await lookupDomainExpiry(domain, this.deps.rdapFetch);
      for (const id of ids) {
        if (!this.row(id)) continue;
        this.storeDomain(id, expiry);
        this.reevaluate(id);
      }
    }
  }

  // ---- results -------------------------------------------------------------------

  prune(): void {
    this.deps.db
      .delete(checkResults)
      .where(lt(checkResults.ts, this.deps.now() - RESULT_RETENTION_MS))
      .run();
  }

  /** Uptime over the last `ms` (percent, null without data). */
  uptime(id: string, ms: number): number | null {
    const r = this.deps.db
      .select({
        total: sql<number>`count(*)`,
        ok: sql<number>`coalesce(sum(${checkResults.ok}), 0)`,
      })
      .from(checkResults)
      .where(and(eq(checkResults.checkId, id), gte(checkResults.ts, this.deps.now() - ms)))
      .get();
    return uptimePercent(r?.ok ?? 0, r?.total ?? 0);
  }

  private spark(id: string): number[] {
    const now = this.deps.now();
    const from = now - DAY;
    const rows = this.deps.db
      .select({ ts: checkResults.ts, ms: checkResults.ms })
      .from(checkResults)
      .where(and(eq(checkResults.checkId, id), gte(checkResults.ts, from)))
      .orderBy(asc(checkResults.ts))
      .all();
    return sparkline(rows, from, now + 1, SPARK_BUCKETS);
  }

  history(id: string, range: HistoryRange): HistoryPoint[] {
    const now = this.deps.now();
    const span = range === '24h' ? DAY : range === '7d' ? 7 * DAY : 30 * DAY;
    const from = now - span;
    const where = and(eq(checkResults.checkId, id), gte(checkResults.ts, from));
    if (range === '24h') {
      return this.deps.db
        .select()
        .from(checkResults)
        .where(where)
        .orderBy(asc(checkResults.ts))
        .all()
        .map((r) => ({ ts: new Date(r.ts).toISOString(), ok: r.ok, ms: r.ms, code: r.code }));
    }
    // Longer ranges: one point per bucket (1 h for 7 d, 6 h for 30 d).
    const bucket = range === '7d' ? HOUR : 6 * HOUR;
    // Integer literal, not a bound parameter: bound numbers are REAL in SQLite,
    // which would turn this into a float division.
    const b = sql<number>`(${checkResults.ts} / ${sql.raw(String(bucket))})`;
    return this.deps.db
      .select({
        b,
        ok: sql<number>`min(${checkResults.ok})`,
        ms: sql<number | null>`avg(${checkResults.ms})`,
      })
      .from(checkResults)
      .where(where)
      .groupBy(b)
      .orderBy(b)
      .all()
      .map((r) => ({
        ts: new Date(r.b * bucket).toISOString(),
        ok: r.ok === 1,
        ms: r.ms === null ? null : Math.round(r.ms),
        code: null,
      }));
  }

  // ---- summaries -----------------------------------------------------------------

  private summaryOf(row: CheckRow): CheckSummary {
    const cert = this.cert(row.id);
    return {
      id: row.id,
      def: this.defOf(row),
      status: row.status as CheckStatus,
      reason: row.reason,
      lastCode: row.lastCode,
      lastMs: row.lastMs,
      lastCheckedAt: iso(row.lastCheckedAt),
      consecutiveFailures: row.consecutiveFailures,
      sslExpiresAt: iso(cert?.sslExpiresAt),
      domainExpiresAt: iso(cert?.domainExpiresAt),
      uptime24h: this.uptime(row.id, DAY),
      uptime7d: this.uptime(row.id, 7 * DAY),
      uptime30d: this.uptime(row.id, 30 * DAY),
      spark: this.spark(row.id),
    };
  }

  summary(id: string): CheckSummary | null {
    const row = this.row(id);
    return row ? this.summaryOf(row) : null;
  }

  list(): CheckSummary[] {
    return this.deps.db
      .select()
      .from(checks)
      .all()
      .map((r) => this.summaryOf(r))
      .sort(
        (a, b) =>
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.def.name.localeCompare(b.def.name),
      );
  }

  /** Enabled checks with their uptime over `ms` (weekly report). */
  uptimes(ms: number): { name: string; uptime: number | null }[] {
    return this.deps.db
      .select()
      .from(checks)
      .where(eq(checks.enabled, true))
      .all()
      .map((r) => ({ name: r.name, uptime: this.uptime(r.id, ms) }));
  }
}

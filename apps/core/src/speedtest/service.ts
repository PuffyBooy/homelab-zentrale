import { asc, desc, eq, gte, lt } from 'drizzle-orm';
import {
  defaultSpeedtestSettings,
  speedtestDataSchema,
  speedtestResultSchema,
  speedtestSettingsSchema,
  SPEEDTEST_KEEP_DAYS,
  SPEEDTEST_MANUAL_GAP_MS,
  SPEEDTEST_SLOW_ALERT_KEY,
  SPEEDTEST_SLOW_STREAK,
  type SpeedtestResponse,
  type SpeedtestResult,
  type SpeedtestSettings,
} from '@hz/shared';
import { RpcError } from '../agents/hub.js';
import { writeAudit } from '../db/audit.js';
import { readSetting, writeSetting } from '../db/settings.js';
import { servers, speedtestResults, type SpeedtestResultRow } from '../db/schema.js';
import type { FeatureContext } from '../features.js';
import { clockTime } from '../format.js';
import { HttpError } from '../http/errors.js';

export const SPEEDTEST_SETTING = 'speedtest';
export const SPEEDTEST_TICK_MS = 60_000;
export const MSG_NO_SERVER = 'Kein Server für den Speedtest gewählt';
export const MSG_SERVER_OFFLINE = 'Der Speedtest-Server ist offline';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;

export type Trigger = 'schedule' | 'manual';

const mbps = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 1 });
const fmt = (v: number): string => `${mbps.format(v)} Mbit/s`;

const errorText = (err: unknown): string => {
  if (!(err instanceof RpcError)) return 'Messung fehlgeschlagen';
  switch (err.code) {
    case 'offline':
    case 'disconnected':
      return 'Server offline';
    case 'timeout':
      return 'Zeitüberschreitung';
    case 'busy':
      return 'Messung läuft bereits';
    case 'not_allowed':
      return 'Vom Agent abgelehnt';
    default:
      return 'Messung fehlgeschlagen';
  }
};

const avg = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;

/**
 * Speed test history (api/speedtest.ts). Job `speedtest.tick` (every minute)
 * starts a test when intervalHours have passed since the last start; "Jetzt
 * messen" starts one at once (409 busy, 429 within 5 min, 409 without server).
 * The agent only talks to speed.cloudflare.com (fixed in the agent).
 */
export class SpeedtestService {
  private running: Promise<void> | null = null;
  private lastStart: number | null = null;
  /** Base of the first scheduled test when there is no result yet. */
  private armedAt: number;
  private removeJob: (() => void) | null = null;
  private lastPrune = 0;

  constructor(
    private readonly ctx: FeatureContext,
    private readonly opts: { tickMs: number },
  ) {
    this.armedAt = ctx.now();
  }

  get enabled(): boolean {
    return this.ctx.modules.enabled('speedtest');
  }

  start(): void {
    if (this.removeJob) return;
    this.armedAt = this.ctx.now();
    this.removeJob = this.ctx.scheduler.every('speedtest.tick', this.opts.tickMs, () =>
      this.tick(),
    );
  }

  stop(): void {
    this.removeJob?.();
    this.removeJob = null;
  }

  disable(): void {
    this.stop();
    this.ctx.alerts.resolveAllWithPrefix('speedtest:');
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  // ---- settings ---------------------------------------------------------------------

  settings(): SpeedtestSettings {
    const p = speedtestSettingsSchema.safeParse(readSetting(this.ctx.db, SPEEDTEST_SETTING));
    return p.success ? p.data : { ...defaultSpeedtestSettings };
  }

  /** Merges a validated patch; the server must exist. */
  update(patch: { [K in keyof SpeedtestSettings]?: SpeedtestSettings[K] | undefined }): void {
    const now = this.ctx.now();
    const prev = this.settings();
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = speedtestSettingsSchema.parse({ ...prev, ...defined });
    if (next.serverId !== null && !this.serverExists(next.serverId)) {
      throw new HttpError(404, 'not_found');
    }
    writeSetting(this.ctx.db, SPEEDTEST_SETTING, next, now);
    if (next.serverId !== prev.serverId) this.armedAt = now;
    writeAudit(this.ctx.db, now, {
      actor: 'admin',
      action: 'speedtest.settings',
      details: { ...next },
    });
  }

  private serverExists(id: string): boolean {
    return (
      this.ctx.db.select({ id: servers.id }).from(servers).where(eq(servers.id, id)).get() !==
      undefined
    );
  }

  // ---- reads ------------------------------------------------------------------------

  private toResult(r: SpeedtestResultRow): SpeedtestResult {
    return speedtestResultSchema.parse({
      id: r.id,
      at: r.at,
      serverId: r.serverId,
      trigger: r.trigger,
      ok: r.ok,
      downloadMbps: r.downloadMbps,
      uploadMbps: r.uploadMbps,
      latencyMs: r.latencyMs,
      jitterMs: r.jitterMs,
      bytes: r.bytes,
      colo: r.colo,
      error: r.error,
    });
  }

  private lastResultAt(): number | null {
    return (
      this.ctx.db
        .select({ at: speedtestResults.at })
        .from(speedtestResults)
        .orderBy(desc(speedtestResults.at))
        .limit(1)
        .get()?.at ?? null
    );
  }

  /** Last start: in memory (also while running), else the newest stored result. */
  private lastStartAt(): number | null {
    const stored = this.lastResultAt();
    if (this.lastStart === null) return stored;
    return stored === null ? this.lastStart : Math.max(stored, this.lastStart);
  }

  nextRunAt(s = this.settings()): number | null {
    if (!this.enabled || s.serverId === null) return null;
    return (this.lastStartAt() ?? this.armedAt) + s.intervalHours * HOUR;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  response(days: number): SpeedtestResponse {
    const s = this.settings();
    const rows = this.ctx.db
      .select()
      .from(speedtestResults)
      .where(gte(speedtestResults.at, this.ctx.now() - days * DAY))
      .orderBy(asc(speedtestResults.at), asc(speedtestResults.id))
      .all();
    const results = rows.map((r) => this.toResult(r));
    const good = results.filter((r) => r.ok);
    const downs = good.flatMap((r) => (r.downloadMbps === null ? [] : [r.downloadMbps]));
    const ups = good.flatMap((r) => (r.uploadMbps === null ? [] : [r.uploadMbps]));
    const lat = good.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs]));
    const limited = s.minDownMbps !== null || s.minUpMbps !== null;
    return {
      settings: s,
      results,
      summary: {
        count: results.length,
        avgDownMbps: avg(downs),
        avgUpMbps: avg(ups),
        avgLatencyMs: avg(lat),
        minDownMbps: downs.length === 0 ? null : Math.min(...downs),
        maxDownMbps: downs.length === 0 ? null : Math.max(...downs),
        slowShare:
          !limited || good.length === 0
            ? null
            : good.filter((r) => this.isSlow(r, s)).length / good.length,
      },
      running: this.isRunning(),
      nextRunAt: this.nextRunAt(s),
    };
  }

  // ---- runs -------------------------------------------------------------------------

  tick(): void {
    if (!this.enabled) return;
    const now = this.ctx.now();
    if (now - this.lastPrune >= HOUR) {
      this.lastPrune = now;
      this.prune();
    }
    const s = this.settings();
    const next = this.nextRunAt(s);
    if (next === null || next > now || this.running) return;
    this.begin(s, 'schedule');
  }

  prune(): void {
    const cutoff = this.ctx.now() - SPEEDTEST_KEEP_DAYS * DAY;
    this.ctx.db.delete(speedtestResults).where(lt(speedtestResults.at, cutoff)).run();
  }

  /** "Jetzt messen". Returns the start time. */
  runNow(): number {
    const s = this.settings();
    if (this.running) throw new HttpError(409, 'busy');
    if (s.serverId === null) throw new HttpError(409, 'conflict', undefined, MSG_NO_SERVER);
    if (!this.ctx.hub.isConnected(s.serverId)) {
      throw new HttpError(409, 'agent_offline', undefined, MSG_SERVER_OFFLINE);
    }
    const now = this.ctx.now();
    const last = this.lastStartAt();
    if (last !== null && now - last < SPEEDTEST_MANUAL_GAP_MS) {
      throw new HttpError(
        429,
        'rate_limited',
        Math.ceil((SPEEDTEST_MANUAL_GAP_MS - (now - last)) / 1000),
      );
    }
    writeAudit(this.ctx.db, now, {
      actor: 'admin',
      action: 'speedtest.run',
      target: s.serverId,
    });
    return this.begin(s, 'manual');
  }

  private begin(s: SpeedtestSettings, trigger: Trigger): number {
    const serverId = s.serverId;
    if (serverId === null) throw new HttpError(409, 'conflict', undefined, MSG_NO_SERVER);
    const startedAt = this.ctx.now();
    this.lastStart = startedAt;
    this.running = this.measure(serverId, s, trigger, startedAt)
      .catch((err: unknown) => {
        this.ctx.log.error({ err: err instanceof Error ? err.name : 'error' }, 'speedtest failed');
      })
      .finally(() => {
        this.running = null;
      });
    return startedAt;
  }

  private async measure(
    serverId: string,
    s: SpeedtestSettings,
    trigger: Trigger,
    at: number,
  ): Promise<void> {
    const store = (v: Partial<typeof speedtestResults.$inferInsert>): void => {
      this.ctx.db
        .insert(speedtestResults)
        .values({ at, serverId, trigger, ok: false, bytes: 0, ...v })
        .run();
    };
    if (!this.ctx.hub.isConnected(serverId)) {
      store({ error: 'Server offline' });
      return;
    }
    let data: unknown;
    try {
      data = await this.ctx.hub.call(
        serverId,
        'speedtest.run',
        { maxSeconds: s.maxSeconds, maxBytes: s.maxMb * MIB },
        // Latency + download + upload + trace, each bounded by the agent.
        { timeoutMs: (2 * s.maxSeconds + 30) * 1000 },
      );
    } catch (err) {
      store({ error: errorText(err) });
      return;
    }
    const parsed = speedtestDataSchema.safeParse(data);
    if (!parsed.success) {
      store({ error: 'Ungültige Antwort des Agents' });
      return;
    }
    const d = parsed.data;
    store({
      ok: true,
      downloadMbps: Math.round(d.downloadMbps * 100) / 100,
      uploadMbps: Math.round(d.uploadMbps * 100) / 100,
      latencyMs: Math.round(d.latencyMs * 100) / 100,
      jitterMs: Math.round(d.jitterMs * 100) / 100,
      bytes: d.downloadBytes + d.uploadBytes,
      colo: d.colo,
      error: null,
    });
    if (this.enabled) this.evaluateSlow(serverId);
  }

  private isSlow(r: Pick<SpeedtestResult, 'downloadMbps' | 'uploadMbps'>, s: SpeedtestSettings) {
    return (
      (s.minDownMbps !== null && r.downloadMbps !== null && r.downloadMbps < s.minDownMbps) ||
      (s.minUpMbps !== null && r.uploadMbps !== null && r.uploadMbps < s.minUpMbps)
    );
  }

  /** SPEEDTEST_SLOW_STREAK slow ok results in a row: warn; a good one resolves it. */
  private evaluateSlow(serverId: string): void {
    const s = this.settings();
    const last = this.ctx.db
      .select()
      .from(speedtestResults)
      .where(eq(speedtestResults.ok, true))
      .orderBy(desc(speedtestResults.at), desc(speedtestResults.id))
      .limit(SPEEDTEST_SLOW_STREAK)
      .all()
      .map((r) => this.toResult(r));
    const newest = last[0];
    if (!newest) return;
    const now = this.ctx.now();
    if (!this.isSlow(newest, s)) {
      this.ctx.alerts.resolve(SPEEDTEST_SLOW_ALERT_KEY, {
        title: 'Internet wieder schnell',
        body: `${fmt(newest.downloadMbps ?? 0)} Download, ${fmt(newest.uploadMbps ?? 0)} Upload (${clockTime(now)}).`,
      });
      return;
    }
    if (last.length < SPEEDTEST_SLOW_STREAK || !last.every((r) => this.isSlow(r, s))) return;
    const downSlow =
      s.minDownMbps !== null && newest.downloadMbps !== null && newest.downloadMbps < s.minDownMbps;
    const title = downSlow
      ? `Internet langsam: ${fmt(newest.downloadMbps ?? 0)} statt ${mbps.format(s.minDownMbps ?? 0)}`
      : `Internet langsam: ${fmt(newest.uploadMbps ?? 0)} Upload statt ${mbps.format(s.minUpMbps ?? 0)}`;
    this.ctx.alerts.raise(
      SPEEDTEST_SLOW_ALERT_KEY,
      'warn',
      title,
      `${SPEEDTEST_SLOW_STREAK} Messungen in Folge unter der Schwelle, zuletzt ${clockTime(now)}.`,
      serverId,
      'system',
    );
  }
}

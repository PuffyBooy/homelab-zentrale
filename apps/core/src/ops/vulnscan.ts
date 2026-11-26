import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  imageScanDataSchema,
  VULNSCAN_DEFAULTS,
  vulnScanResultSchema,
  vulnScanSettingsSchema,
  type ImageScanData,
  type VulnScanResult,
  type VulnScanSettings,
  type VulnScanState,
} from '@hz/shared';
import type { FastifyBaseLogger } from 'fastify';
import { RpcError, type AgentHub } from '../agents/hub.js';
import type { AlertService } from '../alerts/service.js';
import { hhmmToMinutes, nextWallClock } from '../calendar.js';
import type { Clock } from '../clock.js';
import { containerCoreId } from '../containers/service.js';
import type { Db } from '../db/index.js';
import { alerts, containers } from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import type { Scheduler } from '../scheduler.js';
import { plainText, rpcState, serverRefs, type ServerRef } from './common.js';

export const VULNSCAN_SETTINGS_KEY = 'vulnscan.settings';
export const VULNSCAN_RESULTS_KEY = 'vulnscan.results';
export const VULNSCAN_JOB = 'vulnscan.nightly';
/** Trivy pulls its DB and the image layers (remote); a big image on a Pi takes a while. */
export const IMAGE_SCAN_TIMEOUT_MS = 13 * 60_000;
/** At most one manual run per 10 minutes. */
export const MANUAL_RUN_INTERVAL_MS = 10 * 60_000;
export const VULN_ALERT_PREFIX = 'vulnscan:';

export const vulnAlertKey = (serverId: string, containerName: string): string =>
  `${VULN_ALERT_PREFIX}${serverId}:${containerName}`;

const storedSchema = z.object({
  lastRunAt: z.number().int().nullable(),
  skippedServers: z.array(z.object({ serverId: z.string(), name: z.string().max(64) })),
  results: z.array(vulnScanResultSchema),
});
type Stored = z.infer<typeof storedSchema>;
const EMPTY: Stored = { lastRunAt: null, skippedServers: [], results: [] };

const resultKey = (serverId: string, containerName: string): string =>
  `${serverId}\u0000${containerName}`;

/** Most critical first, then most high, then by server and container name. */
function compareResults(a: VulnScanResult, b: VulnScanResult): number {
  return (
    b.scan.counts.critical - a.scan.counts.critical ||
    b.scan.counts.high - a.scan.counts.high ||
    a.serverName.localeCompare(b.serverName) ||
    a.containerName.localeCompare(b.containerName)
  );
}

const BODY_MAX = 300;

/**
 * German alert text for a result, or null if it stays below the threshold.
 * Title: "2 kritische Lücken in nginx", with alertFrom high also "… und 3 hohe …".
 */
export function vulnAlertText(
  r: Pick<VulnScanResult, 'serverName' | 'containerName' | 'scan'>,
  alertFrom: VulnScanSettings['alertFrom'],
): { title: string; body: string } | null {
  const { critical } = r.scan.counts;
  const high = alertFrom === 'high' ? r.scan.counts.high : 0;
  const total = critical + high;
  if (total === 0) return null;
  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} kritische`);
  if (high > 0) parts.push(`${high} hohe`);
  const noun = total === 1 ? 'Lücke' : 'Lücken';
  const name = plainText(r.containerName, 64);
  const title = `${parts.join(' und ')} ${noun} in ${name}`;
  const ids = r.scan.vulns
    .filter((v) => v.severity === 'CRITICAL' || alertFrom === 'high')
    .map((v) => {
      const id = plainText(v.id, 64);
      return v.fixed ? `${id} (behoben in ${plainText(v.fixed, 40)})` : id;
    });
  const unique = [...new Set(ids)];
  let list = '';
  for (const id of unique) {
    const next = list === '' ? id : `${list}, ${id}`;
    if (next.length > BODY_MAX - 40) {
      list = `${list}, …`;
      break;
    }
    list = next;
  }
  const body = plainText(
    `auf ${plainText(r.serverName, 64)}: ${list || 'Details im Scan'}`,
    BODY_MAX,
  );
  return { title, body };
}

interface Progress {
  done: number;
  total: number;
}

/**
 * Nightly vulnerability scan (Trivy on the agents) of the images of all
 * running containers. Results live in `settings` (latest per server +
 * container name). The core only names containers; the agent resolves the image.
 */
export class VulnScanService {
  private enabled = false;
  private removeJob: (() => void) | null = null;
  private progress: Progress | null = null;
  private running: Promise<void> | null = null;
  private lastManualAt: number | null = null;
  private stopped = false;
  private abort = false;

  constructor(
    private readonly deps: {
      db: Db;
      now: Clock;
      hub: AgentHub;
      alerts: AlertService;
      scheduler: Scheduler;
      log: FastifyBaseLogger;
      timeoutMs?: number;
    },
  ) {}

  // ---- settings and schedule -----------------------------------------------------

  settings(): VulnScanSettings {
    const p = vulnScanSettingsSchema.safeParse(readSetting(this.deps.db, VULNSCAN_SETTINGS_KEY));
    return p.success ? p.data : VULNSCAN_DEFAULTS;
  }

  setSettings(s: VulnScanSettings): void {
    const prev = this.settings();
    writeSetting(this.deps.db, VULNSCAN_SETTINGS_KEY, s, this.deps.now());
    if (prev.time !== s.time) this.schedule();
    // A lower threshold raises, a higher one resolves at once (no rescan needed).
    if (prev.alertFrom !== s.alertFrom && this.enabled) this.syncAlerts(this.read().results);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) {
      this.schedule();
      return;
    }
    this.removeJob?.();
    this.removeJob = null;
    this.abort = true;
    this.deps.alerts.resolveAllWithPrefix(VULN_ALERT_PREFIX);
  }

  private schedule(): void {
    this.removeJob?.();
    this.removeJob = null;
    if (!this.enabled) return;
    const minutes = hhmmToMinutes(this.settings().time);
    const rule = { hour: Math.floor(minutes / 60), minute: minutes % 60 };
    this.removeJob = this.deps.scheduler.at(
      VULNSCAN_JOB,
      (from) => nextWallClock(from, rule),
      () => {
        if (this.enabled && !this.running) void this.start();
      },
    );
  }

  // ---- runs ----------------------------------------------------------------------

  isRunning(): boolean {
    return this.running !== null;
  }

  /**
   * Manual run: 'busy' if one runs, else seconds to wait if the last manual run
   * started less than 10 min ago, else null (started).
   */
  runManual(): 'busy' | number | null {
    if (this.running) return 'busy';
    const now = this.deps.now();
    if (this.lastManualAt !== null && now - this.lastManualAt < MANUAL_RUN_INTERVAL_MS) {
      return Math.max(1, Math.ceil((this.lastManualAt + MANUAL_RUN_INTERVAL_MS - now) / 1000));
    }
    this.lastManualAt = now;
    void this.start();
    return null;
  }

  /** Starts a run unless one is running; resolves when it is done. */
  start(): Promise<void> {
    if (this.running) return this.running;
    if (!this.enabled || this.stopped) return Promise.resolve();
    this.abort = false;
    this.running = this.runAll()
      .catch((err: unknown) => {
        this.deps.log.error(
          { err: err instanceof Error ? { name: err.name, stack: err.stack } : 'error' },
          'vulnerability scan failed',
        );
      })
      .finally(() => {
        this.running = null;
        this.progress = null;
      });
    return this.running;
  }

  /** Resolves when no run is active (shutdown, tests). */
  async idle(): Promise<void> {
    await this.running;
  }

  /** Before the database closes: no further writes. */
  stop(): void {
    this.stopped = true;
    this.abort = true;
    this.removeJob?.();
    this.removeJob = null;
  }

  private runningContainers(serverId: string): { dockerId: string; name: string; image: string }[] {
    const rows = this.deps.db
      .select({
        dockerId: containers.dockerId,
        name: containers.name,
        infoJson: containers.infoJson,
      })
      .from(containers)
      .where(and(eq(containers.serverId, serverId), eq(containers.state, 'running')))
      .all();
    return rows
      .map((r) => {
        let image = r.dockerId;
        try {
          const info = JSON.parse(r.infoJson) as { imageId?: unknown };
          if (typeof info.imageId === 'string' && info.imageId !== '') image = info.imageId;
        } catch {
          // keep the docker id: no reuse for this container
        }
        return { dockerId: r.dockerId, name: r.name, image };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async runAll(): Promise<void> {
    const all = serverRefs(this.deps.db);
    const plan = all.map((s) => ({
      server: s,
      online: this.deps.hub.isConnected(s.id),
      list: this.deps.hub.isConnected(s.id) ? this.runningContainers(s.id) : [],
    }));
    const progress: Progress = { done: 0, total: plan.reduce((n, p) => n + p.list.length, 0) };
    this.progress = progress;
    const skipped: ServerRef[] = [];
    const fresh: VulnScanResult[] = [];

    await Promise.all(
      plan.map(async ({ server, online, list }) => {
        if (!online) {
          skipped.push(server);
          return;
        }
        const byImage = new Map<string, ImageScanData>();
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (!c) continue;
          if (this.abort) return;
          let scan = byImage.get(c.image);
          if (!scan) {
            try {
              const raw = await this.deps.hub.call(
                server.id,
                'image.scan',
                { id: c.dockerId },
                { timeoutMs: this.deps.timeoutMs ?? IMAGE_SCAN_TIMEOUT_MS },
              );
              const parsed = imageScanDataSchema.safeParse(raw);
              if (parsed.success) {
                scan = parsed.data;
                byImage.set(c.image, scan);
              }
            } catch (err) {
              const state = rpcState(err);
              if (state !== 'failed') {
                // Too old or gone: the rest of this server is skipped.
                skipped.push(server);
                progress.done += list.length - i;
                return;
              }
              if (!(err instanceof RpcError)) throw err;
            }
          }
          if (scan) {
            fresh.push({
              serverId: server.id,
              serverName: server.name,
              containerName: c.name,
              scan,
            });
          }
          progress.done += 1;
        }
      }),
    );
    if (this.stopped || !this.enabled) return;

    // Latest result per existing container: fresh beats the stored one; results of
    // containers (or servers) that no longer exist are dropped.
    const existing = new Set(
      this.deps.db
        .select({ serverId: containers.serverId, name: containers.name })
        .from(containers)
        .all()
        .map((r) => resultKey(r.serverId, r.name)),
    );
    const merged = new Map<string, VulnScanResult>();
    for (const r of this.read().results) merged.set(resultKey(r.serverId, r.containerName), r);
    for (const r of fresh) merged.set(resultKey(r.serverId, r.containerName), r);
    const results = [...merged.entries()]
      .filter(([k]) => existing.has(k))
      .map(([, r]) => r)
      .sort(compareResults);
    this.write({
      lastRunAt: this.deps.now(),
      skippedServers: skipped
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({ serverId: s.id, name: s.name })),
      results,
    });
    this.syncAlerts(results);
    this.deps.log.info(
      { scanned: fresh.length, results: results.length, skipped: skipped.length },
      'vulnerability scan done',
    );
  }

  // ---- results and alerts --------------------------------------------------------

  private read(): Stored {
    const p = storedSchema.safeParse(readSetting(this.deps.db, VULNSCAN_RESULTS_KEY));
    return p.success ? p.data : EMPTY;
  }

  private write(s: Stored): void {
    writeSetting(this.deps.db, VULNSCAN_RESULTS_KEY, s, this.deps.now());
  }

  /** Raises/keeps alerts for results at/above the threshold, resolves all others. */
  private syncAlerts(results: VulnScanResult[]): void {
    const alertFrom = this.settings().alertFrom;
    const wanted = new Set<string>();
    for (const r of results) {
      const text = vulnAlertText(r, alertFrom);
      if (!text) continue;
      const key = vulnAlertKey(r.serverId, r.containerName);
      wanted.add(key);
      this.deps.alerts.raise(key, 'warn', text.title, text.body, r.serverId, 'container');
    }
    const open = this.deps.db
      .select({ key: alerts.key })
      .from(alerts)
      .where(ne(alerts.state, 'resolved'))
      .all()
      .map((a) => a.key)
      .filter((k) => k.startsWith(VULN_ALERT_PREFIX) && !wanted.has(k));
    for (const key of new Set(open)) this.deps.alerts.resolve(key);
  }

  /** A deleted server: its results and alerts go. */
  forgetServer(serverId: string): void {
    if (this.stopped) return;
    const s = this.read();
    const results = s.results.filter((r) => r.serverId !== serverId);
    const skippedServers = s.skippedServers.filter((r) => r.serverId !== serverId);
    if (results.length !== s.results.length || skippedServers.length !== s.skippedServers.length) {
      this.write({ ...s, results, skippedServers });
    }
    this.deps.alerts.resolveAllWithPrefix(`${VULN_ALERT_PREFIX}${serverId}:`);
  }

  /** A container that disappeared from the inventory: its result and alert go. */
  onContainerDeleted(coreId: string): void {
    if (this.stopped) return;
    const s = this.read();
    const gone = s.results.filter((r) => containerCoreId(r.serverId, r.containerName) === coreId);
    if (gone.length === 0) return;
    this.write({ ...s, results: s.results.filter((r) => !gone.includes(r)) });
    for (const r of gone) this.deps.alerts.resolve(vulnAlertKey(r.serverId, r.containerName));
  }

  state(): VulnScanState {
    const s = this.read();
    const names = new Map(serverRefs(this.deps.db).map((r) => [r.id, r.name]));
    const nextRunAt = this.enabled ? (this.deps.scheduler.nextRunOf(VULNSCAN_JOB) ?? null) : null;
    return {
      settings: this.settings(),
      running: this.running !== null,
      progress: this.progress ? { ...this.progress } : null,
      lastRunAt: s.lastRunAt === null ? null : new Date(s.lastRunAt).toISOString(),
      nextRunAt: nextRunAt === null ? null : new Date(nextRunAt).toISOString(),
      skippedServers: s.skippedServers
        .filter((r) => names.has(r.serverId))
        .map((r) => ({ serverId: r.serverId, name: names.get(r.serverId) ?? r.name })),
      results: s.results
        .filter((r) => names.has(r.serverId))
        .map((r) => ({ ...r, serverName: names.get(r.serverId) ?? r.serverName }))
        .sort(compareResults),
    };
  }
}

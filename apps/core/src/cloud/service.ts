import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  AZURE_DISK_EUR_PER_MONTH,
  AZURE_PUBLIC_IP_EUR_PER_HOUR,
  AZURE_VM_SIZES,
  azureDiskTypeSchema,
  azureRegionSchema,
  azureVmSize,
  CLOUD_BUDGET_WARN_PERCENT,
  CLOUD_GAME_TEXT,
  CLOUD_INSTALL_TIMEOUT_MINUTES,
  CLOUD_MACHINE_STATE_TEXT,
  CLOUD_MAX_MACHINES,
  CLOUD_OS_RAM_GB,
  CLOUD_PRICE_TOLERANCE_EUR,
  CLOUD_START_TIMEOUT_MINUTES,
  CLOUD_ERRORS,
  cloudMachineStateSchema,
  cloudPendingGameSchema,
  estimateAzureCost,
  HOURS_PER_MONTH,
  recommendAzureSize,
  type AzureDiskType,
  type AzurePricesResponse,
  type AzureRegion,
  type AzureSettings,
  type AzureSettingsRequest,
  type CloudBudget,
  type CloudCost,
  type CloudErrorText,
  type CloudMachine,
  type CloudMachineCreateRequest,
  type CloudMachineState,
  type CloudOverview,
  type CloudPendingGame,
} from '@hz/shared';
import type { AgentHub } from '../agents/hub.js';
import type { AgentTokens } from '../agents/tokens.js';
import type { AlertService } from '../alerts/service.js';
import { fromLocal, localTime } from '../calendar.js';
import type { Clock } from '../clock.js';
import { randomToken, type SecretBox } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { cloudMachines, cloudUsage, serverState, type CloudMachineRow } from '../db/schema.js';
import { HttpError } from '../http/errors.js';
import type { GameCloudHost, GameService } from '../games/service.js';
import { OnboardingError, type OnboardingService } from '../servers/onboarding.js';
import type { ServerService } from '../servers/service.js';
import { AzureError, nsgRules, type AzureClient, type AzureCredentials } from './azure.js';
import { cloudInitCustomData } from './cloud-init.js';
import { AzureAccountStore, UNREADABLE } from './store.js';

export const CLOUD_TICK_MS = 5_000;
const INSTALL_TIMEOUT_MS = CLOUD_INSTALL_TIMEOUT_MINUTES * 60_000;
const START_TIMEOUT_MS = CLOUD_START_TIMEOUT_MINUTES * 60_000;
const GIB = 1024 ** 3;
const BILLABLE: ReadonlySet<CloudMachineState> = new Set([
  'creating',
  'installing',
  'running',
  'starting',
  'stopping',
]);
/** The machine is off on purpose: its server is OFF, not offline. */
const ASLEEP: ReadonlySet<CloudMachineState> = new Set(['deallocated', 'stopping', 'starting']);
const BUDGET_ALERT = 'cloud:budget';

const eurFmt = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });
const eurHourFmt = new Intl.NumberFormat('de-AT', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** YYYY-MM of an instant in HZ_TIMEZONE. */
export function monthKey(ms: number): string {
  const w = localTime(ms);
  return `${w.year}-${String(w.month).padStart(2, '0')}`;
}

export function monthStart(ms: number): number {
  const w = localTime(ms);
  return fromLocal(w.year, w.month, 1, 0, 0);
}

export function nextMonthStart(ms: number): number {
  const w = localTime(ms);
  return fromLocal(w.year, w.month + 1, 1, 0, 0);
}

/** Seconds of [from, to) per month (integer seconds, no drift over many ticks). */
export function splitByMonth(from: number, to: number): { month: string; seconds: number }[] {
  const out: { month: string; seconds: number }[] = [];
  let t = from;
  while (t < to) {
    const end = Math.min(to, nextMonthStart(t));
    const seconds = Math.floor(end / 1000) - Math.floor(t / 1000);
    if (seconds > 0) out.push({ month: monthKey(t), seconds });
    t = end;
  }
  return out;
}

function guardError(v: string | null): CloudErrorText | null {
  return CLOUD_ERRORS.find((e) => e === v) ?? null;
}

export interface CloudServiceDeps {
  db: Db;
  box: SecretBox;
  now: Clock;
  log: FastifyBaseLogger;
  alerts: AlertService;
  hub: Pick<AgentHub, 'isConnected' | 'disconnect' | 'forget'>;
  tokens: Pick<AgentTokens, 'nameTaken' | 'revoke'>;
  onboarding: OnboardingService;
  servers: ServerService;
  games: GameService;
  azure: AzureClient;
}

interface PriceEntry {
  at: number;
  prices: Map<string, number> | null;
}

interface Waiter {
  fn: (ok: boolean) => void;
  at: number;
}

/**
 * M22 cloud machines: settings, prices, orders, the state machine driven by the
 * tick (creating -> installing -> running <-> stopping/deallocated/starting,
 * deleting), idle deallocation, usage, budget, NSG = game ports. Azure calls run
 * only in the tick (one at a time), never while a request waits.
 */
export class CloudService implements GameCloudHost {
  readonly store: AzureAccountStore;
  private active = false;
  private ticking: Promise<void> | null = null;
  private again = false;
  private readonly background = new Set<Promise<unknown>>();
  private readonly prices = new Map<AzureRegion, PriceEntry>();
  private readonly waiters = new Map<string, Waiter[]>();
  /** Start requested at (machine id): the agent must report metrics after it. */
  private readonly startRequestedAt = new Map<string, number>();
  /** The start POST was sent (machine id), cleared when running/failed. */
  private readonly startIssued = new Set<string>();
  /** A start was requested while the VM was being deallocated. */
  private readonly wantStart = new Set<string>();
  /** Background stop jobs (games are stopped before the VM is deallocated). */
  private readonly stopJobs = new Set<string>();
  /** NSG rules last applied per machine (JSON). */
  private readonly appliedNsg = new Map<string, string>();

  constructor(private readonly deps: CloudServiceDeps) {
    this.store = new AzureAccountStore(deps.db, deps.box, deps.now);
  }

  get enabled(): boolean {
    return this.active;
  }

  /** Module switch: off = no ticks, no Azure calls; machines stay as they are. */
  setEnabled(on: boolean): void {
    this.active = on;
    if (on) this.kick();
    else for (const id of [...this.waiters.keys()]) this.resolveWaiters(id, false);
  }

  // ---- rows -------------------------------------------------------------------

  private rows(): CloudMachineRow[] {
    return this.deps.db.select().from(cloudMachines).all();
  }

  private row(id: string): CloudMachineRow | undefined {
    return this.deps.db.select().from(cloudMachines).where(eq(cloudMachines.id, id)).get();
  }

  private byServer(serverId: string): CloudMachineRow | undefined {
    return this.deps.db
      .select()
      .from(cloudMachines)
      .where(eq(cloudMachines.serverId, serverId))
      .get();
  }

  private requireRow(id: string): CloudMachineRow {
    const r = this.row(id);
    if (!r) throw new HttpError(404, 'not_found');
    return r;
  }

  private stateOf(r: CloudMachineRow): CloudMachineState {
    const p = cloudMachineStateSchema.safeParse(r.state);
    return p.success ? p.data : 'failed';
  }

  private regionOf(r: CloudMachineRow): AzureRegion {
    return azureRegionSchema.parse(r.region);
  }

  private diskTypeOf(r: CloudMachineRow): AzureDiskType {
    return azureDiskTypeSchema.parse(r.diskType);
  }

  /** Adds the running time since the last accounting (restart-safe via updated_at). */
  private account(r: CloudMachineRow, now: number): void {
    if (!BILLABLE.has(this.stateOf(r)) || now <= r.updatedAt) return;
    for (const { month, seconds } of splitByMonth(r.updatedAt, now)) {
      this.deps.db
        .insert(cloudUsage)
        .values({ machineId: r.id, month, runningSeconds: seconds })
        .onConflictDoUpdate({
          target: [cloudUsage.machineId, cloudUsage.month],
          set: { runningSeconds: sql`${cloudUsage.runningSeconds} + ${seconds}` },
        })
        .run();
    }
  }

  /** Every write of a machine row goes through here (usage first). */
  private patch(id: string, set: Partial<CloudMachineRow>): CloudMachineRow | undefined {
    const r = this.row(id);
    if (!r) return undefined;
    const now = this.deps.now();
    this.account(r, now);
    const next: Partial<CloudMachineRow> = { ...set, updatedAt: Math.max(now, r.updatedAt) };
    if (set.state !== undefined && set.state !== r.state) next.stateChangedAt = now;
    this.deps.db.update(cloudMachines).set(next).where(eq(cloudMachines.id, id)).run();
    return this.row(id);
  }

  private setState(
    id: string,
    state: CloudMachineState,
    extra: Partial<CloudMachineRow> = {},
  ): CloudMachineRow | undefined {
    return this.patch(id, {
      state,
      stateText: CLOUD_MACHINE_STATE_TEXT[state],
      ...(state === 'failed' ? {} : { error: null }),
      ...extra,
    });
  }

  private pendingOf(r: CloudMachineRow): CloudPendingGame | null {
    if (r.pendingGameJson === null) return null;
    try {
      const p = cloudPendingGameSchema.safeParse(
        JSON.parse(this.deps.box.decrypt(r.pendingGameJson, `cloud_machines.pending_game:${r.id}`)),
      );
      return p.success ? p.data : null;
    } catch {
      return null;
    }
  }

  // ---- views ------------------------------------------------------------------

  private monthSeconds(machineId: string, month: string): number {
    const u = this.deps.db
      .select({ s: cloudUsage.runningSeconds })
      .from(cloudUsage)
      .where(sql`${cloudUsage.machineId} = ${machineId} AND ${cloudUsage.month} = ${month}`)
      .get();
    return u?.s ?? 0;
  }

  private costOf(r: CloudMachineRow): CloudCost {
    return estimateAzureCost({
      computeEurPerHour: r.computeEurPerHour,
      diskType: this.diskTypeOf(r),
      diskGb: r.diskGb,
      publicIp: r.publicIpEnabled,
      source: r.priceSource === 'live' ? 'live' : 'estimate',
    });
  }

  /** Disk + IP per hour (billed also while deallocated). */
  private fixedPerHour(r: CloudMachineRow): number {
    const disk = AZURE_DISK_EUR_PER_MONTH[this.diskTypeOf(r)][r.diskGb] ?? 0;
    return disk / HOURS_PER_MONTH + (r.publicIpEnabled ? AZURE_PUBLIC_IP_EUR_PER_HOUR : 0);
  }

  private usageOf(
    r: CloudMachineRow,
    now: number,
  ): { hours: number; eur: number; projected: number } {
    const month = monthKey(now);
    let seconds = this.monthSeconds(r.id, month);
    const billable = BILLABLE.has(this.stateOf(r));
    if (billable && now > r.updatedAt) {
      const since = Math.max(r.updatedAt, monthStart(now));
      seconds += Math.max(0, Math.floor(now / 1000) - Math.floor(since / 1000));
    }
    const hours = seconds / 3600;
    const existedHours = Math.max(0, now - Math.max(monthStart(now), r.createdAt)) / 3_600_000;
    const fixed = this.fixedPerHour(r);
    const eur = hours * r.computeEurPerHour + existedHours * fixed;
    const left = Math.max(0, nextMonthStart(now) - now) / 3_600_000;
    const projected = eur + left * (billable ? r.computeEurPerHour + fixed : fixed);
    return { hours, eur, projected };
  }

  machineView(r: CloudMachineRow): CloudMachine {
    const now = this.deps.now();
    const size = azureVmSize(r.size);
    const u = this.usageOf(r, now);
    const pending = this.pendingOf(r);
    return {
      id: r.id,
      provider: 'azure',
      name: r.name,
      size: r.size,
      vcpus: size?.vcpus ?? 0,
      ramGb: size?.ramGb ?? 0,
      region: this.regionOf(r),
      diskType: this.diskTypeOf(r),
      diskGb: r.diskGb,
      publicIp: r.publicIp,
      serverId: r.serverId,
      state: this.stateOf(r),
      stateText: r.stateText ?? CLOUD_MACHINE_STATE_TEXT[this.stateOf(r)],
      error: guardError(r.error),
      idleMinutes: r.idleMinutes,
      pendingGameName: pending?.name ?? null,
      gameIds: r.serverId ? this.deps.games.gameIdsOn(r.serverId) : [],
      cost: this.costOf(r),
      monthHours: Math.round(u.hours * 100) / 100,
      monthEur: round2(u.eur),
      createdAt: new Date(r.createdAt).toISOString(),
    };
  }

  machine(id: string): CloudMachine {
    return this.machineView(this.requireRow(id));
  }

  budget(): CloudBudget {
    const now = this.deps.now();
    let month = 0;
    let projected = 0;
    for (const r of this.rows()) {
      const u = this.usageOf(r, now);
      month += u.eur;
      projected += u.projected;
    }
    const limit = this.store.budget();
    const percent = limit > 0 ? (month / limit) * 100 : 0;
    const state: CloudBudget['state'] =
      percent >= 100 ? 'over' : percent >= CLOUD_BUDGET_WARN_PERCENT ? 'warn' : 'ok';
    return {
      limitEur: limit,
      monthEur: round2(month),
      projectedEur: round2(projected),
      percent: Math.round(percent * 10) / 10,
      state,
    };
  }

  private overBudget(): boolean {
    return this.budget().state === 'over';
  }

  overview(): CloudOverview {
    return {
      azure: this.store.view(),
      machines: this.rows()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => this.machineView(r)),
      budget: this.budget(),
    };
  }

  // ---- settings ---------------------------------------------------------------

  settings(): AzureSettings {
    return this.store.view();
  }

  updateSettings(req: AzureSettingsRequest): AzureSettings {
    const ch = this.store.changes(req);
    if ((ch.tenant || ch.subscription || ch.group) && this.rows().length > 0) {
      throw new HttpError(
        409,
        'conflict',
        undefined,
        'Erst alle Cloud-Server löschen, dann Konto oder Ressourcengruppe wechseln',
      );
    }
    const res = this.store.update(req);
    if (res.accessChanged) this.deps.azure.dropToken();
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'admin',
      action: 'cloud.settings_updated',
      target: 'azure',
      details: { fields: res.fields, secretDropped: res.secretDropped },
    });
    return this.store.view();
  }

  async test(): Promise<AzureSettings> {
    const creds = this.store.credentials();
    if (creds.kind === 'missing') {
      throw new HttpError(409, 'conflict', undefined, 'Azure-Zugang ist unvollständig');
    }
    if (creds.kind === 'unreadable') return this.store.view();
    try {
      this.deps.azure.dropToken();
      await this.deps.azure.testAccess(creds.value);
      this.store.markOk();
    } catch (err) {
      this.store.markError(err instanceof AzureError ? err.text : 'Unerwartete Antwort von Azure');
    }
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'admin',
      action: 'cloud.settings_tested',
      target: 'azure',
      details: { status: this.store.view().status },
    });
    return this.store.view();
  }

  clearSettings(): void {
    if (this.rows().length > 0) {
      throw new HttpError(409, 'conflict', undefined, 'Erst alle Cloud-Server löschen');
    }
    this.store.clear();
    this.deps.azure.dropToken();
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'admin',
      action: 'cloud.settings_deleted',
      target: 'azure',
    });
  }

  // ---- prices -----------------------------------------------------------------

  /** Live compute prices of a region (cached 24 h; after a failure 10 min the estimate). */
  private async regionPrices(
    region: AzureRegion,
  ): Promise<{ prices: Map<string, number> | null; at: number | null }> {
    const now = this.deps.now();
    const c = this.prices.get(region);
    if (c && (c.prices ? now - c.at < 24 * 60 * 60_000 : now - c.at < 10 * 60_000)) {
      return { prices: c.prices, at: c.prices ? c.at : null };
    }
    try {
      const prices = await this.deps.azure.retailPrices(region);
      const entry = { at: now, prices: prices.size > 0 ? prices : null };
      this.prices.set(region, entry);
      return { prices: entry.prices, at: entry.prices ? now : null };
    } catch (err) {
      this.deps.log.info(
        { err: err instanceof AzureError ? err.text : 'error' },
        'azure prices failed',
      );
      this.prices.set(region, { at: now, prices: null });
      return { prices: null, at: null };
    }
  }

  private static compute(
    size: string,
    prices: Map<string, number> | null,
  ): { eurPerHour: number; source: CloudCost['source'] } {
    const live = prices?.get(size);
    if (live !== undefined) return { eurPerHour: live, source: 'live' };
    return { eurPerHour: azureVmSize(size)?.eurPerHour ?? 0, source: 'estimate' };
  }

  async priceList(q: {
    region?: AzureRegion | undefined;
    diskType: AzureDiskType;
    diskGb: number;
    publicIp: boolean;
  }): Promise<AzurePricesResponse> {
    const region = q.region ?? this.store.region();
    const { prices, at } = await this.regionPrices(region);
    return {
      region,
      fetchedAt: at === null ? null : new Date(at).toISOString(),
      sizes: AZURE_VM_SIZES.map((s) => {
        const c = CloudService.compute(s.size, prices);
        return {
          size: s.size,
          vcpus: s.vcpus,
          ramGb: s.ramGb,
          freeTier: s.freeTier,
          burstable: s.burstable,
          cost: estimateAzureCost({
            computeEurPerHour: c.eurPerHour,
            diskType: q.diskType,
            diskGb: q.diskGb,
            publicIp: q.publicIp,
            source: c.source,
          }),
        };
      }),
    };
  }

  // ---- order ------------------------------------------------------------------

  async create(req: CloudMachineCreateRequest): Promise<CloudMachine> {
    const refuse = (message: string): never => {
      throw new HttpError(409, 'conflict', undefined, message);
    };
    const creds = this.store.credentials();
    if (creds.kind === 'unreadable') refuse(UNREADABLE);
    if (creds.kind !== 'ok') refuse('Azure-Zugang ist unvollständig');
    if (this.store.tailscaleKey().kind !== 'ok') refuse('Tailscale-Auth-Key fehlt');
    if (!this.deps.onboarding.hub()) {
      refuse(
        'Ohne https-Adresse der Zentrale (HZ_BASE_URL) kann kein Cloud-Server eingerichtet werden',
      );
    }
    const rows = this.rows();
    if (rows.length >= CLOUD_MAX_MACHINES) refuse(`Höchstens ${CLOUD_MAX_MACHINES} Cloud-Server`);
    if (
      rows.some((r) => r.name === req.name) ||
      this.deps.tokens.nameTaken(req.name) ||
      this.deps.onboarding.nameBusy(req.name)
    ) {
      refuse('Name ist schon vergeben');
    }
    const size = azureVmSize(req.size);
    if (!size) throw new HttpError(400, 'invalid_input');
    if (req.game) {
      const { ramBytes } = this.deps.games.validatePending(req.game);
      const needGb = (ramBytes ?? 0) / GIB + CLOUD_OS_RAM_GB;
      if (needGb > size.ramGb) {
        const rec = recommendAzureSize((ramBytes ?? 0) / GIB);
        refuse(
          rec ? `Zu wenig RAM für das Spiel, empfohlen: ${rec.size}` : 'Zu wenig RAM für das Spiel',
        );
      }
    }
    const region = req.region ?? this.store.region();
    const { prices } = await this.regionPrices(region);
    const compute = CloudService.compute(size.size, prices);
    const cost = estimateAzureCost({
      computeEurPerHour: compute.eurPerHour,
      diskType: req.diskType,
      diskGb: req.diskGb,
      publicIp: req.publicIp,
      source: compute.source,
    });
    if (Math.abs(req.confirmEurPerHour - cost.runningEurPerHour) > CLOUD_PRICE_TOLERANCE_EUR) {
      throw new HttpError(
        409,
        'price_changed',
        undefined,
        `Der Preis hat sich geändert: jetzt ${eurHourFmt.format(cost.runningEurPerHour)} pro Stunde`,
        undefined,
        cost.runningEurPerHour,
      );
    }
    if (this.overBudget() && !req.overBudget) {
      throw new HttpError(409, 'over_budget', undefined, CLOUD_GAME_TEXT.overBudget);
    }
    const id = randomToken(12);
    const now = this.deps.now();
    try {
      this.deps.db
        .insert(cloudMachines)
        .values({
          id,
          provider: req.provider,
          name: req.name,
          size: size.size,
          region,
          diskType: req.diskType,
          diskGb: req.diskGb,
          publicIpEnabled: req.publicIp,
          publicIp: null,
          serverId: null,
          onboardingId: null,
          state: 'creating',
          stateText: CLOUD_MACHINE_STATE_TEXT.creating,
          error: null,
          idleMinutes: req.idleMinutes,
          idleSince: null,
          pendingGameJson: req.game
            ? this.deps.box.encrypt(JSON.stringify(req.game), `cloud_machines.pending_game:${id}`)
            : null,
          computeEurPerHour: compute.eurPerHour,
          priceSource: compute.source,
          stateChangedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch {
      refuse('Name ist schon vergeben');
    }
    writeAudit(this.deps.db, now, {
      actor: 'admin',
      action: 'cloud.machine_ordered',
      target: id,
      details: {
        name: req.name,
        provider: req.provider,
        size: size.size,
        region,
        diskType: req.diskType,
        diskGb: req.diskGb,
        publicIp: req.publicIp,
        eurPerHour: cost.runningEurPerHour,
        overBudget: req.overBudget,
        ...(req.game ? { game: { name: req.game.name, templateId: req.game.templateId } } : {}),
      },
    });
    this.kick();
    return this.machine(id);
  }

  // ---- start / stop / update / delete -----------------------------------------

  /** Admin start (cloud page). Over budget only with overBudget. */
  start(id: string, overBudget: boolean): CloudMachine {
    const r = this.requireRow(id);
    const st = this.stateOf(r);
    if (st === 'running' || st === 'starting') return this.machineView(r);
    if (!this.canStart(r)) throw new HttpError(409, 'busy');
    if (this.overBudget() && !overBudget) {
      throw new HttpError(409, 'over_budget', undefined, CLOUD_GAME_TEXT.overBudget);
    }
    this.requestStart(r, 'admin');
    return this.machine(id);
  }

  private canStart(r: CloudMachineRow): boolean {
    const st = this.stateOf(r);
    return st === 'deallocated' || st === 'stopping' || (st === 'failed' && r.serverId !== null);
  }

  private requestStart(r: CloudMachineRow, actor: string): void {
    const st = this.stateOf(r);
    if (st === 'running' || st === 'starting') return;
    this.startRequestedAt.set(r.id, this.deps.now());
    if (st === 'stopping') {
      this.wantStart.add(r.id);
    } else {
      this.startIssued.delete(r.id);
      this.setState(r.id, 'starting', { idleSince: null });
    }
    writeAudit(this.deps.db, this.deps.now(), {
      actor,
      action: 'cloud.machine_start',
      target: r.id,
      details: { name: r.name },
    });
    this.kick();
  }

  /** Admin: put the VM to sleep (games are stopped first, then deallocate). */
  stop(id: string): CloudMachine {
    const r = this.requireRow(id);
    const st = this.stateOf(r);
    if (st === 'stopping' || st === 'deallocated') return this.machineView(r);
    if (st !== 'running' && st !== 'starting' && !(st === 'failed' && r.serverId !== null)) {
      throw new HttpError(409, 'busy');
    }
    this.wantStart.delete(id);
    this.setState(id, 'stopping', { idleSince: null });
    this.resolveWaiters(id, false);
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'admin',
      action: 'cloud.machine_stop',
      target: id,
      details: { name: r.name },
    });
    if (r.serverId) {
      const serverId = r.serverId;
      this.stopJobs.add(id);
      this.track(
        this.stopGames(serverId).finally(() => {
          this.stopJobs.delete(id);
          this.kick();
        }),
      );
    } else this.kick();
    return this.machine(id);
  }

  /** compose down of every running game on the server (best effort, before deallocate). */
  private async stopGames(serverId: string): Promise<void> {
    if (!this.deps.hub.isConnected(serverId)) return;
    for (const gid of this.deps.games.gameIdsOn(serverId)) {
      if (!this.deps.games.isRunning(gid)) continue;
      try {
        await this.deps.games.action(gid, 'stop', 'system');
      } catch (err) {
        this.deps.log.warn(
          { gameId: gid, err: err instanceof Error ? err.name : 'error' },
          'game stop before deallocate failed',
        );
      }
    }
  }

  update(id: string, idleMinutes: number): CloudMachine {
    const r = this.requireRow(id);
    this.patch(id, { idleMinutes, idleSince: null });
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'admin',
      action: 'cloud.machine_updated',
      target: id,
      details: { name: r.name, idleMinutes },
    });
    return this.machine(id);
  }

  /** Step-up and name checked by the route. Refused while games live on it. */
  remove(id: string, confirmName: string): CloudMachine {
    const r = this.requireRow(id);
    if (confirmName !== r.name) throw new HttpError(400, 'confirm_mismatch');
    if (this.stateOf(r) === 'deleting') return this.machineView(r);
    if (r.serverId && this.deps.games.gameIdsOn(r.serverId).length > 0) {
      throw new HttpError(
        409,
        'conflict',
        undefined,
        'Erst die Gameserver auf diesem Cloud-Server löschen oder umziehen',
      );
    }
    if (r.onboardingId) this.deps.onboarding.cancel(r.onboardingId);
    this.wantStart.delete(id);
    this.setState(id, 'deleting', { idleSince: null, pendingGameJson: null });
    this.resolveWaiters(id, false);
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'admin',
      action: 'cloud.machine_delete',
      target: id,
      details: { name: r.name },
    });
    this.kick();
    return this.machine(id);
  }

  // ---- GameCloudHost -------------------------------------------------------------

  startGate(serverId: string): 'ready' | 'wake' | 'over_budget' {
    if (!this.active) return 'ready';
    const r = this.byServer(serverId);
    if (!r) return 'ready';
    const st = this.stateOf(r);
    if (st === 'starting') return 'wake';
    if (this.canStart(r)) return this.overBudget() ? 'over_budget' : 'wake';
    return 'ready';
  }

  ensureRunning(serverId: string, actor: string): Promise<boolean> {
    const r = this.byServer(serverId);
    if (!r) return Promise.resolve(true);
    if (this.stateOf(r) === 'running' && this.ready(r)) return Promise.resolve(true);
    if (!this.active) return Promise.resolve(false);
    if (this.canStart(r)) this.requestStart(r, actor);
    return new Promise<boolean>((resolve) => {
      const list = this.waiters.get(r.id) ?? [];
      list.push({ fn: resolve, at: this.deps.now() });
      this.waiters.set(r.id, list);
      this.kick();
    });
  }

  statusText(serverId: string): string | null {
    const r = this.byServer(serverId);
    if (!r) return null;
    const st = this.stateOf(r);
    if (st === 'deallocated' || st === 'stopping') return CLOUD_GAME_TEXT.deallocated;
    if (st === 'starting') return CLOUD_GAME_TEXT.starting;
    return null;
  }

  /** For the server status: a deallocated VM is OFF, not offline. */
  isAsleep(serverId: string): boolean {
    const r = this.byServer(serverId);
    return r !== undefined && ASLEEP.has(this.stateOf(r));
  }

  /**
   * Game relay (upcoming): a friend connects to a game on a sleeping cloud VM.
   * Automatic start: refused over budget.
   */
  async wakeForGame(
    gameId: string,
  ): Promise<'not_found' | 'not_cloud' | 'running' | 'starting' | 'over_budget' | 'failed'> {
    const row = this.deps.games.row(gameId);
    if (!row) return 'not_found';
    if (!this.byServer(row.serverId)) return 'not_cloud';
    const gate = this.startGate(row.serverId);
    if (gate === 'over_budget') return 'over_budget';
    if (gate === 'ready' && this.deps.games.isRunning(gameId)) return 'running';
    try {
      await this.deps.games.action(gameId, 'start', 'system');
    } catch {
      return 'failed';
    }
    return gate === 'wake' ? 'starting' : 'running';
  }

  /** The agent is back and has sent metrics after the start request. */
  private ready(r: CloudMachineRow): boolean {
    if (!r.serverId || !this.deps.hub.isConnected(r.serverId)) return false;
    const since = this.startRequestedAt.get(r.id);
    if (since === undefined) return true;
    const st = this.deps.db
      .select({ at: serverState.metricsAt })
      .from(serverState)
      .where(eq(serverState.serverId, r.serverId))
      .get();
    return st?.at !== null && st?.at !== undefined && st.at >= since;
  }

  private resolveWaiters(id: string, ok: boolean): void {
    const list = this.waiters.get(id);
    if (!list) return;
    this.waiters.delete(id);
    for (const w of list) w.fn(ok);
  }

  /** Waiters whose VM did not come back in CLOUD_START_TIMEOUT_MINUTES give up. */
  private expireWaiters(now: number): void {
    for (const [id, list] of [...this.waiters]) {
      const keep = list.filter((w) => now - w.at <= START_TIMEOUT_MS);
      for (const w of list) if (!keep.includes(w)) w.fn(false);
      if (keep.length > 0) this.waiters.set(id, keep);
      else this.waiters.delete(id);
    }
  }

  // ---- tick -------------------------------------------------------------------------

  /** Scheduler job: runs the state machine in the background (never overlaps). */
  tick(): void {
    if (!this.active) return;
    this.kick();
  }

  private kick(): void {
    if (!this.active) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    const run = async (): Promise<void> => {
      do {
        this.again = false;
        await this.runTick();
      } while (this.again && this.active);
    };
    this.ticking = run().finally(() => {
      this.ticking = null;
    });
    this.track(this.ticking);
  }

  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  private track<T>(p: Promise<T>): void {
    const tracked = p.catch((err: unknown) => {
      this.deps.log.error(
        { err: err instanceof Error ? { name: err.name } : 'error' },
        'cloud task failed',
      );
    });
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  private async runTick(): Promise<void> {
    const creds = this.store.credentials();
    for (const r of this.rows()) {
      if (!this.active) return;
      try {
        await this.step(r, creds.kind === 'ok' ? creds.value : null);
      } catch (err) {
        this.onStepError(r.id, err);
      }
    }
    // Usage up to now, also without state changes.
    const now = this.deps.now();
    for (const r of this.rows()) {
      if (BILLABLE.has(this.stateOf(r)) && now - r.updatedAt >= 60_000) this.patch(r.id, {});
    }
    this.expireWaiters(now);
    this.budgetAlerts();
  }

  private onStepError(id: string, err: unknown): void {
    const r = this.row(id);
    if (!r) return;
    const text: CloudErrorText =
      err instanceof AzureError ? err.text : 'Unerwartete Antwort von Azure';
    const transient = err instanceof AzureError ? err.transient : false;
    if (text === 'Zugangsdaten ungültig' || text === 'Keine Berechtigung in der Ressourcengruppe') {
      this.store.markError(text);
    }
    this.deps.log.info({ machineId: id, state: r.state, error: text }, 'cloud step failed');
    const st = this.stateOf(r);
    if (transient) {
      this.patch(id, { stateText: `${CLOUD_MACHINE_STATE_TEXT[st]} (${text})` });
      return;
    }
    if (st === 'creating') this.fail(r, text);
    else if (st === 'starting') {
      this.startIssued.delete(id);
      this.setState(id, 'deallocated', {
        error: text,
        stateText: `${CLOUD_MACHINE_STATE_TEXT.deallocated} (${text})`,
      });
      this.resolveWaiters(id, false);
    } else this.patch(id, { error: text, stateText: `${CLOUD_MACHINE_STATE_TEXT[st]} (${text})` });
  }

  private fail(r: CloudMachineRow, text: CloudErrorText): void {
    this.startIssued.delete(r.id);
    this.wantStart.delete(r.id);
    this.setState(r.id, 'failed', { error: text, idleSince: null });
    this.resolveWaiters(r.id, false);
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'system',
      action: 'cloud.machine_failed',
      target: r.id,
      details: { name: r.name, state: r.state, error: text },
    });
    this.deps.alerts.raise(
      `cloud:${r.id}:failed`,
      'crit',
      `Cloud-Server ${r.name}: ${text}`,
      `${CLOUD_MACHINE_STATE_TEXT[this.stateOf(r)]} ist fehlgeschlagen. Auf der Seite Cloud neu starten oder löschen.`,
      r.serverId,
      'system',
    );
  }

  private async step(r: CloudMachineRow, creds: AzureCredentials | null): Promise<void> {
    const st = this.stateOf(r);
    const now = this.deps.now();
    switch (st) {
      case 'creating':
        if (now - r.stateChangedAt > INSTALL_TIMEOUT_MS) return this.fail(r, 'Zeitüberschreitung');
        if (!creds) return;
        return this.provision(r, creds);
      case 'installing':
        return this.install(r, creds);
      case 'running':
        return this.running(r, creds);
      case 'stopping':
        if (!creds || this.stopJobs.has(r.id)) return;
        return this.stopping(r, creds);
      case 'starting':
        if (!creds) return;
        return this.starting(r, creds);
      case 'deleting':
        if (!creds) return;
        return this.deleting(r, creds);
      case 'deallocated':
        if (r.serverId && creds) await this.syncNsg(r, creds);
        return;
      case 'failed':
        return;
    }
  }

  private async provision(r: CloudMachineRow, creds: AzureCredentials): Promise<void> {
    const az = this.deps.azure;
    const region = this.regionOf(r);
    const steps: ('vnet' | 'nsg' | 'ip' | 'nic' | 'vm')[] = r.publicIpEnabled
      ? ['vnet', 'nsg', 'ip', 'nic', 'vm']
      : ['vnet', 'nsg', 'nic', 'vm'];
    for (const kind of steps) {
      const ps = await az.provisioningState(creds, kind, r.name, region);
      if (ps === 'Failed' || ps === 'Canceled')
        return this.fail(r, 'Unerwartete Antwort von Azure');
      if (ps === 'InProgress') return;
      if (ps === 'Succeeded') continue;
      switch (kind) {
        case 'vnet':
          this.patch(r.id, { stateText: 'Netzwerk wird angelegt' });
          return az.putVnet(creds, region);
        case 'nsg':
          this.patch(r.id, { stateText: 'Firewall wird angelegt' });
          return az.putNsg(creds, r.name, region, []);
        case 'ip':
          this.patch(r.id, { stateText: 'Öffentliche IP wird angelegt' });
          return az.putPublicIp(creds, r.name, region);
        case 'nic':
          this.patch(r.id, { stateText: 'Netzwerkkarte wird angelegt' });
          return az.putNic(creds, r.name, region, r.publicIpEnabled);
        case 'vm':
          return this.putVm(r, creds, region);
      }
    }
    const ip = r.publicIpEnabled ? await az.publicIpAddress(creds, r.name, region) : null;
    this.appliedNsg.set(r.id, '[]');
    this.setState(r.id, 'installing', {
      publicIp: ip,
      stateText: 'Docker, Tailscale und Agent werden installiert',
    });
  }

  private async putVm(
    r: CloudMachineRow,
    creds: AzureCredentials,
    region: AzureRegion,
  ): Promise<void> {
    const key = this.store.tailscaleKey();
    if (key.kind === 'unreadable') return this.fail(r, UNREADABLE);
    if (key.kind === 'missing') {
      this.patch(r.id, { stateText: 'Wartet auf den Tailscale-Auth-Key' });
      return;
    }
    const hub = this.deps.onboarding.hub();
    if (!hub) {
      this.patch(r.id, { stateText: 'Wartet auf HZ_BASE_URL' });
      return;
    }
    if (r.onboardingId) this.deps.onboarding.cancel(r.onboardingId);
    let code: string;
    let onboardingId: string;
    try {
      const o = this.deps.onboarding.create(r.name, `Azure ${region}`, {
        ttlMs: INSTALL_TIMEOUT_MS,
      });
      code = o.code;
      onboardingId = o.id;
    } catch (err) {
      if (err instanceof OnboardingError) {
        this.patch(r.id, { stateText: 'Wartet auf einen freien Einrichtungscode' });
        return;
      }
      throw err;
    }
    this.patch(r.id, { onboardingId, stateText: 'Server wird bestellt' });
    const customData = cloudInitCustomData({
      name: r.name,
      tailscaleAuthKey: key.value,
      hubOrigin: hub.origin,
      code,
    });
    try {
      await this.deps.azure.putVm(creds, {
        name: r.name,
        region,
        size: r.size,
        diskType: this.diskTypeOf(r),
        diskGb: r.diskGb,
        publicIp: r.publicIpEnabled,
        customData,
      });
    } catch (err) {
      this.deps.onboarding.cancel(onboardingId);
      throw err;
    }
  }

  private async install(r: CloudMachineRow, creds: AzureCredentials | null): Promise<void> {
    const now = this.deps.now();
    const status = r.onboardingId ? this.deps.onboarding.status(r.onboardingId) : null;
    if (
      status?.state === 'connected' &&
      status.serverId &&
      this.deps.hub.isConnected(status.serverId)
    ) {
      const serverId = status.serverId;
      this.deps.servers.update(serverId, { network: 'cloud' });
      this.setState(r.id, 'running', { serverId, onboardingId: null, idleSince: null });
      writeAudit(this.deps.db, now, {
        actor: 'system',
        action: 'cloud.machine_ready',
        target: r.id,
        details: { name: r.name, serverId },
      });
      this.deps.alerts.resolve(`cloud:${r.id}:failed`);
      const next = this.row(r.id);
      if (next) await this.running(next, creds);
      return;
    }
    if (!status || status.state === 'expired' || now - r.stateChangedAt > INSTALL_TIMEOUT_MS) {
      this.fail(r, 'Agent hat sich nicht gemeldet');
      // A VM without agent only costs money.
      if (creds)
        await this.deps.azure.deallocate(creds, r.name, this.regionOf(r)).catch(() => undefined);
    }
  }

  private async running(r: CloudMachineRow, creds: AzureCredentials | null): Promise<void> {
    if (!r.serverId) return;
    const connected = this.deps.hub.isConnected(r.serverId);
    if (connected && r.pendingGameJson !== null) this.createPendingGame(r, r.serverId);
    if (creds) await this.syncNsg(r, creds);
    const fresh = this.row(r.id);
    if (!fresh) return;
    if (this.ready(fresh)) {
      this.startRequestedAt.delete(fresh.id);
      this.resolveWaiters(fresh.id, true);
    }
    if (creds) await this.idleCheck(fresh, creds);
  }

  private createPendingGame(r: CloudMachineRow, serverId: string): void {
    const pending = this.pendingOf(r);
    if (!pending) {
      this.patch(r.id, { pendingGameJson: null });
      return;
    }
    try {
      const game = this.deps.games.create({
        ...pending,
        serverId,
        externalAddress: pending.externalAddress || (r.publicIp ?? ''),
      });
      writeAudit(this.deps.db, this.deps.now(), {
        actor: 'system',
        action: 'game.created',
        target: game.id,
        details: {
          name: game.name,
          templateId: game.templateId,
          serverId,
          ports: game.ports,
          keys: Object.keys(pending.values).sort(),
          via: 'cloud',
        },
      });
      this.patch(r.id, { pendingGameJson: null });
    } catch (err) {
      const e = err instanceof HttpError ? err : null;
      if (e && (e.code === 'agent_offline' || e.code === 'busy')) return;
      this.patch(r.id, { pendingGameJson: null });
      this.deps.alerts.raise(
        `cloud:${r.id}:game`,
        'warn',
        `Gameserver ${pending.name} konnte auf ${r.name} nicht angelegt werden`,
        `${e?.userMessage ?? 'Bitte im Gameserver-Formular neu anlegen'}.`,
        serverId,
        'game',
      );
    }
  }

  /** NSG = exactly the public game ports of the games on the server. */
  private async syncNsg(r: CloudMachineRow, creds: AzureCredentials): Promise<void> {
    if (!r.serverId) return;
    const rules = nsgRules(this.deps.games.publicPortsOn(r.serverId));
    const key = JSON.stringify(rules);
    if (this.appliedNsg.get(r.id) === key) return;
    await this.deps.azure.putNsg(creds, r.name, this.regionOf(r), rules);
    this.appliedNsg.set(r.id, key);
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'system',
      action: 'cloud.nsg_updated',
      target: r.id,
      details: { name: r.name, ports: rules.map((p) => `${p.proto}/${p.port}`) },
    });
  }

  private idleNow(r: CloudMachineRow): boolean {
    if (!r.serverId || !this.deps.hub.isConnected(r.serverId)) return false;
    if (r.pendingGameJson !== null || this.waiters.has(r.id)) return false;
    const g = this.deps.games;
    return g.gameIdsOn(r.serverId).every((id) => {
      if (g.isBusy(id) || g.waitsForCloud(id)) return false;
      if (g.row(id)?.phase === 'failed') return true;
      return g.summary(id)?.status === 'off';
    });
  }

  private async idleCheck(r: CloudMachineRow, creds: AzureCredentials): Promise<void> {
    if (r.idleMinutes <= 0 || !this.idleNow(r)) {
      if (r.idleSince !== null) this.patch(r.id, { idleSince: null });
      return;
    }
    const now = this.deps.now();
    if (r.idleSince === null) {
      this.patch(r.id, { idleSince: now });
      return;
    }
    if (now - r.idleSince < r.idleMinutes * 60_000) return;
    this.setState(r.id, 'stopping', { idleSince: null });
    writeAudit(this.deps.db, now, {
      actor: 'system',
      action: 'cloud.machine_idle_stop',
      target: r.id,
      details: { name: r.name, idleMinutes: r.idleMinutes },
    });
    this.deps.alerts.log(
      `cloud:${r.id}:sleep`,
      'info',
      `Cloud-Server ${r.name} schläft`,
      `Seit ${r.idleMinutes} Min spielt niemand. Es fallen nur Speicherkosten an; ein Start eines Spiels weckt ihn.`,
      r.serverId,
      'system',
    );
    await this.deps.azure.deallocate(creds, r.name, this.regionOf(r));
  }

  private async stopping(r: CloudMachineRow, creds: AzureCredentials): Promise<void> {
    const region = this.regionOf(r);
    const ps = await this.deps.azure.powerState(creds, r.name, region);
    if (ps === 'deallocated' || ps === null) {
      this.startIssued.delete(r.id);
      if (this.wantStart.delete(r.id)) {
        this.setState(r.id, 'starting');
        return;
      }
      this.setState(r.id, 'deallocated');
      await this.syncNsg(r, creds);
      return;
    }
    if (ps === 'deallocating') return;
    await this.deps.azure.deallocate(creds, r.name, region);
  }

  private async starting(r: CloudMachineRow, creds: AzureCredentials): Promise<void> {
    const region = this.regionOf(r);
    const now = this.deps.now();
    if (now - r.stateChangedAt > START_TIMEOUT_MS) {
      this.fail(r, 'Agent hat sich nicht gemeldet');
      await this.deps.azure.deallocate(creds, r.name, region).catch(() => undefined);
      return;
    }
    if (!this.startIssued.has(r.id)) {
      this.startRequestedAt.set(r.id, this.startRequestedAt.get(r.id) ?? now);
      await this.deps.azure.start(creds, r.name, region);
      this.startIssued.add(r.id);
      this.patch(r.id, { stateText: 'VM startet' });
      return;
    }
    const ps = await this.deps.azure.powerState(creds, r.name, region);
    if (ps !== 'running') return;
    if (!r.serverId || !this.deps.hub.isConnected(r.serverId)) {
      if (r.stateText !== 'Wartet auf den Agent')
        this.patch(r.id, { stateText: 'Wartet auf den Agent' });
      return;
    }
    if (!this.ready(r)) return;
    this.startIssued.delete(r.id);
    this.startRequestedAt.delete(r.id);
    this.setState(r.id, 'running', { idleSince: null });
    this.deps.alerts.resolve(`cloud:${r.id}:failed`);
    this.resolveWaiters(r.id, true);
  }

  private async deleting(r: CloudMachineRow, creds: AzureCredentials): Promise<void> {
    const az = this.deps.azure;
    const region = this.regionOf(r);
    for (const kind of ['vm', 'nic', 'ip', 'nsg', 'disk'] as const) {
      const ps = await az.provisioningState(creds, kind, r.name, region);
      if (ps === null) continue;
      this.patch(r.id, { stateText: `${CLOUD_MACHINE_STATE_TEXT.deleting}: ${DELETE_TEXT[kind]}` });
      if (ps !== 'InProgress') await az.remove(creds, kind, r.name, region);
      return;
    }
    this.finishDelete(r);
  }

  private finishDelete(r: CloudMachineRow): void {
    const serverId = r.serverId;
    if (serverId) {
      // Same as DELETE /api/servers/:id: token revoked, connection closed, row removed.
      this.deps.tokens.revoke(serverId);
      this.deps.hub.disconnect(serverId, 'deleted');
      this.deps.hub.forget(serverId);
      this.deps.alerts.resolveAllForServer(serverId);
      this.deps.servers.delete(serverId);
    }
    this.deps.alerts.resolveAllWithPrefix(`cloud:${r.id}:`);
    this.deps.db.delete(cloudMachines).where(eq(cloudMachines.id, r.id)).run();
    this.appliedNsg.delete(r.id);
    this.startIssued.delete(r.id);
    this.startRequestedAt.delete(r.id);
    this.resolveWaiters(r.id, false);
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'system',
      action: 'cloud.machine_deleted',
      target: r.id,
      details: { name: r.name, serverId },
    });
  }

  private budgetAlerts(): void {
    if (this.rows().length === 0 && !this.deps.alerts.active(BUDGET_ALERT)) return;
    const b = this.budget();
    const month = monthKey(this.deps.now());
    const body = `${eurFmt.format(b.monthEur)} von ${eurFmt.format(b.limitEur)} im Monat ${month} (Schätzung).`;
    if (b.state === 'over') {
      this.deps.alerts.raise(
        BUDGET_ALERT,
        'crit',
        'Cloud-Budget aufgebraucht',
        `${body} Automatische Starts sind gesperrt.`,
        null,
        'system',
      );
    } else if (b.state === 'warn') {
      this.deps.alerts.raise(
        BUDGET_ALERT,
        'warn',
        `Cloud-Budget zu ${CLOUD_BUDGET_WARN_PERCENT} % verbraucht`,
        body,
        null,
        'system',
      );
    } else if (this.deps.alerts.active(BUDGET_ALERT)) {
      this.deps.alerts.resolve(BUDGET_ALERT, { title: 'Cloud-Budget wieder im Rahmen', body });
    }
  }
}

const DELETE_TEXT = {
  vm: 'VM',
  nic: 'Netzwerkkarte',
  ip: 'öffentliche IP',
  nsg: 'Firewall',
  disk: 'Festplatte',
} as const;

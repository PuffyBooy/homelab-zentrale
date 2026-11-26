import { and, eq, gte, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  containerLimitDataSchema,
  cpusSchema,
  defaultThrottleSettings,
  scheduleWindowsSchema,
  throttleSettingsSchema,
  TOP_CONSUMERS_LIMIT,
  WICHTIG_RESTART_MAX_ATTEMPTS,
  WICHTIG_RESTART_WINDOW_MINUTES,
  type ContainerInfo,
  type ContainerPriorityRequest,
  type ContainerPriorityResponse,
  type ContainerSummary,
  type GamePriorityRequest,
  type GamePriorityResponse,
  type Priority,
  type ScheduleWindow,
  type ServerThrottleResponse,
  type ServerThrottleUpdateRequest,
  type ThrottleBy,
  type Throttled,
  type ThrottlePhase,
  type ThrottleSettings,
  type TopConsumer,
  type TopConsumersResponse,
} from '@hz/shared';
import type { AgentHub } from '../agents/hub.js';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import type { ContainerControl, ContainerService } from '../containers/service.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import {
  containerPriorities,
  containerThrottles,
  containers,
  gameServers,
  servers,
  serverState,
  serverThrottle,
  wichtigRestarts,
  type ContainerRow,
  type ContainerThrottleRow,
  type GameServerRow,
  type ServerRow,
} from '../db/schema.js';
import { GAMES_ROOT, type GameService, type RamCheckResult } from '../games/service.js';
import { HttpError } from '../http/errors.js';
import { activeWindows, tierRule, type TierRule } from './schedule.js';
import {
  ADMIN_REASON,
  autoRestartKey,
  autoRestartedText,
  autoStopKey,
  autoStoppedText,
  loadReason,
  restartFailedText,
  scheduleReason,
  startedAgainText,
  throttleKey,
  throttledText,
  unthrottledText,
  type Load,
} from './texts.js';

const MIN = 60_000;
const LIMIT_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 60_000;
/** Metrics older than this do not count (agent silent): no automatic action. */
const METRICS_FRESH_MS = 60_000;
/** Between two restart attempts of a wichtig container (the inventory needs to catch up). */
const RESTART_SPACING_MS = MIN;
const RESTART_WINDOW_MS = WICHTIG_RESTART_WINDOW_MINUTES * MIN;
const MIB = 1024 * 1024;

/**
 * RCON command that saves the world before an automatic stop. Templates have no
 * field for it yet (docs/QUESTIONS.md 2026-11-26); unknown templates are stopped
 * without saving (compose down lets the game save on SIGTERM anyway).
 */
export const SAVE_COMMANDS: Record<string, string> = {
  'minecraft-java': 'save-all',
  palworld: 'Save',
};

export interface ThrottleDeps {
  db: Db;
  now: Clock;
  hub: Pick<AgentHub, 'call' | 'isConnected'>;
  alerts: AlertService;
  containers: ContainerService;
  games: GameService;
  log: FastifyBaseLogger;
}

interface Runtime {
  /** Server above cpuPct/ramPct since. */
  overSince: number | null;
  /** Server below threshold minus margin since. */
  belowSince: number | null;
  /** Last automatic throttle in the current over period (one per forMinutes step). */
  lastThrottleAt: number | null;
  load: Load | null;
}

interface Effective {
  priority: Priority;
  allowStop: boolean;
  allowStopWithPlayers: boolean;
  protected: boolean;
  game: GameServerRow | null;
}

interface ServerConfig {
  settings: ThrottleSettings;
  schedules: ScheduleWindow[];
}

type Actor = 'admin' | 'system';

type LiftWhy =
  'recovered' | 'window' | 'priority' | 'disabled' | 'admin' | 'recreated' | 'stopped' | 'removed';

function parseJson(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function infoOf(row: ContainerRow): Partial<ContainerInfo> {
  const v = parseJson(row.infoJson);
  return v !== null && typeof v === 'object' ? (v as Partial<ContainerInfo>) : {};
}

/** hz.role core/agent: always wichtig, never a target. */
export function isProtected(row: ContainerRow): boolean {
  const role = infoOf(row).role;
  return role === 'core' || role === 'agent';
}

/** A --cpus value that container.limit accepts, else null (= no limit). */
function validCpus(v: number | null | undefined): number | null {
  if (v === null || v === undefined || v <= 0) return null;
  const p = cpusSchema.safeParse(v);
  return p.success ? p.data : null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Priorities and automatic throttling (SPEC 6a, ROADMAP M10): data (priorities,
 * settings, schedules, throttle state), the RAM reserve for game starts and the
 * rule set that runs on the metrics tick (`tick()`, scheduler job `throttle.tick`).
 */
export class ThrottleService {
  private readonly runtime = new Map<string, Runtime>();
  /** Containers the admin unthrottled during a `cpus` window: not limited again until it ends. */
  private readonly scheduleSkip = new Set<string>();
  /**
   * RAM held by game starts that passed the check but whose compose up has not
   * returned yet (the metrics do not show them yet): serverId -> hold -> bytes.
   */
  private readonly held = new Map<string, Map<symbol, number>>();

  constructor(private readonly deps: ThrottleDeps) {}

  // ---- reads -------------------------------------------------------------------

  private serverRow(id: string): ServerRow | undefined {
    return this.deps.db.select().from(servers).where(eq(servers.id, id)).get();
  }

  private gamesOf(serverId: string): GameServerRow[] {
    return this.deps.db.select().from(gameServers).where(eq(gameServers.serverId, serverId)).all();
  }

  /**
   * The game a container belongs to: its label homelab.game (M12) first; without
   * a label the compose dir /opt/homelab/games/<name> or the name game-<name>.
   */
  private gameFor(row: ContainerRow, games: readonly GameServerRow[]): GameServerRow | null {
    if (row.gameLabel !== null) return games.find((g) => g.name === row.gameLabel) ?? null;
    return (
      games.find(
        (g) => row.composeDir === `${GAMES_ROOT}${g.name}` || row.name === `game-${g.name}`,
      ) ?? null
    );
  }

  private effective(row: ContainerRow, games: readonly GameServerRow[]): Effective {
    const game = this.gameFor(row, games);
    if (isProtected(row)) {
      return {
        priority: 'wichtig',
        allowStop: false,
        allowStopWithPlayers: false,
        protected: true,
        game,
      };
    }
    if (game) {
      return {
        priority: game.priority as Priority,
        allowStop: game.allowStop,
        allowStopWithPlayers: game.allowStopWithPlayers,
        protected: false,
        game,
      };
    }
    const p = this.deps.db
      .select()
      .from(containerPriorities)
      .where(eq(containerPriorities.containerId, row.id))
      .get();
    return {
      priority: (p?.priority as Priority | undefined) ?? 'normal',
      allowStop: p?.allowStop ?? false,
      allowStopWithPlayers: false,
      protected: false,
      game: null,
    };
  }

  private throttleRow(containerId: string): ContainerThrottleRow | undefined {
    return this.deps.db
      .select()
      .from(containerThrottles)
      .where(eq(containerThrottles.containerId, containerId))
      .get();
  }

  private throttledOf(t: ContainerThrottleRow | undefined): Throttled | null {
    if (!t || t.cpus === null || t.by === null || t.since === null) return null;
    return { cpus: t.cpus, since: iso(t.since), by: t.by as ThrottleBy, reason: t.reason ?? '' };
  }

  /** Summary fields of a container (ContainerService.setControl). */
  control(row: ContainerRow): ContainerControl {
    const e = this.effective(row, this.gamesOf(row.serverId));
    const t = this.throttleRow(row.id);
    return {
      priority: e.priority,
      allowStop: e.allowStop,
      protected: e.protected,
      gameId: e.game?.id ?? null,
      throttled: this.throttledOf(t),
      autoStopped: t?.autoStoppedAt !== null && t?.autoStoppedAt !== undefined,
    };
  }

  /** Throttle part of a GameSummary (by game id, also after compose down removed the container). */
  throttleOf(gameId: string): { throttled: Throttled | null; autoStopped: boolean } {
    const rows = this.deps.db
      .select()
      .from(containerThrottles)
      .where(eq(containerThrottles.gameId, gameId))
      .all();
    return {
      throttled: this.throttledOf(rows.find((r) => r.cpus !== null)),
      autoStopped: rows.some((r) => r.autoStoppedAt !== null),
    };
  }

  // ---- settings ------------------------------------------------------------------

  config(serverId: string): ServerConfig {
    const row = this.deps.db
      .select()
      .from(serverThrottle)
      .where(eq(serverThrottle.serverId, serverId))
      .get();
    if (!row) return { settings: { ...defaultThrottleSettings }, schedules: [] };
    const s = throttleSettingsSchema.safeParse(parseJson(row.settingsJson) ?? {});
    const w = scheduleWindowsSchema.safeParse(parseJson(row.schedulesJson) ?? []);
    return {
      settings: s.success ? s.data : { ...defaultThrottleSettings },
      schedules: w.success ? w.data : [],
    };
  }

  serverThrottle(serverId: string): ServerThrottleResponse {
    const cfg = this.config(serverId);
    const now = this.deps.now();
    const ram = this.latestRam(serverId);
    const st = this.phaseOf(serverId, cfg.settings);
    return {
      serverId,
      settings: cfg.settings,
      schedules: cfg.schedules,
      status: {
        phase: st.phase,
        since: st.since === null ? null : iso(st.since),
        ramReserveBytes: ram ? this.reserveBytes(serverId, cfg.settings, new Set()) : null,
        freeRamBytes: ram ? Math.max(0, ram.totalBytes - ram.usedBytes) : null,
        activeWindows: activeWindows(cfg.schedules, now),
      },
    };
  }

  async updateServerThrottle(
    serverId: string,
    req: ServerThrottleUpdateRequest,
  ): Promise<ServerThrottleResponse> {
    const prev = this.config(serverId);
    const settings: ThrottleSettings = throttleSettingsSchema.parse({
      ...prev.settings,
      ...(req.settings ?? {}),
    });
    const schedules = req.schedules ?? prev.schedules;
    const now = this.deps.now();
    const values = {
      settingsJson: JSON.stringify(settings),
      schedulesJson: JSON.stringify(schedules),
      updatedAt: now,
    };
    this.deps.db
      .insert(serverThrottle)
      .values({ serverId, ...values })
      .onConflictDoUpdate({ target: serverThrottle.serverId, set: values })
      .run();
    writeAudit(this.deps.db, now, {
      actor: 'admin',
      action: 'throttle.settings_changed',
      target: serverId,
      details: {
        ...(req.settings ? { settings: req.settings } : {}),
        ...(req.schedules ? { schedules: req.schedules.length } : {}),
      },
    });
    // Automatik switched off: the rule set's own throttles go (admin throttles stay).
    if (prev.settings.enabled && !settings.enabled) {
      this.runtime.delete(serverId);
      for (const t of this.throttlesOf(serverId)) {
        if (t.cpus !== null && t.by !== 'admin') {
          await this.lift(t, 'system', 'disabled').catch((err: unknown) =>
            this.logErr(err, 'lift'),
          );
        }
      }
    }
    return this.serverThrottle(serverId);
  }

  private throttlesOf(serverId: string): ContainerThrottleRow[] {
    return this.deps.db
      .select()
      .from(containerThrottles)
      .where(eq(containerThrottles.serverId, serverId))
      .all();
  }

  private phaseOf(
    serverId: string,
    settings: ThrottleSettings,
  ): { phase: ThrottlePhase; since: number | null } {
    if (!settings.enabled) return { phase: 'disabled', since: null };
    const rt = this.runtime.get(serverId);
    const auto = this.throttlesOf(serverId).filter((t) => t.cpus !== null && t.by === 'auto');
    if (auto.length > 0) {
      if (rt?.belowSince != null) return { phase: 'recovering', since: rt.belowSince };
      return { phase: 'throttled', since: Math.min(...auto.map((t) => t.since ?? Infinity)) };
    }
    if (rt?.overSince != null) return { phase: 'over', since: rt.overSince };
    return { phase: 'idle', since: null };
  }

  // ---- priorities ------------------------------------------------------------------

  private requireContainer(id: string): ContainerRow {
    const row = this.deps.containers.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  }

  containerPriority(id: string): ContainerPriorityResponse {
    const row = this.requireContainer(id);
    const e = this.effective(row, this.gamesOf(row.serverId));
    return {
      containerId: row.id,
      serverId: row.serverId,
      containerName: row.name,
      priority: e.priority,
      allowStop: e.allowStop,
      protected: e.protected,
      gameId: e.game?.id ?? null,
    };
  }

  async setContainerPriority(
    id: string,
    req: ContainerPriorityRequest,
  ): Promise<ContainerPriorityResponse> {
    const row = this.requireContainer(id);
    if (isProtected(row)) throw new HttpError(403, 'forbidden');
    if (this.gameFor(row, this.gamesOf(row.serverId))) throw new HttpError(409, 'conflict');
    const now = this.deps.now();
    const values = { priority: req.priority, allowStop: req.allowStop, updatedAt: now };
    this.deps.db
      .insert(containerPriorities)
      .values({ containerId: row.id, serverId: row.serverId, containerName: row.name, ...values })
      .onConflictDoUpdate({ target: containerPriorities.containerId, set: values })
      .run();
    writeAudit(this.deps.db, now, {
      actor: 'admin',
      action: 'priority.changed',
      target: row.id,
      details: { serverId: row.serverId, name: row.name, ...req },
    });
    await this.reconcileOne(row);
    this.deps.containers.touch(row.id);
    return this.containerPriority(id);
  }

  gamePriority(gameId: string): GamePriorityResponse {
    const g = this.deps.games.row(gameId);
    if (!g) throw new HttpError(404, 'not_found');
    return {
      gameId: g.id,
      priority: g.priority as Priority,
      allowStop: g.allowStop,
      allowStopWithPlayers: g.allowStopWithPlayers,
    };
  }

  async setGamePriority(gameId: string, req: GamePriorityRequest): Promise<GamePriorityResponse> {
    const g = this.deps.games.row(gameId);
    if (!g) throw new HttpError(404, 'not_found');
    const now = this.deps.now();
    this.deps.db
      .update(gameServers)
      .set({
        priority: req.priority,
        allowStop: req.allowStop,
        allowStopWithPlayers: req.allowStopWithPlayers,
        updatedAt: now,
      })
      .where(eq(gameServers.id, gameId))
      .run();
    writeAudit(this.deps.db, now, {
      actor: 'admin',
      action: 'priority.changed',
      target: gameId,
      details: { game: g.name, serverId: g.serverId, ...req },
    });
    const games = this.gamesOf(g.serverId);
    for (const c of this.containersOf(g.serverId)) {
      if (this.gameFor(c, games)?.id !== gameId) continue;
      await this.reconcileOne(c);
      this.deps.containers.touch(c.id);
    }
    this.deps.games.refreshAll(g.serverId);
    return this.gamePriority(gameId);
  }

  /** Lifts a rule-set throttle that no longer fits the container's priority (now). */
  private async reconcileOne(row: ContainerRow): Promise<void> {
    const t = this.throttleRow(row.id);
    if (!t || t.cpus === null || t.by === 'admin') return;
    const cfg = this.config(row.serverId);
    const active = activeWindows(cfg.schedules, this.deps.now());
    const e = this.effective(row, this.gamesOf(row.serverId));
    if (!this.keeps(t, e, this.rules(cfg.schedules, active), row.id)) {
      await this.lift(t, 'system', 'priority').catch((err: unknown) => this.logErr(err, 'lift'));
    }
  }

  // ---- RAM reserve ---------------------------------------------------------------------

  /** RAM of the server from metrics at most METRICS_FRESH_MS old, else null (unknown). */
  private latestRam(serverId: string): { usedBytes: number; totalBytes: number } | null {
    const st = this.deps.db
      .select({ m: serverState.metricsJson, at: serverState.metricsAt })
      .from(serverState)
      .where(eq(serverState.serverId, serverId))
      .get();
    if (st?.at == null || this.deps.now() - st.at > METRICS_FRESH_MS) return null;
    const m = parseJson(st.m ?? null) as {
      ram?: { usedBytes: number; totalBytes: number };
    } | null;
    const ram = m?.ram;
    if (!ram || typeof ram.usedBytes !== 'number' || typeof ram.totalBytes !== 'number') {
      return null;
    }
    return ram.totalBytes > 0 ? ram : null;
  }

  private heldBytes(serverId: string): number {
    let sum = 0;
    for (const b of this.held.get(serverId)?.values() ?? []) sum += b;
    return sum;
  }

  private containersOf(serverId: string): ContainerRow[] {
    return this.deps.db.select().from(containers).where(eq(containers.serverId, serverId)).all();
  }

  /**
   * Reserve in bytes: ramReserveMb, or (0) the memory of the wichtig containers
   * (running: current value, stopped: last known value). `exclude`: the
   * containers of the game that wants to start (not counted for itself).
   */
  private reserveBytes(serverId: string, settings: ThrottleSettings, exclude: Set<string>): number {
    if (settings.ramReserveMb > 0) return settings.ramReserveMb * MIB;
    const games = this.gamesOf(serverId);
    let sum = 0;
    for (const c of this.containersOf(serverId)) {
      if (exclude.has(c.id)) continue;
      if (this.effective(c, games).priority !== 'wichtig') continue;
      sum += c.memBytes ?? c.lastMemBytes ?? 0;
    }
    return sum;
  }

  reserveOf(serverId: string, own: readonly string[]): number | null {
    if (!this.latestRam(serverId)) return null;
    return this.reserveBytes(serverId, this.config(serverId).settings, new Set(own));
  }

  /**
   * Whether `neededBytes` fit into free RAM minus the reserve minus the RAM held
   * by starts still in flight on the same server (`holdRam`). `freeBytes` in the
   * details already has the held RAM taken off.
   */
  ramCheck(serverId: string, neededBytes: number, own: readonly string[]): RamCheckResult {
    const ram = this.latestRam(serverId);
    if (!ram) return { kind: 'unknown' };
    const freeBytes = Math.max(0, ram.totalBytes - ram.usedBytes - this.heldBytes(serverId));
    const reserveBytes = this.reserveBytes(serverId, this.config(serverId).settings, new Set(own));
    if (freeBytes - reserveBytes >= neededBytes) return { kind: 'fits' };
    return { kind: 'insufficient', details: { freeBytes, reserveBytes, neededBytes } };
  }

  /**
   * Holds `bytes` for a start in flight; the returned function releases it
   * (idempotent, after compose up returned or failed). Check and hold run
   * synchronously one after the other, so two concurrent starts on a server
   * never both count the same free RAM.
   */
  holdRam(serverId: string, bytes: number): () => void {
    if (bytes <= 0) return () => undefined;
    const key = Symbol('hold');
    let m = this.held.get(serverId);
    if (!m) {
      m = new Map();
      this.held.set(serverId, m);
    }
    m.set(key, bytes);
    return () => {
      const cur = this.held.get(serverId);
      if (!cur) return;
      cur.delete(key);
      if (cur.size === 0) this.held.delete(serverId);
    };
  }

  // ---- top consumers ---------------------------------------------------------------------

  topConsumers(): TopConsumersResponse {
    const running = this.deps.containers.list().filter((c) => c.state === 'running');
    const toItem = (c: ContainerSummary): TopConsumer => ({
      containerId: c.id,
      containerName: c.name,
      serverId: c.serverId,
      serverName: c.serverName,
      cpuPct: c.cpu,
      memBytes: c.memBytes,
      priority: c.priority,
      protected: c.protected,
      throttled: c.throttled,
      isGame: c.gameId !== null,
      gameId: c.gameId,
    });
    const top = (key: 'cpu' | 'memBytes') =>
      running
        .filter((c) => c[key] !== null)
        .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0) || a.name.localeCompare(b.name))
        .slice(0, TOP_CONSUMERS_LIMIT)
        .map(toItem);
    return { byCpu: top('cpu'), byRam: top('memBytes'), updatedAt: iso(this.deps.now()) };
  }

  // ---- limits (agent action container.limit) ----------------------------------------------

  private async setLimit(row: ContainerRow, cpus: number | null): Promise<number | null> {
    // Defense in depth: the agent refuses hz.role containers as well.
    if (isProtected(row)) throw new HttpError(403, 'forbidden');
    const data = await this.deps.hub.call(
      row.serverId,
      'container.limit',
      { id: row.dockerId, cpus },
      { timeoutMs: LIMIT_TIMEOUT_MS },
    );
    const parsed = containerLimitDataSchema.safeParse(data);
    return parsed.success ? parsed.data.cpus : cpus;
  }

  private upsertThrottle(
    row: ContainerRow,
    gameId: string | null,
    values: Partial<Omit<ContainerThrottleRow, 'containerId' | 'serverId' | 'containerName'>>,
  ): void {
    const now = this.deps.now();
    const set = { ...values, updatedAt: now };
    this.deps.db
      .insert(containerThrottles)
      .values({
        containerId: row.id,
        serverId: row.serverId,
        containerName: row.name,
        gameId,
        ...set,
      })
      .onConflictDoUpdate({ target: containerThrottles.containerId, set: { gameId, ...set } })
      .run();
  }

  /** Drops the row when nothing (throttle, auto-stop mark) is left in it. */
  private compact(containerId: string): void {
    const t = this.throttleRow(containerId);
    if (t && t.cpus === null && t.autoStoppedAt === null) {
      this.deps.db
        .delete(containerThrottles)
        .where(eq(containerThrottles.containerId, containerId))
        .run();
    }
  }

  private notify(row: { containerId: string } | ContainerRow): void {
    const id = 'containerId' in row ? row.containerId : row.id;
    this.deps.containers.touch(id);
    this.deps.games.queueRefresh();
  }

  /** Sets a --cpus limit and records it. */
  private async throttle(
    row: ContainerRow,
    e: Effective,
    cpus: number,
    by: ThrottleBy,
    reason: string,
    actor: Actor,
  ): Promise<void> {
    const prev = this.throttleRow(row.id);
    const wasThrottled = prev !== undefined && prev.cpus !== null;
    const original = wasThrottled ? prev.originalCpus : validCpus(infoOf(row).cpuLimit);
    const applied = await this.setLimit(row, cpus);
    const now = this.deps.now();
    this.upsertThrottle(row, e.game?.id ?? null, {
      dockerId: row.dockerId,
      cpus: applied ?? cpus,
      originalCpus: original,
      by,
      reason,
      since: wasThrottled && prev.by === by && prev.since !== null ? prev.since : now,
    });
    writeAudit(this.deps.db, now, {
      actor,
      action: 'throttle.applied',
      target: row.id,
      details: { serverId: row.serverId, name: row.name, cpus, by, reason },
    });
    if (by === 'auto') {
      const t = throttledText(row.name, reason, cpus, now);
      this.deps.alerts.raise(
        throttleKey(row.serverId, row.name),
        'warn',
        t.title,
        t.body,
        row.serverId,
        e.game ? 'game' : 'container',
      );
    }
    this.notify(row);
  }

  /**
   * Removes a throttle and restores the limit from before. Skipped only when the
   * container the limit belonged to is gone: recreated (other docker id) or
   * removed (deleted from the inventory, or a game stopped via compose down).
   * A stopped plain container keeps its HostConfig.NanoCpus, so `stopped` does
   * restore it (docker update works on stopped containers); otherwise it would
   * start again with the throttle invisibly in place.
   */
  private async lift(t: ContainerThrottleRow, actor: Actor, why: LiftWhy): Promise<void> {
    if (t.cpus === null) return;
    const row = this.deps.containers.row(t.containerId);
    if (row && row.dockerId === t.dockerId && why !== 'recreated' && why !== 'removed') {
      await this.setLimit(row, validCpus(t.originalCpus));
    }
    const now = this.deps.now();
    this.deps.db
      .update(containerThrottles)
      .set({ cpus: null, originalCpus: null, by: null, reason: null, since: null, updatedAt: now })
      .where(eq(containerThrottles.containerId, t.containerId))
      .run();
    this.compact(t.containerId);
    if (t.by === 'schedule' && why === 'admin') this.scheduleSkip.add(t.containerId);
    writeAudit(this.deps.db, now, {
      actor,
      action: 'throttle.removed',
      target: t.containerId,
      details: { serverId: t.serverId, name: t.containerName, by: t.by, why },
    });
    if (t.by === 'auto') {
      const key = throttleKey(t.serverId, t.containerName);
      if (why === 'stopped' || why === 'removed') {
        const a = this.deps.alerts.active(key);
        if (a) this.deps.alerts.resolveById(a.id);
      } else {
        const serverName = this.serverRow(t.serverId)?.name ?? t.serverId;
        this.deps.alerts.resolve(key, unthrottledText(t.containerName, serverName, now));
      }
    }
    this.notify(t);
  }

  // ---- manual routes ------------------------------------------------------------------------

  async adminThrottle(id: string, cpus: number): Promise<void> {
    const row = this.requireContainer(id);
    if (isProtected(row)) throw new HttpError(403, 'forbidden');
    if (row.state !== 'running') throw new HttpError(409, 'conflict');
    if (!this.deps.hub.isConnected(row.serverId)) throw new HttpError(409, 'agent_offline');
    const e = this.effective(row, this.gamesOf(row.serverId));
    await this.throttle(row, e, cpus, 'admin', ADMIN_REASON, 'admin');
  }

  async adminUnthrottle(id: string): Promise<void> {
    const row = this.requireContainer(id);
    if (isProtected(row)) throw new HttpError(403, 'forbidden');
    const t = this.throttleRow(row.id);
    if (!t || t.cpus === null) return;
    if (!this.deps.hub.isConnected(row.serverId)) throw new HttpError(409, 'agent_offline');
    await this.lift(t, 'admin', 'admin');
  }

  // ---- container changes --------------------------------------------------------------------

  /**
   * After a container change: a recreated container lost its limit, a container
   * that runs again is no longer "automatisch gestoppt".
   */
  onContainerChange(id: string, deleted: boolean): void {
    if (deleted) {
      this.onContainerDeleted(id);
      return;
    }
    const t = this.throttleRow(id);
    if (!t) return;
    const row = this.deps.containers.row(id);
    if (!row) return;
    const now = this.deps.now();
    let changed = false;
    if (t.cpus !== null && t.dockerId !== null && row.dockerId !== t.dockerId) {
      // The --cpus limit belonged to the old container.
      void this.lift(t, 'system', 'recreated').catch((err: unknown) => this.logErr(err, 'lift'));
      return;
    }
    // The stop intent set by autoStop holds until the container ran again.
    if (
      t.autoStoppedAt !== null &&
      row.state === 'running' &&
      this.deps.containers.activeIntent(row) === null
    ) {
      this.deps.db
        .update(containerThrottles)
        .set({ autoStoppedAt: null, updatedAt: now })
        .where(eq(containerThrottles.containerId, id))
        .run();
      this.compact(id);
      this.deps.alerts.resolve(
        autoStopKey(row.serverId, row.name),
        startedAgainText(row.name, now),
      );
      changed = true;
    }
    if (changed) this.notify(row);
  }

  /**
   * A container is gone from the inventory: its restart attempts and its throttle
   * go (the limit belonged to it). A plain container's "automatisch gestoppt"
   * mark and alert go too (nothing left to start again). A game keeps the mark:
   * compose down removes its container, "Wieder starten" goes through the game.
   */
  private onContainerDeleted(id: string): void {
    const db = this.deps.db;
    db.delete(wichtigRestarts).where(eq(wichtigRestarts.containerId, id)).run();
    this.scheduleSkip.delete(id);
    const t = this.throttleRow(id);
    if (!t) return;
    if (t.cpus !== null) {
      void this.lift(t, 'system', 'removed').catch((err: unknown) => this.logErr(err, 'lift'));
    }
    if (t.gameId !== null) return;
    db.delete(containerThrottles).where(eq(containerThrottles.containerId, id)).run();
    if (t.autoStoppedAt !== null) {
      const a = this.deps.alerts.active(autoStopKey(t.serverId, t.containerName));
      if (a) this.deps.alerts.resolveById(a.id);
    }
  }

  /** A game was deleted: its rows go. */
  forgetGame(gameId: string): void {
    this.deps.db.delete(containerThrottles).where(eq(containerThrottles.gameId, gameId)).run();
  }

  forgetServer(serverId: string): void {
    this.runtime.delete(serverId);
  }

  // ---- rule set ------------------------------------------------------------------------------

  private rules(
    schedules: readonly ScheduleWindow[],
    active: readonly number[],
  ): { niedrig: TierRule; normal: TierRule } {
    return {
      niedrig: tierRule(schedules, active, 'niedrig'),
      normal: tierRule(schedules, active, 'normal'),
    };
  }

  /** Whether a rule-set throttle (auto/schedule) still fits. */
  private keeps(
    t: ContainerThrottleRow,
    e: Effective,
    rules: { niedrig: TierRule; normal: TierRule },
    containerId: string,
  ): boolean {
    if (e.protected || e.priority === 'wichtig') return false;
    const rule = rules[e.priority];
    if (t.by === 'auto') return e.priority === 'niedrig' && rule.kind !== 'no_throttle';
    if (t.by === 'schedule') return rule.kind === 'cpus' && !this.scheduleSkip.has(containerId);
    return true;
  }

  private rt(serverId: string): Runtime {
    let r = this.runtime.get(serverId);
    if (!r) {
      r = { overSince: null, belowSince: null, lastThrottleAt: null, load: null };
      this.runtime.set(serverId, r);
    }
    return r;
  }

  private logErr(err: unknown, what: string): void {
    this.deps.log.warn(
      {
        err:
          err instanceof Error
            ? { name: err.name, code: (err as { code?: unknown }).code }
            : 'error',
      },
      `throttle: ${what} failed`,
    );
  }

  /** Runs one agent action of the rule set; a failure is logged and the tick goes on. */
  private async safe(what: string, p: Promise<unknown>): Promise<boolean> {
    try {
      await p;
      return true;
    } catch (err) {
      this.logErr(err, what);
      return false;
    }
  }

  /**
   * Scheduler job (every metrics interval): every connected server once, in
   * parallel, so a hung agent does not delay the rule set (e.g. a wichtig
   * restart) on the other servers.
   */
  async tick(): Promise<void> {
    const list = this.deps.db
      .select()
      .from(servers)
      .all()
      .filter((s) => this.deps.hub.isConnected(s.id));
    const results = await Promise.allSettled(list.map((s) => this.tickServer(s)));
    for (const r of results) if (r.status === 'rejected') this.logErr(r.reason, 'tick');
  }

  private async tickServer(server: ServerRow): Promise<void> {
    const now = this.deps.now();
    const cfg = this.config(server.id);
    const s = cfg.settings;
    if (!s.enabled) {
      this.runtime.delete(server.id);
      return;
    }
    const rt = this.rt(server.id);
    const games = this.gamesOf(server.id);
    const rows = this.containersOf(server.id);
    const active = activeWindows(cfg.schedules, now);
    const rules = this.rules(cfg.schedules, active);
    const items = rows.map((row) => ({ row, e: this.effective(row, games) }));

    // 1. Schedules (and priorities changed since): lift what no longer fits, apply cpus windows.
    for (const tier of ['niedrig', 'normal'] as const) {
      if (rules[tier].kind !== 'cpus') {
        for (const { row, e } of items) if (e.priority === tier) this.scheduleSkip.delete(row.id);
      }
    }
    for (const { row, e } of items) {
      const t = this.throttleRow(row.id);
      if (t && t.cpus !== null && t.by !== 'admin') {
        if (!this.keeps(t, e, rules, row.id)) {
          await this.safe(
            'lift',
            this.lift(t, 'system', t.by === 'schedule' ? 'window' : 'priority'),
          );
          continue;
        }
        const rule = e.priority === 'wichtig' ? null : rules[e.priority];
        if (t.by === 'schedule' && rule?.kind === 'cpus' && t.cpus !== rule.cpus) {
          await this.safe(
            'throttle',
            this.throttle(row, e, rule.cpus, 'schedule', scheduleReason(rule.cpus), 'system'),
          );
        }
        continue;
      }
      if (t && t.cpus !== null) continue;
      if (row.state !== 'running' || e.protected || e.priority === 'wichtig') continue;
      const rule = rules[e.priority];
      if (rule.kind === 'cpus' && !this.scheduleSkip.has(row.id)) {
        await this.safe(
          'throttle',
          this.throttle(row, e, rule.cpus, 'schedule', scheduleReason(rule.cpus), 'system'),
        );
      }
    }

    // 2. Load.
    const st = this.deps.db
      .select()
      .from(serverState)
      .where(eq(serverState.serverId, server.id))
      .get();
    const m = parseJson(st?.metricsJson ?? null) as {
      cpu?: number;
      ram?: { usedBytes: number; totalBytes: number };
    } | null;
    const fresh = st?.metricsAt != null && now - st.metricsAt <= METRICS_FRESH_MS;
    if (!fresh || typeof m?.cpu !== 'number' || !m.ram || m.ram.totalBytes <= 0) {
      rt.overSince = null;
      rt.belowSince = null;
      rt.lastThrottleAt = null;
    } else {
      const cpu = m.cpu;
      const ram = (m.ram.usedBytes / m.ram.totalBytes) * 100;
      const over = cpu >= s.cpuPct || ram >= s.ramPct;
      const below = cpu < s.cpuPct - s.recoverMarginPct && ram < s.ramPct - s.recoverMarginPct;
      if (over) {
        rt.belowSince = null;
        rt.overSince ??= now;
        rt.load = cpu >= s.cpuPct ? { metric: 'CPU', value: cpu } : { metric: 'RAM', value: ram };
        await this.whileOver(server, cfg, rt, items, rules, now);
      } else if (below) {
        rt.overSince = null;
        rt.lastThrottleAt = null;
        rt.belowSince ??= now;
        if (now - rt.belowSince >= s.recoverMinutes * MIN) {
          for (const t of this.throttlesOf(server.id)) {
            if (t.cpus !== null && t.by === 'auto') {
              await this.safe('lift', this.lift(t, 'system', 'recovered'));
            }
          }
        }
      } else {
        rt.overSince = null;
        rt.belowSince = null;
        rt.lastThrottleAt = null;
      }
    }

    // 3. wichtig containers that stopped.
    await this.restartWichtig(server, items, now);
  }

  private async whileOver(
    server: ServerRow,
    cfg: ServerConfig,
    rt: Runtime,
    items: { row: ContainerRow; e: Effective }[],
    rules: { niedrig: TierRule; normal: TierRule },
    now: number,
  ): Promise<void> {
    const s = cfg.settings;
    const forMs = s.forMinutes * MIN;
    if (rt.overSince === null || now - rt.overSince < forMs || rt.load === null) return;
    const reason = loadReason(server.name, rt.load, now - rt.overSince);
    const byCpu = (a: { row: ContainerRow }, b: { row: ContainerRow }) =>
      (b.row.cpu ?? -1) - (a.row.cpu ?? -1);
    const stopMs = s.stopAfterMinutes * MIN;
    // The first automatic throttle of this over period is due at overFrom.
    const overFrom = rt.overSince + forMs;
    // From forMinutes + stopAfterMinutes on, throttling further candidates does
    // not postpone the stop branch.
    const stopDue = now - overFrom >= stopMs;

    // Throttle: one niedrig container per forMinutes step, highest CPU first.
    if (rt.lastThrottleAt === null || now - rt.lastThrottleAt >= forMs) {
      const cand = items
        .filter(
          ({ row, e }) =>
            row.state === 'running' &&
            !e.protected &&
            e.priority === 'niedrig' &&
            rules.niedrig.kind === 'none' &&
            !(this.throttleRow(row.id)?.cpus != null),
        )
        .sort(byCpu)[0];
      if (cand) {
        await this.safe(
          'throttle',
          this.throttle(cand.row, cand.e, s.throttleCpus, 'auto', reason, 'system'),
        );
        rt.lastThrottleAt = now;
        if (!stopDue) return;
      }
    }

    // Stop: throttled niedrig containers with "darf gestoppt werden", still over after stopAfterMinutes.
    const stoppable = items
      .filter(({ row, e }) => {
        if (row.state !== 'running' || e.protected || e.priority !== 'niedrig' || !e.allowStop) {
          return false;
        }
        if (rules.niedrig.kind === 'no_throttle') return false;
        const t = this.throttleRow(row.id);
        if (!t || t.cpus === null || t.since === null || t.by === 'admin') return false;
        return now - Math.max(t.since, overFrom) >= stopMs;
      })
      .sort(byCpu);
    for (const c of stoppable) {
      if (await this.autoStop(c.row, c.e, reason)) return;
    }
  }

  /** Stops a container (games cleanly). Returns true if it was stopped. */
  private async autoStop(row: ContainerRow, e: Effective, reason: string): Promise<boolean> {
    const game = e.game;
    if (game) {
      // Unknown player count (no fresh answer) counts as "maybe online".
      const players = this.deps.games.summary(game.id)?.players?.online;
      if ((players === undefined || players > 0) && !e.allowStopWithPlayers) return false;
      const save = SAVE_COMMANDS[game.templateId];
      if (save && this.deps.games.hasRcon(game.id)) {
        try {
          await this.deps.games.rcon(game.id, save);
        } catch (err) {
          this.logErr(err, 'save before stop');
        }
      }
      try {
        await this.deps.games.action(game.id, 'stop', 'system');
      } catch (err) {
        this.logErr(err, 'game stop');
        return false;
      }
    } else {
      this.deps.containers.setIntent(row.id, 'stop');
      try {
        await this.deps.hub.call(
          row.serverId,
          'container.stop',
          { id: row.dockerId },
          { timeoutMs: STOP_TIMEOUT_MS },
        );
      } catch (err) {
        this.deps.containers.setIntent(row.id, null);
        this.logErr(err, 'container stop');
        return false;
      }
    }
    const now = this.deps.now();
    const t = this.throttleRow(row.id);
    // A game's compose down removed its container (the limit went with it); a plain
    // stopped container still has the limit: restore it before it runs again.
    if (t && t.cpus !== null) {
      await this.safe('lift', this.lift(t, 'system', game ? 'removed' : 'stopped'));
    }
    this.upsertThrottle(row, game?.id ?? null, { autoStoppedAt: now });
    writeAudit(this.deps.db, now, {
      actor: 'system',
      action: 'container.auto_stopped',
      target: row.id,
      details: {
        serverId: row.serverId,
        name: row.name,
        reason,
        ...(game ? { gameId: game.id } : {}),
      },
    });
    const text = autoStoppedText(row.name, reason, now);
    this.deps.alerts.raise(
      autoStopKey(row.serverId, row.name),
      'warn',
      text.title,
      text.body,
      row.serverId,
      game ? 'game' : 'container',
    );
    this.notify(row);
    return true;
  }

  private async restartWichtig(
    server: ServerRow,
    items: { row: ContainerRow; e: Effective }[],
    now: number,
  ): Promise<void> {
    const db = this.deps.db;
    for (const { row, e } of items) {
      if (e.priority !== 'wichtig' || e.protected) continue;
      const key = autoRestartKey(row.serverId, row.name);
      db.delete(wichtigRestarts)
        .where(
          and(
            eq(wichtigRestarts.containerId, row.id),
            lt(wichtigRestarts.ts, now - RESTART_WINDOW_MS),
          ),
        )
        .run();
      const attempts = db
        .select()
        .from(wichtigRestarts)
        .where(
          and(
            eq(wichtigRestarts.containerId, row.id),
            gte(wichtigRestarts.ts, now - RESTART_WINDOW_MS),
          ),
        )
        .all();
      const down = row.state === 'exited' || row.state === 'dead';
      if (!down) {
        // Running for a whole window after the last attempt: the episode is over.
        if (attempts.length === 0) this.deps.alerts.resolve(key);
        continue;
      }
      // Stopped on purpose through the core (stop holds until it runs again, restart/update for a while).
      if (this.deps.containers.activeIntent(row) !== null) continue;
      // Gave up (crit): no more attempts until it runs again.
      if (this.deps.alerts.active(key)?.level === 'crit') continue;
      if (e.game && (e.game.phase !== 'running' || this.deps.games.isBusy(e.game.id))) continue;
      if (attempts.length >= WICHTIG_RESTART_MAX_ATTEMPTS) {
        const t = restartFailedText(
          row.name,
          server.name,
          WICHTIG_RESTART_MAX_ATTEMPTS,
          WICHTIG_RESTART_WINDOW_MINUTES,
        );
        const r = this.deps.alerts.raise(
          key,
          'crit',
          t.title,
          t.body,
          row.serverId,
          e.game ? 'game' : 'container',
        );
        if (r.created || r.changed) {
          writeAudit(db, now, {
            actor: 'system',
            action: 'container.restart_failed',
            target: row.id,
            details: { serverId: row.serverId, name: row.name, attempts: attempts.length },
          });
        }
        continue;
      }
      const last = Math.max(0, ...attempts.map((a) => a.ts));
      if (attempts.length > 0 && now - last < RESTART_SPACING_MS) continue;
      let ok = true;
      try {
        if (e.game) await this.deps.games.action(e.game.id, 'start', 'system');
        else {
          await this.deps.hub.call(
            row.serverId,
            'container.start',
            { id: row.dockerId },
            { timeoutMs: STOP_TIMEOUT_MS },
          );
        }
      } catch (err) {
        ok = false;
        this.logErr(err, 'wichtig restart');
      }
      db.insert(wichtigRestarts)
        .values({ containerId: row.id, serverId: row.serverId, ts: now, ok })
        .run();
      const attempt = attempts.length + 1;
      writeAudit(db, now, {
        actor: 'system',
        action: 'container.auto_restarted',
        target: row.id,
        details: { serverId: row.serverId, name: row.name, attempt, ok },
      });
      if (attempt < WICHTIG_RESTART_MAX_ATTEMPTS || ok) {
        const t = autoRestartedText(
          row.name,
          server.name,
          attempt,
          WICHTIG_RESTART_MAX_ATTEMPTS,
          now,
        );
        this.deps.alerts.raise(
          key,
          'warn',
          t.title,
          t.body,
          row.serverId,
          e.game ? 'game' : 'container',
        );
      }
    }
  }
}

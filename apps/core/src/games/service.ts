import { basename } from 'node:path';
import { and, asc, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import {
  CLOUD_GAME_TEXT,
  backupDoneDataSchema,
  backupFileNameSchema,
  gameBackupsPurgeDataSchema,
  gameRestoreDoneDataSchema,
  gameStatusDataSchema,
  gameWakeArmDataSchema,
  homelabPathSchema,
  rconDataSchema,
  type ModKind,
  type ServerNetwork,
  type ContainerState,
  type GameStatusData,
  type GameSummary,
  type GameTemplate,
  type ListeningPort,
  type PortMapping,
  type RpcAction,
  type RpcParamsInput,
  type gameBackupSchema,
  type gameCreateRequestSchema,
  type gameEventSchema,
  type gameUpdateRequestSchema,
  type GamePortsUpdateResponse,
  type gameTemplateListResponseSchema,
  type InsufficientRamDetails,
  type Throttled,
} from '@hz/shared';
import {
  RpcError,
  type AgentHub,
  type RpcFailure,
  type RpcStream,
  type StreamChunk,
} from '../agents/hub.js';
import type { AlertService } from '../alerts/service.js';
import { sanitizeReason } from '../checks/service.js';
import { nextWallClock } from '../calendar.js';
import type { Clock } from '../clock.js';
import { randomToken, type SecretBox } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import {
  containers,
  deletedGameBackups,
  gameBackups,
  gameServers,
  serverState,
  servers,
  type ContainerRow,
  type GameServerRow,
  type ServerRow,
} from '../db/schema.js';
import { clockTime, duration, gigabytes } from '../format.js';
import { HttpError } from '../http/errors.js';
import type { Scheduler } from '../scheduler.js';
import {
  collectUsed,
  firstFree,
  isFree,
  markUsed,
  ramBytes,
  ramCheck,
  suggestPorts,
  suggestRconPort,
  type UsedPorts,
} from './ports.js';
import {
  renderCompose,
  renderEnv,
  validateValues,
  ValueError,
  type FieldValue,
  type HostPort,
  type ValidatedValues,
} from './render.js';
import { parseBackupResult, translateProgress, type BackupDone } from './agent-text.js';
import { gameState, type GamePhase } from './status.js';
import { serverNetworkOf } from '../servers/service.js';
import type { LoadedTemplate } from './templates.js';

export type GameCreateRequest = z.output<typeof gameCreateRequestSchema>;
export type GameUpdateRequest = z.output<typeof gameUpdateRequestSchema>;
export type GameEvent = z.infer<typeof gameEventSchema>;
export type GameBackup = z.infer<typeof gameBackupSchema>;
export type TemplateInfo = z.infer<typeof gameTemplateListResponseSchema>['templates'][number];

export const GAMES_ROOT = '/opt/homelab/games/';
export const BACKUPS_ROOT = '/opt/homelab/backups/';
export const BACKUP_KEEP = 7;
/** Backups of a deleted game server are removed this long after the deletion. */
export const DELETED_BACKUP_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
const PURGE_TIMEOUT_MS = 2 * 60_000;
/** Setup: after compose up, the game must answer within this time (core clock). */
export const SETUP_TIMEOUT_MS = 10 * 60_000;
export const SETUP_POLL_MS = 5_000;
export const STATUS_POLL_MS = 30_000;
export const AUTOSTOP_CHECK_MS = 60_000;
/** RCON: at most this many commands per window and game. */
export const RCON_LIMIT = 10;
export const RCON_WINDOW_MS = 10_000;

const WRITE_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 15 * 60_000;
const UP_TIMEOUT_MS = 10 * 60_000;
const DOWN_TIMEOUT_MS = 5 * 60_000;
const ACTION_TIMEOUT_MS = 2 * 60_000;
const STATUS_TIMEOUT_MS = 15_000;
const RCON_TIMEOUT_MS = 15_000;
/** Agent allows 2 h (game-backup.ts); the core waits longer so the agent's timeout reports. */
export const BACKUP_TIMEOUT_MS = 2 * 60 * 60_000 + 5 * 60_000;
const REMOVE_TIMEOUT_MS = 5 * 60_000;
const INTENT_TTL_MS = 5 * 60_000;
const EVENT_BUFFER = 200;
const EVENT_MAX_CHARS = 16 * 1024;
const RESTART_REASON = 'Zentrale neu gestartet';
/** M12 sleep mode: MOTD in the Minecraft server list (charset of game.wake.arm). */
export const SLEEP_MOTD = 'Schläft – zum Aufwecken verbinden';
export const SLEEP_TEXT = 'Schläft';
/** A wake that did not fit into RAM: the listeners are armed again after this. */
export const WAKE_RETRY_MS = 60_000;
const WAKE_TIMEOUT_MS = 15_000;
/** game.restore: the agent extracts large worlds; generous like a backup. */
const RESTORE_TIMEOUT_MS = 2 * 60 * 60_000 + 5 * 60_000;
/** game.backup not_found: the template has no ./data (CS2) or the folder is gone. */
export const NOTHING_TO_BACK_UP = 'Keine Weltdaten zum Sichern';

const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/;

const STATUS_ORDER: Record<GameSummary['status'], number> = {
  crit: 0,
  warn: 1,
  busy: 2,
  off: 3,
  ok: 4,
};

/** /opt/homelab/games/<name>; the name is checked again so nothing else can ever be built. */
export function gameDirOf(name: string): string {
  if (!NAME_RE.test(name)) throw new HttpError(400, 'invalid_input');
  const dir = `${GAMES_ROOT}${name}`;
  if (!homelabPathSchema.safeParse(dir).success) throw new HttpError(400, 'invalid_input');
  return dir;
}

/** '' or a host name / IPv4 address (no port, no scheme). */
export function validExternalAddress(a: string): boolean {
  return a === '' || HOSTNAME_RE.test(a);
}

function parse<T>(json: string | null): T | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** German reason for a failed agent call. Agent text is sanitized and stripped of secrets. */
export function rpcReason(err: unknown, what: string, secrets: readonly string[] = []): string {
  if (!(err instanceof RpcError)) return `${what} fehlgeschlagen`;
  switch (err.code) {
    case 'offline':
      return 'Agent offline';
    case 'disconnected':
      return 'Verbindung zum Agent verloren';
    case 'timeout':
      return `${what}: Zeitüberschreitung`;
    case 'not_allowed':
      return 'Vom Agent abgelehnt (Agent aktualisieren)';
    case 'invalid_params':
      return 'Vom Agent abgelehnt (ungültige Parameter)';
    case 'bad_path':
      return 'Pfad vom Agent abgelehnt';
    case 'busy':
      return 'Ordner ist gerade gesperrt';
    default: {
      const detail = sanitizeReason(scrub(err.detail, secrets));
      return detail ? `${what} fehlgeschlagen: ${detail}` : `${what} fehlgeschlagen`;
    }
  }
}

/** Replaces every secret in agent output (defense in depth: output is shown and stored). */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('***');
  return out;
}

interface Stored {
  ports: HostPort[];
  values: Record<string, FieldValue>;
}

function storedOf(row: GameServerRow): Stored {
  return {
    ports: parse<HostPort[]>(row.portsJson) ?? [],
    values: parse<Record<string, FieldValue>>(row.settingsJson) ?? {},
  };
}

export interface GamePublisher {
  append(topic: string, items: GameEvent[]): void;
}

export type GameListener = (id: string, deleted: boolean) => void;

/** M12 lifecycle events (Discord): online after a start, offline, asleep, woken. */
export type GameLifecycleEvent = 'online' | 'offline' | 'sleep' | 'wake';
export type GameLifecycleListener = (id: string, event: GameLifecycleEvent) => void;
/**
 * M12 statistics: called after each status poll of a game (`status` null when the
 * game does not run or does not answer, then open sessions end).
 */
export type GameStatusListener = (row: GameServerRow, status: GameStatusData | null) => void;

/** Docker arch name of a server (hello.arch is Node's process.arch), null if unknown. */
export function dockerArch(arch: string | null): 'amd64' | 'arm64' | null {
  if (arch === null) return null;
  const a = arch.toLowerCase();
  if (a === 'x64' || a === 'amd64' || a === 'x86_64') return 'amd64';
  if (a === 'arm64' || a === 'aarch64') return 'arm64';
  return null;
}

/** Mods/plugins kind of a game: template.mods and the server type value (Paper / Fabric). */
export function modsKindOf(
  t: GameTemplate | undefined,
  values: Record<string, unknown>,
): ModKind | null {
  if (!t?.mods) return null;
  const v = values[t.mods.typeField];
  if (typeof v !== 'string') return null;
  if (t.mods.plugins.includes(v)) return 'plugins';
  if (t.mods.mods.includes(v)) return 'mods';
  return null;
}

/** Wake listener ports: public host ports of the game that the wake mode can serve (max 4). */
export function wakePorts(
  mode: 'minecraft' | 'minecraft-bedrock' | 'raw',
  ports: readonly HostPort[],
): { port: number; protocol: 'tcp' | 'udp' }[] {
  const want = mode === 'minecraft' ? 'tcp' : mode === 'minecraft-bedrock' ? 'udp' : null;
  return publicGamePorts(ports)
    .filter((p) => want === null || p.proto === want)
    .slice(0, 4)
    .map((p) => ({ port: p.port, protocol: p.proto }));
}

export interface GameServiceDeps {
  db: Db;
  box: SecretBox;
  now: Clock;
  hub: Pick<AgentHub, 'call' | 'stream' | 'isConnected'>;
  alerts: AlertService;
  setIntent: (containerId: string, intent: 'stop' | 'restart' | null, ttlMs?: number) => void;
  scheduler: Scheduler;
  log: FastifyBaseLogger;
  templates: Map<string, LoadedTemplate>;
}

const TOPIC_RE = /^game:([A-Za-z0-9_-]{1,64})$/;
export const gameTopic = (id: string): string => `game:${id}`;

/**
 * M11 port audit hook: public game ports the hub opens go into the server's
 * allowed list (note `game:<name>`), so the audit does not flag them.
 */
export interface GamePortAudit {
  syncGame(
    serverId: string,
    gameName: string,
    ports: { port: number; proto: 'tcp' | 'udp' }[],
  ): void;
  releaseGame(serverId: string, gameName: string): void;
}

/** Public host ports of a game, one entry per (proto, port); local ones are skipped. */
export function publicGamePorts(
  ports: readonly HostPort[],
): { port: number; proto: 'tcp' | 'udp' }[] {
  const out: { port: number; proto: 'tcp' | 'udp' }[] = [];
  for (const p of ports) {
    if (p.local) continue;
    const protos: ('tcp' | 'udp')[] = p.protocol === 'tcp+udp' ? ['tcp', 'udp'] : [p.protocol];
    for (let i = 0; i < p.count; i++) {
      for (const proto of protos) out.push({ port: p.port + i, proto });
    }
  }
  return out;
}

/**
 * Result of the RAM reserve check before a game start: `fits`, `unknown` (no
 * fresh metrics, the caller decides) or `insufficient` with the numbers.
 */
export type RamCheckResult =
  | { kind: 'fits' }
  | { kind: 'unknown' }
  | { kind: 'insufficient'; details: InsufficientRamDetails };

/**
 * M10 hooks from the throttle service: throttle state of a game's container and
 * the RAM reserve check before a game starts.
 */
export interface GameControl {
  throttleOf(gameId: string): { throttled: Throttled | null; autoStopped: boolean };
  /** Free RAM minus reserve minus RAM held by starts in flight vs. `neededBytes`. */
  ramCheck(
    serverId: string,
    neededBytes: number,
    ownContainerIds: readonly string[],
  ): RamCheckResult;
  /** Holds RAM for a start in flight until the returned release function runs. */
  holdRam(serverId: string, bytes: number): () => void;
  /** Effective reserve in bytes, null while RAM is unknown. */
  reserveOf(serverId: string, ownContainerIds: readonly string[]): number | null;
}

/**
 * M22 hook of the cloud module: a game on a cloud VM that is asleep (deallocated)
 * starts the VM first. The game service knows nothing about Azure.
 */
export interface GameCloudHost {
  /**
   * Before a start on `serverId`: `ready` (no cloud server, or its VM runs), `wake`
   * (the VM must be started or is starting) or `over_budget` (the budget is used up and
   * the VM would have to be started; refused for every caller, the admin starts the
   * machine with overBudget on the cloud page).
   */
  startGate(serverId: string): 'ready' | 'wake' | 'over_budget';
  /** Starts the VM if needed; resolves true once its agent is back with fresh metrics. */
  ensureRunning(serverId: string, actor: string): Promise<boolean>;
  /** Status text for games on a sleeping VM (CLOUD_GAME_TEXT.deallocated), else null. */
  statusText(serverId: string): string | null;
}

type BackupOutcome = { ok: true; backup: GameBackup } | { ok: false; reason: string; code: string };

/**
 * Game servers: create from a template (render, compose.write/pull/up, wait for
 * online), poll status, actions, RCON, backups, settings, delete, auto-stop.
 */
export class GameService {
  readonly templates: Map<string, LoadedTemplate>;
  private readonly busy = new Map<string, string>();
  /** Games waiting to come online after setup: start of waiting (core clock). */
  private readonly waiting = new Map<string, number>();
  private readonly events = new Map<string, GameEvent[]>();
  private readonly seq = new Map<string, number>();
  private readonly lastSummary = new Map<string, { json: string; serverId: string }>();
  private readonly rconHits = new Map<string, number[]>();
  private readonly listeners = new Set<GameListener>();
  private readonly background = new Set<Promise<unknown>>();
  private publisher: GamePublisher | null = null;
  private refreshQueued = false;
  private control: GameControl | null = null;
  private portAudit: GamePortAudit | null = null;
  private cloudHost: GameCloudHost | null = null;
  /** Games whose start waits for their cloud VM (busy text CLOUD_GAME_TEXT.starting). */
  private readonly cloudWaiting = new Set<string>();
  private readonly lifecycle = new Set<GameLifecycleListener>();
  private readonly statusListeners = new Set<GameStatusListener>();
  /** Games that announce `online` when they are next seen ok (after a start). */
  private readonly pendingOnline = new Set<string>();
  /** Sleeping games whose listeners are re-armed at this time (wake refused by RAM). */
  private readonly rearmAt = new Map<string, number>();

  constructor(private readonly deps: GameServiceDeps) {
    this.templates = deps.templates;
  }

  /** Module switch (settings/modules): off pauses setup/status/auto-stop/purge jobs. */
  private active = true;

  setEnabled(on: boolean): void {
    this.active = on;
  }

  get enabled(): boolean {
    return this.active;
  }

  setPublisher(p: GamePublisher): void {
    this.publisher = p;
  }

  setControl(c: GameControl): void {
    this.control = c;
  }

  setPortAudit(p: GamePortAudit): void {
    this.portAudit = p;
  }

  setCloudHost(h: GameCloudHost | null): void {
    this.cloudHost = h;
  }

  /** Allowed-list bookkeeping must never break a game action. */
  private syncPorts(serverId: string, name: string, ports: readonly HostPort[]): void {
    try {
      this.portAudit?.syncGame(serverId, name, publicGamePorts(ports));
    } catch (err) {
      this.deps.log.error(
        { err: err instanceof Error ? err.name : 'error' },
        'port list sync failed',
      );
    }
  }

  private releasePorts(serverId: string, name: string): void {
    try {
      this.portAudit?.releaseGame(serverId, name);
    } catch (err) {
      this.deps.log.error(
        { err: err instanceof Error ? err.name : 'error' },
        'port list release failed',
      );
    }
  }

  onLifecycle(fn: GameLifecycleListener): () => void {
    this.lifecycle.add(fn);
    return () => this.lifecycle.delete(fn);
  }

  onStatus(fn: GameStatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private announce(id: string, event: GameLifecycleEvent): void {
    for (const fn of this.lifecycle) {
      try {
        fn(id, event);
      } catch (err) {
        this.logError(err, 'game lifecycle hook failed');
      }
    }
  }

  private reportStatus(row: GameServerRow, status: GameStatusData | null): void {
    for (const fn of this.statusListeners) {
      try {
        fn(row, status);
      } catch (err) {
        this.logError(err, 'game status hook failed');
      }
    }
  }

  onChange(fn: GameListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(id: string, deleted = false): void {
    if (deleted) this.lastSummary.delete(id);
    else {
      const s = this.summary(id);
      if (s) this.lastSummary.set(id, { json: JSON.stringify(s), serverId: s.serverId });
    }
    for (const fn of this.listeners) fn(id, deleted);
  }

  /** Emits only games whose summary changed (polling, container and server changes). */
  refreshAll(serverId?: string): void {
    const rows = this.deps.db
      .select({ id: gameServers.id })
      .from(gameServers)
      .where(serverId === undefined ? undefined : eq(gameServers.serverId, serverId))
      .all();
    for (const { id } of rows) {
      const s = this.summary(id);
      if (!s) continue;
      const json = JSON.stringify(s);
      if (this.lastSummary.get(id)?.json === json) continue;
      this.lastSummary.set(id, { json, serverId: s.serverId });
      for (const fn of this.listeners) fn(id, false);
    }
  }

  /** Coalesces many container changes (one inventory) into one refresh. */
  queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    setImmediate(() => {
      this.refreshQueued = false;
      try {
        this.refreshAll();
      } catch (err) {
        this.logError(err, 'game refresh failed');
      }
    });
  }

  /** A server was deleted: its games went with ON DELETE CASCADE. */
  forgetServer(serverId: string): void {
    for (const [id, s] of [...this.lastSummary]) {
      if (s.serverId !== serverId) continue;
      this.cleanup(id);
      this.emit(id, true);
    }
  }

  start(): void {
    this.recoverAfterRestart();
    const s = this.deps.scheduler;
    s.every('games.setup', SETUP_POLL_MS, () => this.setupTick());
    s.every('games.status', STATUS_POLL_MS, () => this.statusTick());
    s.every('games.autostop', AUTOSTOP_CHECK_MS, () => this.autoStopTick());
    s.at(
      'games.purgeDeletedBackups',
      (from) => nextWallClock(from, { hour: 5, minute: 0 }),
      () => this.purgeDeletedBackups(),
    );
    for (const r of this.rows()) {
      const sum = this.summary(r.id);
      if (sum) this.lastSummary.set(r.id, { json: JSON.stringify(sum), serverId: sum.serverId });
    }
  }

  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  private track<T>(p: Promise<T>): void {
    const tracked = p.catch((err: unknown) => this.logError(err, 'game task failed'));
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  private logError(err: unknown, msg: string): void {
    this.deps.log.error(
      { err: err instanceof Error ? { name: err.name, stack: err.stack } : 'error' },
      msg,
    );
  }

  /** Setups interrupted by a restart are failed (the steps cannot be resumed). */
  private recoverAfterRestart(): void {
    const now = this.deps.now();
    for (const row of this.rows().filter((r) => r.phase === 'setup')) {
      this.setPhase(row.id, 'failed', RESTART_REASON);
      writeAudit(this.deps.db, now, {
        actor: 'system',
        action: 'game.setup_failed',
        target: row.id,
        details: { name: row.name, reason: RESTART_REASON },
      });
      this.raiseFailure(row, RESTART_REASON);
    }
  }

  // ---- reads -------------------------------------------------------------------

  /** An action (start, stop, backup, ...) is running for this game. */
  isBusy(id: string): boolean {
    return this.busy.has(id);
  }

  row(id: string): GameServerRow | undefined {
    return this.deps.db.select().from(gameServers).where(eq(gameServers.id, id)).get();
  }

  private rows(): GameServerRow[] {
    return this.deps.db.select().from(gameServers).all();
  }

  private serverRow(id: string): ServerRow | undefined {
    return this.deps.db.select().from(servers).where(eq(servers.id, id)).get();
  }

  /** M12: network of a server (home / cloud / vps / other), for the forwarding hint. */
  networkOf(serverId: string): ServerNetwork | null {
    return serverNetworkOf(this.serverRow(serverId)?.network ?? null);
  }

  templateList(): TemplateInfo[] {
    return [...this.templates.values()].map(({ template: t }) => ({
      id: t.id,
      name: t.name,
      image: t.image,
      ram: t.ram,
      ports: t.ports.map((p) => ({
        name: p.name,
        protocol: p.protocol,
        default: p.default,
        count: p.count,
        local: p.local,
      })),
      rcon: t.rcon.supported,
      fields: t.fields,
      wake: t.wake !== 'none',
      mods: t.mods !== undefined,
      arch: t.arch,
    }));
  }

  /**
   * M12: refuses a server whose CPU architecture the template's image does not
   * support (400 "Läuft nicht auf arm64"). Unknown architecture is allowed.
   */
  checkArch(templateId: string, serverId: string): void {
    const t = this.templates.get(templateId)?.template;
    const arch = dockerArch(this.serverRow(serverId)?.arch ?? null);
    if (!t || arch === null || t.arch.includes(arch)) return;
    throw new HttpError(400, 'invalid_input', undefined, `Läuft nicht auf ${arch}`);
  }

  /**
   * The game's container: label homelab.game = <name> first (M12); containers
   * without the label by compose project in its folder or container_name
   * game-<name>. A container labelled for another game never matches.
   */
  private containerOf(row: GameServerRow): ContainerRow | undefined {
    const list = this.deps.db
      .select()
      .from(containers)
      .where(gameContainerWhere(row.serverId, row.name))
      .all();
    return list.find((c) => c.state === 'running') ?? list[0];
  }

  private containerIds(row: GameServerRow): string[] {
    return this.deps.db
      .select({ id: containers.id })
      .from(containers)
      .where(gameContainerWhere(row.serverId, row.name))
      .all()
      .map((r) => r.id);
  }

  private lastBackupAt(gameId: string): number | null {
    return (
      this.deps.db
        .select({ createdAt: gameBackups.createdAt })
        .from(gameBackups)
        .where(eq(gameBackups.gameId, gameId))
        .orderBy(desc(gameBackups.createdAt))
        .limit(1)
        .get()?.createdAt ?? null
    );
  }

  toSummary(row: GameServerRow, server: ServerRow | undefined): GameSummary {
    const tpl = this.templates.get(row.templateId)?.template;
    const { ports, values } = storedOf(row);
    const c = this.containerOf(row);
    const status = parse<GameStatusData>(row.statusJson);
    const state = gameState({
      phase: row.phase as GamePhase,
      phaseText: row.phaseText,
      busyText: this.busy.get(row.id) ?? null,
      connected: this.deps.hub.isConnected(row.serverId),
      container: c
        ? { state: c.state as ContainerState, exitCode: c.exitCode, startedAt: c.startedAt }
        : null,
      status,
      statusAt: row.statusAt,
      noQuery: tpl?.query.method === 'none',
      now: this.deps.now(),
    });
    const host = row.externalAddress || server?.tailscaleIp || server?.name || row.serverId;
    // Local ports (127.0.0.1 only) are neither in the address nor in the forwarding hint.
    const tplPorts = new Map((tpl?.ports ?? []).map((p) => [p.name, p]));
    const isLocal = (p: HostPort): boolean => p.local ?? tplPorts.get(p.name)?.local ?? false;
    const publicPorts = ports.filter((p) => !isLocal(p));
    const main = publicPorts[0];
    const mem = values.MEMORY;
    const memMatch = typeof mem === 'string' ? /^(\d{1,3})([GM])$/.exec(mem) : null;
    const lastBackup = this.lastBackupAt(row.id);
    const running = c?.state === 'running';
    const sleeping = row.sleeping && row.phase === 'stopped' && !running;
    // Asleep is shown as such, also while the agent is away (it re-arms on hello).
    const cloudText =
      state.status === 'off' ? (this.cloudHost?.statusText(row.serverId) ?? null) : null;
    const statusText =
      cloudText ?? (sleeping && state.status === 'off' ? SLEEP_TEXT : state.statusText);
    return {
      id: row.id,
      name: row.name,
      templateId: row.templateId,
      game: tpl?.name ?? row.templateId,
      version: status?.version ?? null,
      serverId: row.serverId,
      serverName: server?.name ?? row.serverId,
      address: main ? `${host}:${main.port}` : host,
      ports: publicPorts.map((p) => ({ name: p.name, port: p.port, protocol: p.protocol })),
      status: state.status,
      statusText,
      players: state.live && status?.players ? status.players : null,
      tps: state.live ? (status?.tps ?? null) : null,
      ramBytes: running ? (c.memBytes ?? null) : null,
      ramLimitBytes: memMatch
        ? Number(memMatch[1]) * (memMatch[2] === 'G' ? 1024 ** 3 : 1024 ** 2)
        : null,
      rcon: tpl?.rcon.supported ?? row.rconSecretEnc !== null,
      autoStopMinutes: row.autoStopMinutes,
      wakeOnConnect: row.wakeOnConnect && tpl !== undefined && tpl.wake !== 'none',
      sleeping,
      modsKind: modsKindOf(tpl, values),
      externalAddress: row.externalAddress,
      values,
      lastBackupAt: lastBackup === null ? null : iso(lastBackup),
      createdAt: iso(row.createdAt),
      priority: row.priority as GameSummary['priority'],
      allowStop: row.allowStop,
      allowStopWithPlayers: row.allowStopWithPlayers,
      ...(this.control?.throttleOf(row.id) ?? { throttled: null, autoStopped: false }),
    };
  }

  summary(id: string): GameSummary | null {
    const row = this.row(id);
    return row ? this.toSummary(row, this.serverRow(row.serverId)) : null;
  }

  /** Problems first (crit, warn, busy, off, ok), then by name. */
  list(): GameSummary[] {
    const serverRows = new Map(
      this.deps.db
        .select()
        .from(servers)
        .all()
        .map((s) => [s.id, s]),
    );
    return this.rows()
      .map((r) => this.toSummary(r, serverRows.get(r.serverId)))
      .sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
      );
  }

  backups(gameId: string): GameBackup[] {
    return this.deps.db
      .select()
      .from(gameBackups)
      .where(eq(gameBackups.gameId, gameId))
      .orderBy(desc(gameBackups.createdAt))
      .all()
      .map((b) => ({
        id: b.id,
        fileName: basename(b.path),
        sizeBytes: b.size,
        createdAt: iso(b.createdAt),
      }));
  }

  // ---- live topic game:<id> ------------------------------------------------------

  matches(topic: string): boolean {
    return TOPIC_RE.test(topic);
  }

  has(topic: string): boolean {
    const id = TOPIC_RE.exec(topic)?.[1];
    return id !== undefined && this.row(id) !== undefined;
  }

  snapshot(topic: string): GameEvent[] | undefined {
    const id = TOPIC_RE.exec(topic)?.[1];
    if (id === undefined || !this.row(id)) return undefined;
    return [...(this.events.get(id) ?? [])];
  }

  /** Events of a game (tests, diagnostics). */
  eventsOf(id: string): GameEvent[] {
    return [...(this.events.get(id) ?? [])];
  }

  private event(id: string, kind: GameEvent['kind'], text: string): void {
    if (text === '') return;
    const list = this.events.get(id) ?? [];
    const out: GameEvent[] = [];
    for (let i = 0; i < text.length; i += EVENT_MAX_CHARS) {
      const n = this.seq.get(id) ?? 0;
      this.seq.set(id, n + 1);
      out.push({
        id: String(n),
        kind,
        text: text.slice(i, i + EVENT_MAX_CHARS),
        ts: iso(this.deps.now()),
      });
    }
    list.push(...out);
    while (list.length > EVENT_BUFFER) list.shift();
    this.events.set(id, list);
    this.publisher?.append(gameTopic(id), out);
  }

  private cleanup(id: string): void {
    this.pendingOnline.delete(id);
    this.rearmAt.delete(id);
    this.busy.delete(id);
    this.waiting.delete(id);
    this.events.delete(id);
    this.seq.delete(id);
    this.rconHits.delete(id);
  }

  // ---- secrets -------------------------------------------------------------------

  private rconPassword(row: GameServerRow): string | null {
    return row.rconSecretEnc === null
      ? null
      : this.deps.box.decrypt(row.rconSecretEnc, `game_servers.rcon:${row.id}`);
  }

  private secretValues(row: GameServerRow): Record<string, string> {
    if (row.secretValuesEnc === null) return {};
    return (
      parse<Record<string, string>>(
        this.deps.box.decrypt(row.secretValuesEnc, `game_servers.secrets:${row.id}`),
      ) ?? {}
    );
  }

  private secretsOf(row: GameServerRow): string[] {
    const pw = this.rconPassword(row);
    return [...(pw ? [pw] : []), ...Object.values(this.secretValues(row))];
  }

  // ---- suggestion ------------------------------------------------------------------

  private usedPorts(serverId: string, exceptGameId?: string): UsedPorts {
    const st = this.deps.db
      .select({ listening: serverState.listeningPortsJson })
      .from(serverState)
      .where(eq(serverState.serverId, serverId))
      .get();
    const containerPorts = this.deps.db
      .select({ ports: containers.portsJson })
      .from(containers)
      .where(eq(containers.serverId, serverId))
      .all()
      .flatMap((r) => parse<PortMapping[]>(r.ports) ?? []);
    const games = this.deps.db
      .select()
      .from(gameServers)
      .where(eq(gameServers.serverId, serverId))
      .all()
      .filter((g) => g.id !== exceptGameId)
      .map((g) => ({ ports: storedOf(g).ports, rconPort: g.rconPort }));
    return collectUsed({
      listening: parse<ListeningPort[]>(st?.listening ?? null) ?? [],
      containerPorts,
      games,
    });
  }

  private freeRam(serverId: string): { usedBytes: number; totalBytes: number } | null {
    const st = this.deps.db
      .select({ m: serverState.metricsJson })
      .from(serverState)
      .where(eq(serverState.serverId, serverId))
      .get();
    return parse<{ ram: { usedBytes: number; totalBytes: number } }>(st?.m ?? null)?.ram ?? null;
  }

  suggest(templateId: string, serverId: string) {
    const l = this.templates.get(templateId);
    if (!l || !this.serverRow(serverId)) throw new HttpError(404, 'not_found');
    const used = this.usedPorts(serverId);
    const ram = this.freeRam(serverId);
    const reserve = ram ? (this.control?.reserveOf(serverId, []) ?? 0) : null;
    // The reserve for wichtig containers counts as used for the warning.
    const check = ramCheck(
      ram && reserve !== null ? { ...ram, usedBytes: ram.usedBytes + reserve } : ram,
      l.template.ram.recommended,
    );
    return {
      ports: suggestPorts(l.template, used),
      ...check,
      freeRamBytes: ram ? Math.max(0, ram.totalBytes - ram.usedBytes) : null,
      ramReserveBytes: reserve,
    };
  }

  // ---- create ----------------------------------------------------------------------

  private resolvePorts(
    t: GameTemplate,
    serverId: string,
    requested: Record<string, number> | undefined,
  ): { ports: HostPort[]; rconPort: number | null } {
    return this.resolvePortsOn(t, this.usedPorts(serverId), requested);
  }

  private resolvePortsOn(
    t: GameTemplate,
    used: UsedPorts,
    requested: Record<string, number> | undefined,
  ): { ports: HostPort[]; rconPort: number | null } {
    const names = new Set(t.ports.map((p) => p.name));
    for (const k of Object.keys(requested ?? {})) {
      if (!names.has(k)) throw new HttpError(400, 'invalid_input');
    }
    const own: UsedPorts = { tcp: new Set(), udp: new Set() };
    const ports: HostPort[] = [];
    for (const p of t.ports) {
      const want = requested?.[p.name];
      let port: number;
      if (want !== undefined) {
        const hp = { port: want, protocol: p.protocol, count: p.count };
        if (want + p.count - 1 > 65535) throw new HttpError(400, 'invalid_input');
        if (!isFree(own, hp)) throw new HttpError(400, 'invalid_input');
        if (!isFree(used, hp)) throw new HttpError(409, 'conflict');
        port = want;
      } else {
        const s = suggestPorts({ ...t, ports: [p] }, mergeUsed(used, own))[p.name];
        if (s === undefined) throw new HttpError(409, 'conflict');
        port = s;
      }
      markUsed(own, { port, protocol: p.protocol, count: p.count });
      ports.push({ name: p.name, port, protocol: p.protocol, count: p.count, local: p.local });
    }
    const rconPort = suggestRconPort(t, mergeUsed(used, own));
    if (t.rcon.supported && rconPort === null) throw new HttpError(409, 'conflict');
    return { ports, rconPort };
  }

  private validate(t: GameTemplate, input: Record<string, unknown>, prev?: ValidatedValues) {
    try {
      return validateValues(t, input, prev);
    } catch (err) {
      if (err instanceof ValueError) {
        throw new HttpError(400, 'invalid_input', undefined, err.userMessage);
      }
      throw err;
    }
  }

  private render(l: LoadedTemplate, input: Parameters<typeof renderCompose>[1]) {
    try {
      return { compose: renderCompose(l, input), env: renderEnv(l, input) };
    } catch (err) {
      if (err instanceof ValueError) throw new HttpError(400, 'invalid_input');
      throw err;
    }
  }

  /** Validates, stores the game (phase setup) and starts the setup in the background. */
  create(req: GameCreateRequest): GameSummary {
    const l = this.templates.get(req.templateId);
    const server = this.serverRow(req.serverId);
    if (!l || !server) throw new HttpError(400, 'invalid_input');
    const t = l.template;
    const dir = gameDirOf(req.name);
    if (!validExternalAddress(req.externalAddress)) throw new HttpError(400, 'invalid_input');
    const values = this.validate(t, req.values);
    const taken = this.deps.db
      .select({ id: gameServers.id })
      .from(gameServers)
      .where(and(eq(gameServers.serverId, server.id), eq(gameServers.name, req.name)))
      .get();
    // A foreign compose project in the same folder would be overwritten.
    const foreign = this.deps.db
      .select({ id: containers.id })
      .from(containers)
      .where(gameContainerWhere(server.id, req.name, true))
      .get();
    if (taken || foreign) throw new HttpError(409, 'conflict');
    this.checkArch(t.id, server.id);
    if (!this.deps.hub.isConnected(server.id)) throw new HttpError(409, 'agent_offline');
    const { ports, rconPort } = this.resolvePorts(t, server.id, req.ports);
    const rconPassword = t.rcon.supported ? randomToken(24) : null;
    const files = this.render(l, { name: req.name, ports, rconPort, values, rconPassword });
    // The setup ends with compose up: the RAM reserve applies (held until it returns).
    const release = this.admitStart(server.id, this.ramLimitFor(t.id, values.values), [], 'admin');

    const id = randomToken(12);
    const now = this.deps.now();
    const box = this.deps.box;
    try {
      this.deps.db
        .insert(gameServers)
        .values({
          id,
          serverId: server.id,
          templateId: t.id,
          name: req.name,
          settingsJson: JSON.stringify(values.values),
          portsJson: JSON.stringify(ports),
          rconPort,
          rconSecretEnc:
            rconPassword === null ? null : box.encrypt(rconPassword, `game_servers.rcon:${id}`),
          secretValuesEnc:
            Object.keys(values.secrets).length === 0
              ? null
              : box.encrypt(JSON.stringify(values.secrets), `game_servers.secrets:${id}`),
          externalAddress: req.externalAddress,
          autoStopMinutes: req.autoStopMinutes,
          wakeOnConnect: req.wakeOnConnect,
          sleeping: false,
          modsRestartNeeded: false,
          phase: 'setup',
          phaseText: 'Wird vorbereitet',
          statusJson: null,
          statusAt: null,
          emptySince: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch {
      release();
      throw new HttpError(409, 'conflict');
    }
    this.syncPorts(server.id, req.name, ports);
    this.emit(id);
    const secrets = [...(rconPassword ? [rconPassword] : []), ...Object.values(values.secrets)];
    this.track(this.runSetup(id, server.id, dir, files, secrets).finally(release));
    const sum = this.summary(id);
    if (!sum) throw new Error('game vanished');
    return sum;
  }

  private step(id: string, text: string): void {
    this.deps.db
      .update(gameServers)
      .set({ phaseText: text, updatedAt: this.deps.now() })
      .where(eq(gameServers.id, id))
      .run();
    this.event(id, 'progress', text);
    this.emit(id);
  }

  private async runSetup(
    id: string,
    serverId: string,
    dir: string,
    files: { compose: string; env: string },
    secrets: string[],
  ): Promise<void> {
    const hub = this.deps.hub;
    let what = 'Dateien schreiben';
    try {
      this.step(id, 'Dateien werden geschrieben');
      await hub.call(
        serverId,
        'compose.write',
        { dir, files: { 'compose.yml': files.compose, '.env': files.env } },
        { timeoutMs: WRITE_TIMEOUT_MS },
      );
      if (!this.row(id)) return;
      what = 'Image laden';
      this.step(id, 'Image wird geladen');
      await hub.call(serverId, 'compose.pull', { dir }, { timeoutMs: PULL_TIMEOUT_MS });
      if (!this.row(id)) return;
      what = 'Container starten';
      this.step(id, 'Container wird gestartet');
      await hub.call(serverId, 'compose.up', { dir }, { timeoutMs: UP_TIMEOUT_MS });
      if (!this.row(id)) return;
      this.step(id, 'Welt wird erzeugt');
      this.waiting.set(id, this.deps.now());
    } catch (err) {
      this.failSetup(id, rpcReason(err, what, secrets));
    }
  }

  private setPhase(id: string, phase: GamePhase, phaseText: string | null): void {
    this.deps.db
      .update(gameServers)
      .set({ phase, phaseText, updatedAt: this.deps.now() })
      .where(eq(gameServers.id, id))
      .run();
  }

  private raiseFailure(row: GameServerRow, reason: string): void {
    this.deps.alerts.raise(
      `game:${row.id}:setup`,
      'crit',
      `Gameserver ${row.name} konnte nicht aufgesetzt werden`,
      `${reason} (${clockTime(this.deps.now())}).`,
      row.serverId,
      'game',
    );
  }

  private failSetup(id: string, reason: string): void {
    const row = this.row(id);
    this.waiting.delete(id);
    if (!row || row.phase !== 'setup') return;
    this.setPhase(id, 'failed', reason);
    this.event(id, 'error', `Aufsetzen fehlgeschlagen: ${reason}`);
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'system',
      action: 'game.setup_failed',
      target: id,
      details: { name: row.name, reason },
    });
    this.raiseFailure(row, reason);
    this.deps.log.info({ gameId: id }, 'game setup failed');
    this.emit(id);
  }

  private ready(id: string, status: GameStatusData | null): void {
    const row = this.row(id);
    this.waiting.delete(id);
    if (!row) return;
    const now = this.deps.now();
    this.deps.db
      .update(gameServers)
      .set({
        phase: 'running',
        phaseText: null,
        statusJson: status ? JSON.stringify(status) : null,
        statusAt: status ? now : null,
        emptySince: status?.online && status.players?.online === 0 ? now : null,
        updatedAt: now,
      })
      .where(eq(gameServers.id, id))
      .run();
    this.event(id, 'ready', 'bereit');
    const sum = this.summary(id);
    const title = `Gameserver ${row.name} ist bereit`;
    const body = `${sum?.game ?? row.templateId} auf ${sum?.serverName ?? row.serverId} läuft seit ${clockTime(now)} unter ${sum?.address ?? ''}.`;
    const failedKey = `game:${id}:setup`;
    if (this.deps.alerts.active(failedKey)) this.deps.alerts.resolve(failedKey, { title, body });
    else this.deps.alerts.log(`game:${id}:ready`, 'info', title, body, row.serverId, 'game');
    writeAudit(this.deps.db, now, {
      actor: 'system',
      action: 'game.ready',
      target: id,
      details: { name: row.name },
    });
    this.emit(id);
    this.announce(id, 'online');
  }

  // ---- polling -----------------------------------------------------------------------

  /** game.status of one game; null for templates without a query method. */
  private async queryStatus(row: GameServerRow): Promise<GameStatusData | null> {
    const t = this.templates.get(row.templateId)?.template;
    if (!t || t.query.method === 'none') return null;
    const port = storedOf(row).ports.find((p) => p.name === t.query.port);
    if (!port) return null;
    const params: RpcParamsInput<'game.status'> = {
      gameDir: gameDirOf(row.name),
      method: t.query.method,
      port: port.port,
      timeoutMs: 5000,
      ...(t.query.method === 'gamedig' && t.query.type ? { gamedigType: t.query.type } : {}),
      ...(t.rcon.supported && t.rcon.tpsCommand === 'tps' ? { tpsCommand: 'tps' as const } : {}),
    };
    const data = await this.deps.hub.call(row.serverId, 'game.status', params, {
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    const parsed = gameStatusDataSchema.safeParse(data);
    if (!parsed.success) throw new RpcError('failed', 'invalid status data');
    return parsed.data;
  }

  /** Every 5 s: games that wait for their first answer after setup. */
  async setupTick(): Promise<void> {
    if (!this.active) return;
    const now = this.deps.now();
    await Promise.all(
      [...this.waiting].map(async ([id, since]) => {
        const row = this.row(id);
        if (!row || row.phase !== 'setup') {
          this.waiting.delete(id);
          return;
        }
        if (now - since > SETUP_TIMEOUT_MS) {
          this.failSetup(id, `nach ${duration(SETUP_TIMEOUT_MS)} nicht bereit`);
          return;
        }
        if (!this.deps.hub.isConnected(row.serverId)) return;
        const t = this.templates.get(row.templateId)?.template;
        if (!t || t.query.method === 'none') {
          if (this.containerOf(row)?.state === 'running') this.ready(id, null);
          return;
        }
        try {
          const st = await this.queryStatus(row);
          if (st?.online) this.ready(id, st);
        } catch {
          // Not up yet; the next tick asks again until the timeout.
        }
      }),
    );
  }

  /** Every 30 s: players, TPS, version of running games. */
  async statusTick(): Promise<void> {
    if (!this.active) return;
    const rows = this.rows().filter(
      (r) =>
        (r.phase === 'running' || r.phase === 'stopped') &&
        !this.busy.has(r.id) &&
        this.deps.hub.isConnected(r.serverId),
    );
    await Promise.all(
      rows.map(async (row) => {
        if (this.containerOf(row)?.state !== 'running') {
          this.reportStatus(row, null);
          return;
        }
        const prev = parse<GameStatusData>(row.statusJson);
        let st: GameStatusData | null;
        try {
          st = await this.queryStatus(row);
        } catch {
          st = { online: false, players: null, version: prev?.version ?? null, tps: null };
        }
        if (st === null) return;
        const now = this.deps.now();
        const empty = st.online && st.players?.online === 0;
        this.deps.db
          .update(gameServers)
          .set({
            statusJson: JSON.stringify(st),
            statusAt: now,
            emptySince: empty ? (row.emptySince ?? now) : null,
          })
          .where(eq(gameServers.id, row.id))
          .run();
        this.reportStatus(row, st.online ? st : null);
      }),
    );
    this.refreshAll();
    for (const id of [...this.pendingOnline]) {
      const sum = this.summary(id);
      if (!sum) this.pendingOnline.delete(id);
      else if (sum.status === 'ok' || sum.status === 'warn') {
        this.pendingOnline.delete(id);
        this.announce(id, 'online');
      }
    }
  }

  /** Every minute: stop running games that had no players for autoStopMinutes. */
  async autoStopTick(): Promise<void> {
    if (!this.active) return;
    const now = this.deps.now();
    const due = this.rows().filter(
      (r) =>
        r.phase === 'running' &&
        r.autoStopMinutes > 0 &&
        r.emptySince !== null &&
        now - r.emptySince >= r.autoStopMinutes * 60_000 &&
        !this.busy.has(r.id) &&
        this.deps.hub.isConnected(r.serverId),
    );
    for (const row of due) {
      try {
        await this.action(row.id, 'stop', 'system', { sleep: true });
      } catch {
        continue;
      }
      const asleep = await this.fallAsleep(row.id);
      this.deps.alerts.log(
        `game:${row.id}:autostop`,
        'info',
        asleep ? `Gameserver ${row.name} schläft` : `Gameserver ${row.name} automatisch gestoppt`,
        asleep
          ? `Seit ${row.autoStopMinutes} Min keine Spieler (${clockTime(now)}). Der erste Login weckt ihn.`
          : `Seit ${row.autoStopMinutes} Min keine Spieler (${clockTime(now)}).`,
        row.serverId,
        'game',
      );
      this.announce(row.id, asleep ? 'sleep' : 'offline');
    }
    // Wakes that did not fit into RAM: listen again.
    for (const [id, at] of [...this.rearmAt]) {
      if (at > now) continue;
      this.rearmAt.delete(id);
      const row = this.row(id);
      if (row?.sleeping && !this.busy.has(id)) await this.arm(row);
    }
  }

  // ---- M12 sleep mode ------------------------------------------------------------

  /** Whether the game should get wake listeners when it is stopped by the sleep mode. */
  private wakeMode(row: GameServerRow): 'minecraft' | 'minecraft-bedrock' | 'raw' | null {
    const t = this.templates.get(row.templateId)?.template;
    if (!t || !row.wakeOnConnect || t.wake === 'none') return null;
    return t.wake;
  }

  /**
   * After a sleep-mode stop: game.wake.arm on the game's public host ports. On
   * success the game is `sleeping` ("Schläft"). Returns whether it sleeps.
   */
  private async fallAsleep(id: string): Promise<boolean> {
    const row = this.row(id);
    if (!row || row.phase !== 'stopped' || this.wakeMode(row) === null) return false;
    return this.arm(row);
  }

  /** game.wake.arm; sets sleeping. False (and a progress line) when it fails. */
  private async arm(row: GameServerRow): Promise<boolean> {
    const mode = this.wakeMode(row);
    const ports = mode === null ? [] : wakePorts(mode, storedOf(row).ports);
    if (mode === null || ports.length === 0) return false;
    if (!this.deps.hub.isConnected(row.serverId)) {
      // Listeners are armed again when the agent says hello.
      this.setSleeping(row.id, true);
      return true;
    }
    try {
      const data = await this.deps.hub.call(
        row.serverId,
        'game.wake.arm',
        { gameId: row.name, mode, ports, motd: SLEEP_MOTD },
        { timeoutMs: WAKE_TIMEOUT_MS },
      );
      const parsed = gameWakeArmDataSchema.safeParse(data);
      if (!parsed.success || parsed.data.listening.length === 0) {
        throw new RpcError('failed', 'no listener');
      }
    } catch (err) {
      this.event(row.id, 'error', `Aufwecken nicht möglich: ${rpcReason(err, 'Lauschen')}`);
      this.setSleeping(row.id, false);
      return false;
    }
    this.setSleeping(row.id, true);
    return true;
  }

  /** game.wake.disarm, errors ignored (the agent drops listeners on restart anyway). */
  private async disarm(row: GameServerRow, serverId = row.serverId): Promise<void> {
    this.rearmAt.delete(row.id);
    if (!row.sleeping) return;
    if (this.deps.hub.isConnected(serverId)) {
      try {
        await this.deps.hub.call(
          serverId,
          'game.wake.disarm',
          { gameId: row.name },
          { timeoutMs: WAKE_TIMEOUT_MS },
        );
      } catch (err) {
        this.logError(err, 'game.wake.disarm failed');
      }
    }
    this.setSleeping(row.id, false);
  }

  private setSleeping(id: string, sleeping: boolean): void {
    const r = this.deps.db
      .update(gameServers)
      .set({ sleeping, updatedAt: this.deps.now() })
      .where(eq(gameServers.id, id))
      .run();
    if (r.changes > 0) this.emit(id);
  }

  /**
   * Event game_wake of `serverId`'s agent: only for a game of THIS server (by
   * folder name) that is sleeping. Starts it on the normal start path with the
   * RAM reserve; if it does not fit, it stays asleep, an alert says why, and
   * the listeners are armed again after a minute.
   */
  onWake(serverId: string, gameFolder: string): void {
    if (!this.active) return;
    const row = this.deps.db
      .select()
      .from(gameServers)
      .where(and(eq(gameServers.serverId, serverId), eq(gameServers.name, gameFolder)))
      .get();
    if (!row?.sleeping || row.phase !== 'stopped' || this.busy.has(row.id)) return;
    this.track(this.wake(row));
  }

  private async wake(row: GameServerRow): Promise<void> {
    try {
      await this.action(row.id, 'start', 'system');
    } catch (err) {
      if (err instanceof HttpError && err.code === 'insufficient_ram') {
        this.deps.alerts.raise(
          `game:${row.id}:wake`,
          'warn',
          `Gameserver ${row.name} konnte nicht aufwachen`,
          `${err.userMessage ?? 'Zu wenig RAM'} (${clockTime(this.deps.now())}). Er schläft weiter.`,
          row.serverId,
          'game',
        );
      } else {
        this.event(row.id, 'error', `Aufwecken fehlgeschlagen: ${rpcReason(err, 'Start')}`);
      }
      // The agent closed its listeners on the wake: listen again in a minute.
      this.setSleeping(row.id, true);
      this.rearmAt.set(row.id, this.deps.now() + WAKE_RETRY_MS);
      return;
    }
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'system',
      action: 'game.woken',
      target: row.id,
      details: { name: row.name, serverId: row.serverId },
    });
    const refused = `game:${row.id}:wake`;
    if (this.deps.alerts.active(refused)) {
      this.deps.alerts.resolve(refused, {
        title: `Gameserver ${row.name} ist aufgewacht`,
        body: `Gestartet um ${clockTime(this.deps.now())}.`,
      });
    }
    this.announce(row.id, 'wake');
  }

  /** The agent said hello: its listeners are gone, arm every sleeping game of it again. */
  rearmServer(serverId: string): void {
    if (!this.active) return;
    for (const row of this.rows()) {
      if (row.serverId !== serverId || !row.sleeping || this.busy.has(row.id)) continue;
      this.track(this.arm(row));
    }
  }

  // ---- actions -------------------------------------------------------------------------

  private requireRow(id: string): GameServerRow {
    const row = this.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  }

  private lock(row: GameServerRow, text: string): void {
    if (this.busy.has(row.id) || row.phase === 'setup') throw new HttpError(409, 'busy');
    if (!this.deps.hub.isConnected(row.serverId)) throw new HttpError(409, 'agent_offline');
    this.busy.set(row.id, text);
    this.emit(row.id);
  }

  private unlock(id: string): void {
    if (!this.busy.delete(id)) return;
    if (this.row(id)) this.emit(id);
  }

  /** start | stop | restart (waits for the agent); backup runs in the background. */
  async action(
    id: string,
    action: 'start' | 'stop' | 'restart' | 'backup',
    /** `admin`, `system`, `share:<id>` (a friend's link) or `voice:ha` (Alexa via HA). */
    actor: 'admin' | 'system' | `share:${string}` | `voice:${string}` = 'admin',
    /** `sleep`: stop of the sleep mode (keeps wake listeners possible, no offline message). */
    opts: { sleep?: boolean } = {},
  ): Promise<GameSummary> {
    const row = this.requireRow(id);
    if (action === 'backup') {
      this.lock(row, 'Backup läuft');
      this.track(
        this.runBackup(row).finally(() => {
          this.unlock(id);
        }),
      );
      return this.summary(id) as GameSummary;
    }
    const texts = { start: 'Startet', stop: 'Wird gestoppt', restart: 'Neustart' } as const;
    const starts =
      action === 'start' || (action === 'restart' && this.containerOf(row)?.state !== 'running');
    // M22: a game on a sleeping cloud VM starts the VM first (in the background).
    if (starts && this.cloudHost) {
      const gate = this.cloudHost.startGate(row.serverId);
      if (gate === 'over_budget') {
        throw new HttpError(409, 'over_budget', undefined, CLOUD_GAME_TEXT.overBudget);
      }
      if (gate === 'wake') return this.startAfterCloud(row, actor);
    }
    // A restart of a game that does not run is a start (compose up): same RAM check.
    let release = (): void => undefined;
    if (starts) {
      release = this.admitStart(row.serverId, this.ramLimitOf(row), this.containerIds(row), actor);
    }
    try {
      this.lock(row, texts[action]);
    } catch (err) {
      release();
      throw err;
    }
    const dir = gameDirOf(row.name);
    const hub = this.deps.hub;
    const cIds = this.containerIds(row);
    try {
      // A start (also through a link or a wake-up) and a manual stop end the sleep.
      if (!opts.sleep) await this.disarm(row);
      if (action === 'start') {
        await this.runStart(row);
      } else if (action === 'stop') {
        await this.runStop(row);
      } else {
        for (const c of cIds) this.deps.setIntent(c, 'restart', INTENT_TTL_MS);
        const c = this.containerOf(row);
        if (c && c.state === 'running') {
          await hub.call(
            row.serverId,
            'container.restart',
            { id: c.dockerId },
            { timeoutMs: ACTION_TIMEOUT_MS },
          );
        } else {
          await hub.call(row.serverId, 'compose.up', { dir }, { timeoutMs: UP_TIMEOUT_MS });
        }
        this.setRunState(id, 'running');
      }
    } catch (err) {
      if (action !== 'start') for (const c of cIds) this.deps.setIntent(c, null);
      throw err;
    } finally {
      release();
      this.unlock(id);
    }
    writeAudit(this.deps.db, this.deps.now(), {
      actor,
      action: `game.${action}`,
      target: id,
      details: { name: row.name, serverId: row.serverId },
    });
    if (action === 'stop') {
      this.pendingOnline.delete(id);
      if (!opts.sleep) this.announce(id, 'offline');
    } else this.pendingOnline.add(id);
    return this.summary(id) as GameSummary;
  }

  /** The start of this game waits for its cloud VM (POST start answers 202). */
  waitsForCloud(id: string): boolean {
    return this.cloudWaiting.has(id);
  }

  /**
   * M22: holds the game busy ("Cloud-Server startet") while the VM starts, then runs
   * the normal start (RAM reserve, compose up) with the same actor. Not awaited.
   */
  private startAfterCloud(
    row: GameServerRow,
    actor: Parameters<GameService['action']>[2],
  ): GameSummary {
    const host = this.cloudHost;
    if (!host) throw new HttpError(409, 'agent_offline');
    if (this.busy.has(row.id) || row.phase === 'setup') throw new HttpError(409, 'busy');
    this.busy.set(row.id, CLOUD_GAME_TEXT.starting);
    this.cloudWaiting.add(row.id);
    this.emit(row.id);
    const run = async (): Promise<void> => {
      let ok: boolean;
      try {
        ok = await host.ensureRunning(row.serverId, actor ?? 'admin');
      } finally {
        this.cloudWaiting.delete(row.id);
        this.unlock(row.id);
      }
      if (!this.row(row.id)) return;
      if (!ok) {
        this.event(row.id, 'error', 'Start fehlgeschlagen: Cloud-Server nicht erreichbar');
        return;
      }
      try {
        await this.action(row.id, 'start', actor);
      } catch (err) {
        const reason =
          err instanceof HttpError ? (err.userMessage ?? err.code) : rpcReason(err, 'Start');
        this.event(row.id, 'error', `Start fehlgeschlagen: ${reason}`);
      }
    };
    this.track(run());
    return this.summary(row.id) as GameSummary;
  }

  /**
   * M22: checks a gameserver for a cloud machine that does not exist yet, like POST
   * /api/games would (template, values, ports, external address). Returns its RAM limit.
   */
  validatePending(req: Omit<GameCreateRequest, 'serverId'>): { ramBytes: number | null } {
    const l = this.templates.get(req.templateId);
    if (!l) throw new HttpError(400, 'invalid_input');
    const t = l.template;
    if (!validExternalAddress(req.externalAddress)) throw new HttpError(400, 'invalid_input');
    if (!t.arch.includes('amd64')) {
      throw new HttpError(400, 'invalid_input', undefined, 'Läuft nicht auf amd64');
    }
    const values = this.validate(t, req.values);
    this.resolvePortsOn(t, { tcp: new Set(), udp: new Set() }, req.ports);
    return { ramBytes: this.ramLimitFor(t.id, values.values) };
  }

  /** Ids of the games on a server. */
  gameIdsOn(serverId: string): string[] {
    return this.deps.db
      .select({ id: gameServers.id })
      .from(gameServers)
      .where(eq(gameServers.serverId, serverId))
      .all()
      .map((r) => r.id);
  }

  /** Public host ports of all games on a server (never local ones, never RCON). */
  publicPortsOn(serverId: string): { port: number; proto: 'tcp' | 'udp' }[] {
    const out: { port: number; proto: 'tcp' | 'udp' }[] = [];
    for (const row of this.rows().filter((r) => r.serverId === serverId)) {
      const tplPorts = new Map(
        (this.templates.get(row.templateId)?.template.ports ?? []).map((p) => [p.name, p]),
      );
      const ports = storedOf(row).ports.map((p) => ({
        ...p,
        local: p.local ?? tplPorts.get(p.name)?.local ?? false,
      }));
      out.push(...publicGamePorts(ports));
    }
    return out;
  }

  /** compose up in the game folder on its server (the start path of action()). */
  private async runStart(row: GameServerRow): Promise<void> {
    for (const c of this.containerIds(row)) this.deps.setIntent(c, null);
    await this.deps.hub.call(
      row.serverId,
      'compose.up',
      { dir: gameDirOf(row.name) },
      { timeoutMs: UP_TIMEOUT_MS },
    );
    this.setRunState(row.id, 'running');
  }

  /** One agent call for the game (M12 mods): 409 agent_offline when not connected. */
  async callAgent<A extends RpcAction>(
    row: GameServerRow,
    action: A,
    params: RpcParamsInput<A>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.deps.hub.isConnected(row.serverId)) throw new HttpError(409, 'agent_offline');
    return this.deps.hub.call(row.serverId, action, params, { timeoutMs });
  }

  /** M12: mods/plugins changed since the last start ("Neustart nötig"). */
  setModsRestartNeeded(id: string, needed: boolean): void {
    this.deps.db
      .update(gameServers)
      .set({ modsRestartNeeded: needed })
      .where(eq(gameServers.id, id))
      .run();
  }

  /** compose down in the game folder on its server (the stop path of action()). */
  private async runStop(row: GameServerRow): Promise<void> {
    const cIds = this.containerIds(row);
    for (const c of cIds) this.deps.setIntent(c, 'stop');
    try {
      await this.deps.hub.call(
        row.serverId,
        'compose.down',
        { dir: gameDirOf(row.name) },
        { timeoutMs: DOWN_TIMEOUT_MS },
      );
    } catch (err) {
      for (const c of cIds) this.deps.setIntent(c, null);
      throw err;
    }
    this.setRunState(row.id, 'stopped');
  }

  /** RAM limit of the game: MEMORY field, else the template recommendation. */
  ramLimitOf(row: GameServerRow): number | null {
    return this.ramLimitFor(row.templateId, storedOf(row).values);
  }

  private ramLimitFor(templateId: string, values: Record<string, unknown>): number | null {
    const mem = values.MEMORY;
    const m = typeof mem === 'string' ? /^(\d{1,3})([GM])$/.exec(mem) : null;
    if (m) return Number(m[1]) * (m[2] === 'G' ? 1024 ** 3 : 1024 ** 2);
    const rec = this.templates.get(templateId)?.template.ram.recommended;
    return rec ? ramBytes(rec) : null;
  }

  /**
   * The RAM reserve check of a migration (M11) on `serverId`, check only: the
   * migration runs it before backup and before the transfer. Unknown RAM does
   * not block (system actor).
   */
  checkRamOn(row: GameServerRow, serverId: string): void {
    this.holdRamOn(row, serverId)();
  }

  /**
   * Like checkRamOn, but the RAM stays held until the returned release runs:
   * the migration holds it on the target from the check until compose up
   * returned (call release in finally).
   */
  holdRamOn(row: GameServerRow, serverId: string): () => void {
    const own = serverId === row.serverId ? this.containerIds(row) : [];
    return this.admitStart(serverId, this.ramLimitOf(row), own, 'system');
  }

  /**
   * M10 RAM reserve, on every path that starts a game container (create, start,
   * restart of a stopped game, wichtig restart, share link, settings/ports with
   * compose up): refuses with 409 insufficient_ram when `needed` does not fit
   * into free RAM minus the reserve for wichtig containers minus the RAM held by
   * other starts in flight on the server. On success the RAM is held until the
   * returned release function runs (after compose up).
   *
   * Unknown RAM (no metrics or older than 60 s): a share link is refused with
   * 409 `ram_unknown` (friends never bypass the reserve); the admin and the
   * system may start (their start is the way out when the agent's metrics lag).
   */
  private admitStart(
    serverId: string,
    needed: number | null,
    own: readonly string[],
    actor: 'admin' | 'system' | `share:${string}` | `voice:${string}`,
  ): () => void {
    if (!this.control || needed === null || needed <= 0) return () => undefined;
    const r = this.control.ramCheck(serverId, needed, own);
    // Starts from outside the hub (friend links, voice via Home Assistant) never
    // bypass the reserve.
    const share = actor.startsWith('share:') || actor.startsWith('voice:');
    if (r.kind === 'unknown' && share) throw new HttpError(409, 'ram_unknown');
    if (r.kind === 'insufficient') {
      const d = r.details;
      const left = Math.max(0, d.freeBytes - d.reserveBytes);
      throw new HttpError(
        409,
        'insufficient_ram',
        undefined,
        `Zu wenig RAM, ${gigabytes(left)} frei`,
        d,
      );
    }
    return this.control.holdRam(serverId, needed);
  }

  /**
   * RAM a compose up of a game in phase running needs on top of what it uses:
   * the whole limit when its container does not run, else only the growth of
   * the limit (a recreate with the same or a smaller limit needs nothing).
   */
  private recreateNeed(row: GameServerRow, newLimit: number | null): number | null {
    if (this.containerOf(row)?.state !== 'running') return newLimit;
    if (newLimit === null) return 0;
    const cur = this.ramLimitOf(row);
    return cur === null ? newLimit : Math.max(0, newLimit - cur);
  }

  private setRunState(id: string, phase: 'running' | 'stopped'): void {
    const row = this.row(id);
    if (!row) return;
    const st = parse<GameStatusData>(row.statusJson);
    this.deps.db
      .update(gameServers)
      .set({
        phase,
        phaseText: null,
        // A new run starts without players; the next poll reports them.
        statusJson: st ? JSON.stringify({ ...st, online: false, players: null, tps: null }) : null,
        statusAt: null,
        emptySince: null,
        updatedAt: this.deps.now(),
        ...(phase === 'running' ? { sleeping: false, modsRestartNeeded: false } : {}),
      })
      .where(eq(gameServers.id, id))
      .run();
  }

  private async runBackup(row: GameServerRow, keepFiles = BACKUP_KEEP): Promise<BackupOutcome> {
    const secrets = this.secretsOf(row);
    const fail = (reason: string, code: string): BackupOutcome => {
      this.event(row.id, 'error', `Backup fehlgeschlagen: ${reason}`);
      writeAudit(this.deps.db, this.deps.now(), {
        actor: 'system',
        action: 'game.backup_failed',
        target: row.id,
        details: { name: row.name, reason },
      });
      return { ok: false, reason, code };
    };
    let stream: RpcStream;
    try {
      stream = this.deps.hub.stream(
        row.serverId,
        'game.backup',
        { gameDir: gameDirOf(row.name), keep: keepFiles },
        { timeoutMs: BACKUP_TIMEOUT_MS },
      );
    } catch (err) {
      return fail(rpcReason(err, 'Backup', secrets), err instanceof RpcError ? err.code : 'failed');
    }
    this.event(row.id, 'progress', 'Backup läuft');
    // Progress lines are translated; the last one carries the result and is never shown.
    let resultLine: BackupDone | 'invalid' | null = null;
    let partial = '';
    const onLine = (line: string): void => {
      const r = parseBackupResult(line);
      if (r !== null) {
        resultLine = r;
        return;
      }
      const text = translateProgress(scrub(line, secrets));
      this.event(row.id, 'progress', text);
      if (/MiB geschrieben$/.test(text) && this.busy.get(row.id)?.startsWith('Backup')) {
        this.busy.set(row.id, `Backup läuft: ${text.replace(' geschrieben', '')}`);
        this.emit(row.id);
      }
    };
    stream.on('data', (c: StreamChunk) => {
      if (c.channel !== 'progress') {
        this.event(row.id, 'console', scrub(c.chunk, secrets));
        return;
      }
      const lines = (partial + c.chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) if (line !== '') onLine(line);
    });
    const end = await stream.done;
    stream.removeAllListeners('data');
    if (partial !== '') onLine(partial);
    const result = await stream.result;
    if (end.code !== 0) {
      const code = end.error ?? 'failed';
      if (code === 'not_found') return fail(NOTHING_TO_BACK_UP, code);
      const reason = rpcReason(
        new RpcError(code as RpcFailure, end.detail ?? ''),
        'Backup',
        secrets,
      );
      return fail(end.code > 0 ? `${reason} (Exit ${end.code})` : reason, code);
    }
    const fromResult = backupDoneDataSchema.safeParse(result);
    const done: BackupDone | null = fromResult.success
      ? fromResult.data
      : resultLine === 'invalid'
        ? null
        : resultLine;
    if (!done || !done.path.startsWith(BACKUPS_ROOT)) {
      return fail('keine gültige Antwort vom Agent', 'failed');
    }
    const data = { data: done };
    if (!this.row(row.id)) return fail('Gameserver gelöscht', 'failed');
    const now = this.deps.now();
    const b = {
      id: randomToken(12),
      gameId: row.id,
      path: data.data.path,
      size: data.data.sizeBytes,
      createdAt: now,
    };
    this.deps.db.insert(gameBackups).values(b).run();
    // Keep the last 7 entries (the agent deletes the older files).
    const keep = this.deps.db
      .select({ id: gameBackups.id })
      .from(gameBackups)
      .where(eq(gameBackups.gameId, row.id))
      .orderBy(desc(gameBackups.createdAt), desc(gameBackups.id))
      .all()
      .slice(BACKUP_KEEP)
      .map((r) => r.id);
    if (keep.length > 0)
      this.deps.db.delete(gameBackups).where(inArray(gameBackups.id, keep)).run();
    this.event(row.id, 'progress', `Backup erstellt: ${basename(b.path)}`);
    writeAudit(this.deps.db, now, {
      actor: 'system',
      action: 'game.backup_done',
      target: row.id,
      details: { name: row.name, file: basename(b.path), sizeBytes: b.size },
    });
    return {
      ok: true,
      backup: { id: b.id, fileName: basename(b.path), sizeBytes: b.size, createdAt: iso(now) },
    };
  }

  // ---- rcon ---------------------------------------------------------------------------

  /** Sliding window per game. Returns seconds to wait, or null if allowed (and counted). */
  private rconLimited(id: string): number | null {
    const now = this.deps.now();
    const hits = (this.rconHits.get(id) ?? []).filter((t) => now - t < RCON_WINDOW_MS);
    if (hits.length >= RCON_LIMIT) {
      this.rconHits.set(id, hits);
      return Math.max(1, Math.ceil((RCON_WINDOW_MS - (now - (hits[0] ?? now))) / 1000));
    }
    hits.push(now);
    this.rconHits.set(id, hits);
    return null;
  }

  async rcon(id: string, command: string): Promise<string> {
    const row = this.requireRow(id);
    const supported =
      this.templates.get(row.templateId)?.template.rcon.supported ?? row.rconSecretEnc !== null;
    if (!supported || row.rconSecretEnc === null) throw new HttpError(409, 'conflict');
    const wait = this.rconLimited(id);
    if (wait !== null) throw new HttpError(429, 'rate_limited', wait);
    if (!this.deps.hub.isConnected(row.serverId)) throw new HttpError(409, 'agent_offline');
    const data = await this.deps.hub.call(
      row.serverId,
      'game.rcon',
      { gameDir: gameDirOf(row.name), command },
      { timeoutMs: RCON_TIMEOUT_MS },
    );
    const parsed = rconDataSchema.safeParse(data);
    if (!parsed.success) throw new HttpError(502, 'agent_error');
    const output = scrub(parsed.data.output, this.secretsOf(row));
    this.event(id, 'console', `> ${command}`);
    this.event(id, 'console', output);
    return output;
  }

  // ---- share links (M7) -------------------------------------------------------------

  /** Id of the game's container in the core (for its log topic), or null. */
  containerIdOf(id: string): string | null {
    const row = this.row(id);
    return row ? (this.containerOf(row)?.id ?? null) : null;
  }

  /** Removes the game's secrets from text shown to someone else (share console). */
  scrubFor(id: string, text: string): string {
    const row = this.row(id);
    return row ? scrub(text, this.secretsOf(row)) : text;
  }

  /** Whether the template speaks RCON and the game has a password. */
  hasRcon(id: string): boolean {
    const row = this.row(id);
    if (!row || row.rconSecretEnc === null) return false;
    return this.templates.get(row.templateId)?.template.rcon.supported ?? true;
  }

  /**
   * Game events with sequence >= `from` (console and error lines only), for the
   * share console. Event ids are the sequence numbers.
   */
  consoleEvents(id: string, from: number): GameEvent[] {
    return (this.events.get(id) ?? []).filter(
      (e) => (e.kind === 'console' || e.kind === 'error') && Number(e.id) >= from,
    );
  }

  /** Next event sequence number of the game (cursor for the share console). */
  nextEventSeq(id: string): number {
    return this.seq.get(id) ?? 0;
  }

  // ---- settings ---------------------------------------------------------------------------

  async update(id: string, req: GameUpdateRequest): Promise<GameSummary> {
    const row = this.requireRow(id);
    if (req.externalAddress !== undefined && !validExternalAddress(req.externalAddress)) {
      throw new HttpError(400, 'invalid_input');
    }
    const set: Partial<GameServerRow> = { updatedAt: this.deps.now() };
    if (req.externalAddress !== undefined) set.externalAddress = req.externalAddress;
    if (req.autoStopMinutes !== undefined) {
      set.autoStopMinutes = req.autoStopMinutes;
    }
    if (req.wakeOnConnect !== undefined) set.wakeOnConnect = req.wakeOnConnect;
    if (req.values === undefined) {
      if (this.busy.has(id)) throw new HttpError(409, 'busy');
      this.deps.db.update(gameServers).set(set).where(eq(gameServers.id, id)).run();
      // Wake-on-connect switched off while asleep: stop listening, it just stays off.
      if (req.wakeOnConnect === false && row.sleeping) await this.disarm(row);
      this.emit(id);
      return this.summary(id) as GameSummary;
    }
    const l = this.templates.get(row.templateId);
    if (!l) throw new HttpError(409, 'conflict');
    const stored = storedOf(row);
    const values = this.validate(l.template, req.values, {
      values: stored.values,
      secrets: this.secretValues(row),
    });
    const rconPassword = this.rconPassword(row);
    const files = this.render(l, {
      name: row.name,
      ports: stored.ports,
      rconPort: row.rconPort,
      values,
      rconPassword,
    });
    // A running game is recreated (compose up): a larger RAM limit must fit.
    const release =
      row.phase === 'running'
        ? this.admitStart(
            row.serverId,
            this.recreateNeed(row, this.ramLimitFor(row.templateId, values.values)),
            this.containerIds(row),
            'admin',
          )
        : () => undefined;
    try {
      this.lock(row, 'Einstellungen werden übernommen');
    } catch (err) {
      release();
      throw err;
    }
    const dir = gameDirOf(row.name);
    try {
      await this.deps.hub.call(
        row.serverId,
        'compose.write',
        { dir, files: { 'compose.yml': files.compose, '.env': files.env } },
        { timeoutMs: WRITE_TIMEOUT_MS },
      );
      set.settingsJson = JSON.stringify(values.values);
      set.secretValuesEnc =
        Object.keys(values.secrets).length === 0
          ? null
          : this.deps.box.encrypt(JSON.stringify(values.secrets), `game_servers.secrets:${id}`);
      this.deps.db.update(gameServers).set(set).where(eq(gameServers.id, id)).run();
      if (row.phase === 'running') {
        for (const c of this.containerIds(row)) this.deps.setIntent(c, 'restart', INTENT_TTL_MS);
        await this.deps.hub.call(row.serverId, 'compose.up', { dir }, { timeoutMs: UP_TIMEOUT_MS });
        this.setRunState(id, 'running');
      }
    } finally {
      release();
      this.unlock(id);
    }
    return this.summary(id) as GameSummary;
  }

  // ---- ports ------------------------------------------------------------------------------

  /**
   * Changes host ports after setup (decision 2026-11-26). Same rules as on create:
   * 1024–65535 incl. the range of `count`, no overlap between the game's own ports,
   * no conflict with other games, containers or listening ports of the server
   * (409 conflict). The game's own current ports and its RCON port do not count as
   * used, so ports can be swapped; the RCON port itself never moves. Rewrites
   * compose.yml/.env and recreates a running game (compose up).
   */
  async changePorts(
    id: string,
    requested: Record<string, number>,
  ): Promise<Omit<GamePortsUpdateResponse, 'game'> & { game: GameSummary }> {
    const row = this.requireRow(id);
    const l = this.templates.get(row.templateId);
    if (!l) throw new HttpError(409, 'conflict');
    const t = l.template;
    const stored = storedOf(row);
    const names = new Set(t.ports.map((p) => p.name));
    for (const k of Object.keys(requested)) {
      if (!names.has(k)) throw new HttpError(400, 'invalid_input');
    }
    const current = new Map(stored.ports.map((p) => [p.name, p]));
    const used = this.usedPorts(row.serverId, id);
    // The game's own current bindings are in the agent's listening ports: free them.
    for (const p of stored.ports) {
      for (const proto of p.protocol === 'tcp+udp' ? (['tcp', 'udp'] as const) : [p.protocol]) {
        for (let i = 0; i < p.count; i += 1) used[proto].delete(p.port + i);
      }
    }
    const own: UsedPorts = { tcp: new Set(), udp: new Set() };
    if (row.rconPort !== null) own.tcp.add(row.rconPort);
    const next: HostPort[] = [];
    const changed: GamePortsUpdateResponse['changed'] = [];
    for (const p of t.ports) {
      const prev = current.get(p.name);
      const want = requested[p.name] ?? prev?.port;
      if (want === undefined) throw new HttpError(409, 'conflict');
      const hp = { port: want, protocol: p.protocol, count: p.count };
      if (want < 1024 || want + p.count - 1 > 65535) throw new HttpError(400, 'invalid_input');
      if (!isFree(own, hp)) throw new HttpError(400, 'invalid_input');
      if (want !== prev?.port && !isFree(used, hp)) throw new HttpError(409, 'conflict');
      markUsed(own, hp);
      next.push({ name: p.name, port: want, protocol: p.protocol, count: p.count, local: p.local });
      if (prev && prev.port !== want) {
        changed.push({
          name: p.name,
          protocol: p.protocol,
          count: p.count,
          from: prev.port,
          to: want,
          local: p.local,
        });
      }
    }
    const result = (game: GameSummary) => ({
      game,
      ports: next.map((p) => ({
        name: p.name,
        port: p.port,
        protocol: p.protocol,
        count: p.count,
        local: p.local ?? false,
      })),
      changed,
      forwardingHint: forwardingHint(changed, this.networkOf(row.serverId)),
    });
    if (changed.length === 0) return result(this.summary(id) as GameSummary);

    const values = { values: stored.values, secrets: this.secretValues(row) };
    const files = this.render(l, {
      name: row.name,
      ports: next,
      rconPort: row.rconPort,
      values,
      rconPassword: this.rconPassword(row),
    });
    // Same limit; only a running-phase game whose container is down needs the RAM.
    const release =
      row.phase === 'running'
        ? this.admitStart(
            row.serverId,
            this.recreateNeed(row, this.ramLimitOf(row)),
            this.containerIds(row),
            'admin',
          )
        : () => undefined;
    try {
      this.lock(row, 'Ports werden geändert');
    } catch (err) {
      release();
      throw err;
    }
    const dir = gameDirOf(row.name);
    try {
      await this.deps.hub.call(
        row.serverId,
        'compose.write',
        { dir, files: { 'compose.yml': files.compose, '.env': files.env } },
        { timeoutMs: WRITE_TIMEOUT_MS },
      );
      this.deps.db
        .update(gameServers)
        .set({ portsJson: JSON.stringify(next), updatedAt: this.deps.now() })
        .where(eq(gameServers.id, id))
        .run();
      this.syncPorts(row.serverId, row.name, next);
      if (row.phase === 'running') {
        for (const c of this.containerIds(row)) this.deps.setIntent(c, 'restart', INTENT_TTL_MS);
        await this.deps.hub.call(row.serverId, 'compose.up', { dir }, { timeoutMs: UP_TIMEOUT_MS });
        this.setRunState(id, 'running');
      }
    } finally {
      release();
      this.unlock(id);
    }
    // Asleep: the listeners move to the new ports (re-arming replaces the old ones).
    const fresh = this.row(id);
    if (fresh?.sleeping) await this.arm(fresh);
    return result(this.summary(id) as GameSummary);
  }

  // ---- M11: migration hooks (games/migrate.ts) ---------------------------------------------

  /** Takes the busy lock for a migration: 409 busy (setup, action, backup) / agent_offline. */
  lockForMigration(id: string, text: string): GameServerRow {
    const row = this.requireRow(id);
    this.lock(row, text);
    return row;
  }

  /** Updates the busy text of a locked game (progress in the summary). */
  setBusyText(id: string, text: string): void {
    if (!this.busy.has(id)) return;
    this.busy.set(id, text);
    this.emit(id);
  }

  unlockMigration(id: string): void {
    this.unlock(id);
  }

  /** A line on topic game:<id>. */
  pushEvent(id: string, kind: GameEvent['kind'], text: string): void {
    this.event(id, kind, text);
  }

  /** The game's container runs on its server. */
  isRunning(id: string): boolean {
    const row = this.row(id);
    return row !== undefined && this.containerOf(row)?.state === 'running';
  }

  /** Stop while the migration holds the lock (same path as action('stop')). */
  async stopLocked(id: string): Promise<void> {
    await this.runStop(this.requireRow(id));
  }

  /**
   * Start while the migration holds the lock (same path as action('start'),
   * same RAM reserve: 409 insufficient_ram, RAM held until compose up returned).
   */
  async startLocked(id: string): Promise<void> {
    const row = this.requireRow(id);
    const release = this.admitStart(
      row.serverId,
      this.ramLimitOf(row),
      this.containerIds(row),
      'system',
    );
    try {
      await this.runStart(row);
    } finally {
      release();
    }
  }

  /** Secrets of a game, for scrubbing agent output. */
  secretsOfGame(id: string): string[] {
    const row = this.row(id);
    return row ? this.secretsOf(row) : [];
  }

  /**
   * A game with this folder name exists on `serverId`, or a container uses the
   * folder /opt/homelab/games/<name>/ there (it would be overwritten).
   */
  folderTakenOn(row: GameServerRow, serverId: string): boolean {
    const game = this.deps.db
      .select({ id: gameServers.id })
      .from(gameServers)
      .where(and(eq(gameServers.serverId, serverId), eq(gameServers.name, row.name)))
      .get();
    const foreign = this.deps.db
      .select({ id: containers.id })
      .from(containers)
      .where(gameContainerWhere(serverId, row.name, true))
      .get();
    return game !== undefined || foreign !== undefined;
  }

  /**
   * Host ports of the game on another server: the requested ones (same checks as
   * on create: 400 invalid_input, 409 conflict), else the current port if it is
   * free there, else the next free one from it. The RCON port (127.0.0.1) stays if
   * free, else the next free one.
   */
  planPorts(
    row: GameServerRow,
    serverId: string,
    requested: Record<string, number> | undefined,
  ): {
    ports: HostPort[];
    rconPort: number | null;
    changed: GamePortsUpdateResponse['changed'];
    forwardingHint: string | null;
  } {
    const l = this.templates.get(row.templateId);
    if (!l) throw new HttpError(409, 'conflict');
    const t = l.template;
    this.checkArch(t.id, serverId);
    const names = new Set(t.ports.map((p) => p.name));
    for (const k of Object.keys(requested ?? {})) {
      if (!names.has(k)) throw new HttpError(400, 'invalid_input');
    }
    const current = new Map(storedOf(row).ports.map((p) => [p.name, p]));
    const used = this.usedPorts(serverId, row.id);
    const own: UsedPorts = { tcp: new Set(), udp: new Set() };
    const ports: HostPort[] = [];
    const changed: GamePortsUpdateResponse['changed'] = [];
    for (const p of t.ports) {
      const want = requested?.[p.name];
      const all = mergeUsed(used, own);
      let port: number | null;
      if (want !== undefined) {
        const hp = { port: want, protocol: p.protocol, count: p.count };
        if (want + p.count - 1 > 65535) throw new HttpError(400, 'invalid_input');
        if (!isFree(own, hp)) throw new HttpError(400, 'invalid_input');
        if (!isFree(used, hp)) throw new HttpError(409, 'conflict');
        port = want;
      } else {
        port = firstFree(all, current.get(p.name)?.port ?? p.default, p.protocol, p.count);
      }
      if (port === null) throw new HttpError(409, 'conflict');
      markUsed(own, { port, protocol: p.protocol, count: p.count });
      ports.push({ name: p.name, port, protocol: p.protocol, count: p.count, local: p.local });
      const prev = current.get(p.name);
      if (prev && prev.port !== port) {
        changed.push({
          name: p.name,
          protocol: p.protocol,
          count: p.count,
          from: prev.port,
          to: port,
          local: p.local,
        });
      }
    }
    let rconPort: number | null = null;
    if (t.rcon.supported) {
      const all = mergeUsed(used, own);
      const keep = row.rconPort;
      rconPort =
        keep !== null && isFree(all, { port: keep, protocol: 'tcp', count: 1 })
          ? keep
          : suggestRconPort(t, all);
      if (rconPort === null) throw new HttpError(409, 'conflict');
    }
    return {
      ports,
      rconPort,
      changed,
      forwardingHint: targetForwardingHint(ports, this.networkOf(serverId)),
    };
  }

  /** compose.yml and .env of the game with other host ports (secrets from the DB). */
  renderWithPorts(
    row: GameServerRow,
    ports: HostPort[],
    rconPort: number | null,
  ): { compose: string; env: string } {
    const l = this.templates.get(row.templateId);
    if (!l) throw new HttpError(409, 'conflict');
    const stored = storedOf(row);
    return this.render(l, {
      name: row.name,
      ports,
      rconPort,
      values: { values: stored.values, secrets: this.secretValues(row) },
      rconPassword: this.rconPassword(row),
    });
  }

  /** game.status of the game as it would run on `serverId` with `ports`. */
  async statusOn(
    row: GameServerRow,
    serverId: string,
    ports: HostPort[],
  ): Promise<GameStatusData | null> {
    return this.queryStatus({ ...row, serverId, portsJson: JSON.stringify(ports) });
  }

  /**
   * The game now lives on `serverId` (same id: share links keep working). The
   * RCON password stays encrypted as it is (AAD is the game id).
   */
  moveTo(id: string, serverId: string, ports: HostPort[], rconPort: number | null): void {
    const prev = this.lastSummary.get(id);
    const before = this.row(id);
    // Asleep on the old server: its listeners go (the game lives on the target now).
    if (before?.sleeping) this.track(this.disarm(before, before.serverId));
    this.deps.db
      .update(gameServers)
      .set({
        serverId,
        portsJson: JSON.stringify(ports),
        rconPort,
        updatedAt: this.deps.now(),
      })
      .where(eq(gameServers.id, id))
      .run();
    this.setRunState(id, 'running');
    // Port list: the target gets the game's ports, the source entries go (its
    // folder stays as a fallback, but nothing of the hub listens there any more).
    if (before) {
      this.syncPorts(serverId, before.name, ports);
      if (before.serverId !== serverId) this.releasePorts(before.serverId, before.name);
    }
    if (prev) this.lastSummary.set(id, { ...prev, serverId });
    this.emit(id);
  }

  /** Marks the game stopped (after the migration stopped it on the target again). */
  markStopped(id: string): void {
    this.setRunState(id, 'stopped');
    this.emit(id);
  }

  // ---- delete ---------------------------------------------------------------------------

  /** Backup first (a missing world folder is fine), then game.remove, then the row. */
  async remove(id: string, confirmName: string): Promise<GameServerRow> {
    const row = this.requireRow(id);
    if (confirmName !== row.name) throw new HttpError(400, 'confirm_mismatch');
    this.lock(row, 'Wird gelöscht');
    try {
      const backup = await this.runBackup(row);
      if (!backup.ok && backup.code !== 'not_found') {
        const offline = backup.code === 'offline' || backup.code === 'disconnected';
        throw new HttpError(offline ? 409 : 502, offline ? 'agent_offline' : 'agent_error');
      }
      await this.disarm(row);
      for (const c of this.containerIds(row)) this.deps.setIntent(c, 'stop');
      try {
        await this.deps.hub.call(
          row.serverId,
          'game.remove',
          { gameDir: gameDirOf(row.name) },
          { timeoutMs: REMOVE_TIMEOUT_MS },
        );
      } catch (err) {
        if (!(err instanceof RpcError && err.code === 'not_found')) throw err;
      }
    } catch (err) {
      this.unlock(id);
      throw err;
    }
    this.deps.db.delete(gameServers).where(eq(gameServers.id, id)).run();
    this.releasePorts(row.serverId, row.name);
    // The backups stay on the server; they are purged 30 days later (purgeDeletedBackups).
    this.deps.db
      .insert(deletedGameBackups)
      .values({
        id: randomToken(12),
        serverId: row.serverId,
        gameId: row.id,
        gameName: row.name,
        deletedAt: this.deps.now(),
        lastAttemptAt: null,
        lastError: null,
      })
      .run();
    this.cleanup(id);
    this.deps.alerts.resolveAllWithPrefix(`game:${id}:`);
    this.emit(id, true);
    return row;
  }

  // ---- M12: restore a backup ------------------------------------------------------------

  /**
   * Restores a backup of this game (route: step-up). The name must match; the
   * backup must be one of the game's own files below /opt/homelab/backups/<name>/
   * (the agent builds the path from gameId + fileName). Runs in the background
   * under the busy lock: fresh backup, stop (or disarm while asleep),
   * game.restore, start again if it ran (or arm again if it slept). Progress on
   * topic game:<id>.
   */
  restore(id: string, backupId: string, confirmName: string): GameSummary {
    const row = this.requireRow(id);
    if (confirmName !== row.name) throw new HttpError(400, 'confirm_mismatch');
    const b = this.deps.db
      .select()
      .from(gameBackups)
      .where(and(eq(gameBackups.id, backupId), eq(gameBackups.gameId, id)))
      .get();
    if (!b) throw new HttpError(404, 'not_found');
    const fileName = basename(b.path);
    if (
      b.path !== `${BACKUPS_ROOT}${row.name}/${fileName}` ||
      !backupFileNameSchema.safeParse(fileName).success
    ) {
      throw new HttpError(409, 'conflict');
    }
    const wasRunning = this.containerOf(row)?.state === 'running';
    this.lock(row, 'Wiederherstellung läuft');
    this.track(
      this.runRestore(row, fileName, wasRunning).finally(() => {
        this.unlock(id);
      }),
    );
    return this.summary(id) as GameSummary;
  }

  private async runRestore(
    row: GameServerRow,
    fileName: string,
    wasRunning: boolean,
  ): Promise<void> {
    const secrets = this.secretsOf(row);
    const wasSleeping = row.sleeping;
    let stopped = false;
    const fail = async (reason: string): Promise<void> => {
      this.event(row.id, 'error', `Wiederherstellung fehlgeschlagen: ${reason}`);
      writeAudit(this.deps.db, this.deps.now(), {
        actor: 'system',
        action: 'game.restore_failed',
        target: row.id,
        details: { name: row.name, file: fileName, reason },
      });
      // The agent keeps the old data on any error: bring the game back as it was.
      if (stopped && wasRunning) await this.restartAfterRestore(row);
      if (wasSleeping) {
        const fresh = this.row(row.id);
        if (fresh) await this.arm({ ...fresh, sleeping: true });
      }
    };
    this.setBusyText(row.id, 'Wiederherstellung: frisches Backup');
    // keep + 1: the fresh backup must not push the restored file out of the folder.
    const backup = await this.runBackup(row, BACKUP_KEEP + 1);
    if (!backup.ok && backup.code !== 'not_found') return fail(backup.reason);
    try {
      if (wasSleeping) await this.disarm(row);
      if (wasRunning) {
        this.setBusyText(row.id, 'Wiederherstellung: wird gestoppt');
        await this.runStop(row);
        stopped = true;
      }
    } catch (err) {
      return fail(rpcReason(err, 'Stoppen', secrets));
    }
    this.setBusyText(row.id, 'Wiederherstellung läuft');
    this.event(row.id, 'progress', `Wiederherstellung von ${fileName}`);
    let stream: RpcStream;
    try {
      stream = this.deps.hub.stream(
        row.serverId,
        'game.restore',
        { gameId: row.name, fileName },
        { timeoutMs: RESTORE_TIMEOUT_MS },
      );
    } catch (err) {
      return fail(rpcReason(err, 'Wiederherstellung', secrets));
    }
    let result: unknown = null;
    let partial = '';
    const onLine = (line: string): void => {
      if (line.startsWith('result ')) {
        try {
          result = JSON.parse(line.slice('result '.length));
        } catch {
          result = null;
        }
        return;
      }
      this.event(row.id, 'progress', translateProgress(scrub(line, secrets)));
    };
    stream.on('data', (c: StreamChunk) => {
      if (c.channel !== 'progress') return;
      const lines = (partial + c.chunk).split('\n');
      partial = (lines.pop() ?? '').slice(-4096);
      for (const line of lines) if (line !== '') onLine(line);
    });
    const end = await stream.done;
    stream.removeAllListeners('data');
    if (partial !== '') onLine(partial);
    if (end.code !== 0) {
      const code = end.error ?? 'failed';
      return fail(
        rpcReason(new RpcError(code as RpcFailure, end.detail ?? ''), 'Wiederherstellung', secrets),
      );
    }
    const done = gameRestoreDoneDataSchema.safeParse(result);
    if (!done.success) return fail('keine gültige Antwort vom Agent');
    this.event(row.id, 'progress', `Wiederhergestellt: ${fileName}`);
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'system',
      action: 'game.restored',
      target: row.id,
      details: { name: row.name, file: fileName, entries: done.data.entries },
    });
    if (wasRunning) await this.restartAfterRestore(row);
    else if (wasSleeping) {
      const fresh = this.row(row.id);
      if (fresh) await this.arm({ ...fresh, sleeping: true });
    }
  }

  private async restartAfterRestore(row: GameServerRow): Promise<void> {
    this.setBusyText(row.id, 'Startet');
    try {
      await this.startLocked(row.id);
      this.pendingOnline.add(row.id);
    } catch (err) {
      this.event(
        row.id,
        'error',
        `Start nach der Wiederherstellung fehlgeschlagen: ${rpcReason(err, 'Start')}`,
      );
    }
  }

  // ---- backups of deleted games (decision 2026-11-26) -------------------------------------

  /** Pending purges, oldest first (tests, diagnostics). */
  deletedBackups() {
    return this.deps.db
      .select()
      .from(deletedGameBackups)
      .orderBy(asc(deletedGameBackups.deletedAt))
      .all();
  }

  /**
   * Daily: asks the agent of every server with deleted games to remove their
   * backups older than 30 days (game.backups.purge). The record is dropped once
   * the agent reported success and the deletion is 30 days old (then every backup
   * of that game is older than 30 days and gone). Offline agent or an error: the
   * next day tries again. If a new game with the same folder name exists on the
   * server, the backup folder belongs to it now: the record is dropped unpurged.
   */
  async purgeDeletedBackups(): Promise<void> {
    if (!this.active) return;
    const now = this.deps.now();
    for (const r of this.deletedBackups()) {
      const reused = this.deps.db
        .select({ id: gameServers.id })
        .from(gameServers)
        .where(and(eq(gameServers.serverId, r.serverId), eq(gameServers.name, r.gameName)))
        .get();
      if (reused || !NAME_RE.test(r.gameName)) {
        this.deps.db.delete(deletedGameBackups).where(eq(deletedGameBackups.id, r.id)).run();
        continue;
      }
      if (!this.deps.hub.isConnected(r.serverId)) continue;
      let removed: number;
      try {
        const data = await this.deps.hub.call(
          r.serverId,
          'game.backups.purge',
          { gameId: r.gameName, olderThanDays: DELETED_BACKUP_DAYS },
          { timeoutMs: PURGE_TIMEOUT_MS },
        );
        const parsed = gameBackupsPurgeDataSchema.safeParse(data);
        if (!parsed.success) throw new RpcError('failed', 'invalid purge result');
        removed = parsed.data.removed;
      } catch (err) {
        this.deps.db
          .update(deletedGameBackups)
          .set({ lastAttemptAt: now, lastError: err instanceof RpcError ? err.code : 'failed' })
          .where(eq(deletedGameBackups.id, r.id))
          .run();
        continue;
      }
      if (removed > 0) {
        writeAudit(this.deps.db, now, {
          actor: 'system',
          action: 'game.backups_purged',
          target: r.gameId,
          details: { name: r.gameName, serverId: r.serverId, removed },
        });
      }
      if (now - r.deletedAt >= DELETED_BACKUP_DAYS * DAY_MS) {
        this.deps.db.delete(deletedGameBackups).where(eq(deletedGameBackups.id, r.id)).run();
      } else {
        this.deps.db
          .update(deletedGameBackups)
          .set({ lastAttemptAt: now, lastError: null })
          .where(eq(deletedGameBackups.id, r.id))
          .run();
      }
    }
  }

  /** Oldest first, for tests. */
  backupRows(gameId: string) {
    return this.deps.db
      .select()
      .from(gameBackups)
      .where(eq(gameBackups.gameId, gameId))
      .orderBy(asc(gameBackups.createdAt))
      .all();
  }
}

const PROTO_LABEL = { tcp: 'TCP', udp: 'UDP', 'tcp+udp': 'TCP+UDP' } as const;

const portRange = (port: number, count: number): string =>
  count > 1 ? `${port}–${port + count - 1}` : String(port);

/**
 * M12: where the ports have to be opened, from the server's network. home: the
 * router; cloud: provider firewall (Security List) and iptables; vps: provider
 * firewall; null / other: the generic text of M6/M11.
 */
function hintPrefix(network: ServerNetwork | null, what: 'change' | 'open'): string {
  switch (network) {
    case 'home':
      return what === 'change'
        ? 'Router: Portweiterleitung anpassen'
        : 'Router: Portweiterleitung am Ziel einrichten';
    case 'cloud':
      return what === 'change'
        ? 'Firewall des Anbieters (z. B. Security List) und iptables auf dem Server anpassen'
        : 'Firewall des Anbieters (z. B. Security List) und iptables auf dem Server öffnen';
    case 'vps':
      return what === 'change'
        ? 'Firewall des Anbieters anpassen'
        : 'Firewall des Anbieters öffnen';
    default:
      return what === 'change'
        ? 'Portweiterleitung anpassen'
        : 'Portweiterleitung am Ziel einrichten';
  }
}

/**
 * M11: "Portweiterleitung am Ziel einrichten: game 25570 (TCP)" for every public
 * port on the new server (the router must forward to the new machine even if
 * the number stayed); null without public ports. M12: the prefix follows the
 * target's network.
 */
export function targetForwardingHint(
  ports: readonly HostPort[],
  network: ServerNetwork | null = null,
): string | null {
  const pub = ports.filter((p) => !p.local);
  if (pub.length === 0) return null;
  const parts = pub.map(
    (p) => `${p.name} ${portRange(p.port, p.count)} (${PROTO_LABEL[p.protocol]})`,
  );
  return `${hintPrefix(network, 'open')}: ${parts.join(', ')}`;
}

/** "Portweiterleitung anpassen: game 25565 → 25570 (TCP)"; null if no public port changed. */
export function forwardingHint(
  changed: GamePortsUpdateResponse['changed'],
  network: ServerNetwork | null = null,
): string | null {
  const pub = changed.filter((c) => !c.local);
  if (pub.length === 0) return null;
  const parts = pub.map(
    (c) =>
      `${c.name} ${portRange(c.from, c.count)} → ${portRange(c.to, c.count)} (${PROTO_LABEL[c.protocol]})`,
  );
  return `${hintPrefix(network, 'change')}: ${parts.join(', ')}`;
}

/**
 * Containers of game <name> on a server: label homelab.game = name, or (without
 * any label) compose dir /opt/homelab/games/<name> or container name game-<name>.
 * `anyOwner`: also containers in that folder or with that name that carry
 * another game's label (a folder that is taken either way).
 */
function gameContainerWhere(serverId: string, name: string, anyOwner = false): SQL | undefined {
  const byPlace = or(
    eq(containers.composeDir, gameDirOf(name)),
    eq(containers.name, `game-${name}`),
  );
  return and(
    eq(containers.serverId, serverId),
    anyOwner
      ? or(eq(containers.gameLabel, name), byPlace)
      : or(eq(containers.gameLabel, name), and(isNull(containers.gameLabel), byPlace)),
  );
}

function mergeUsed(a: UsedPorts, b: UsedPorts): UsedPorts {
  return { tcp: new Set([...a.tcp, ...b.tcp]), udp: new Set([...a.udp, ...b.udp]) };
}

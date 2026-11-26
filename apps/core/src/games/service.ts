import { basename } from 'node:path';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';
import {
  backupDoneDataSchema,
  gameStatusDataSchema,
  homelabPathSchema,
  rconDataSchema,
  type ContainerState,
  type GameStatusData,
  type GameSummary,
  type GameTemplate,
  type ListeningPort,
  type PortMapping,
  type RpcParamsInput,
  type gameBackupSchema,
  type gameCreateRequestSchema,
  type gameEventSchema,
  type gameUpdateRequestSchema,
  type gameTemplateListResponseSchema,
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
import type { Clock } from '../clock.js';
import { randomToken, type SecretBox } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import {
  containers,
  gameBackups,
  gameServers,
  serverState,
  servers,
  type ContainerRow,
  type GameServerRow,
  type ServerRow,
} from '../db/schema.js';
import { clockTime, duration } from '../format.js';
import { HttpError } from '../http/errors.js';
import type { Scheduler } from '../scheduler.js';
import {
  collectUsed,
  isFree,
  markUsed,
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
import type { LoadedTemplate } from './templates.js';

export type GameCreateRequest = z.output<typeof gameCreateRequestSchema>;
export type GameUpdateRequest = z.output<typeof gameUpdateRequestSchema>;
export type GameEvent = z.infer<typeof gameEventSchema>;
export type GameBackup = z.infer<typeof gameBackupSchema>;
export type TemplateInfo = z.infer<typeof gameTemplateListResponseSchema>['templates'][number];

export const GAMES_ROOT = '/opt/homelab/games/';
export const BACKUPS_ROOT = '/opt/homelab/backups/';
export const BACKUP_KEEP = 7;
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

  constructor(private readonly deps: GameServiceDeps) {
    this.templates = deps.templates;
  }

  setPublisher(p: GamePublisher): void {
    this.publisher = p;
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

  row(id: string): GameServerRow | undefined {
    return this.deps.db.select().from(gameServers).where(eq(gameServers.id, id)).get();
  }

  private rows(): GameServerRow[] {
    return this.deps.db.select().from(gameServers).all();
  }

  private serverRow(id: string): ServerRow | undefined {
    return this.deps.db.select().from(servers).where(eq(servers.id, id)).get();
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
    }));
  }

  /** The game's container: compose project in its folder, or container_name game-<name>. */
  private containerOf(row: GameServerRow): ContainerRow | undefined {
    const list = this.deps.db
      .select()
      .from(containers)
      .where(
        and(
          eq(containers.serverId, row.serverId),
          or(
            eq(containers.composeDir, gameDirOf(row.name)),
            eq(containers.name, `game-${row.name}`),
          ),
        ),
      )
      .all();
    return list.find((c) => c.state === 'running') ?? list[0];
  }

  private containerIds(row: GameServerRow): string[] {
    return this.deps.db
      .select({ id: containers.id })
      .from(containers)
      .where(
        and(
          eq(containers.serverId, row.serverId),
          or(
            eq(containers.composeDir, gameDirOf(row.name)),
            eq(containers.name, `game-${row.name}`),
          ),
        ),
      )
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
      statusText: state.statusText,
      players: state.live && status?.players ? status.players : null,
      tps: state.live ? (status?.tps ?? null) : null,
      ramBytes: running ? (c.memBytes ?? null) : null,
      ramLimitBytes: memMatch
        ? Number(memMatch[1]) * (memMatch[2] === 'G' ? 1024 ** 3 : 1024 ** 2)
        : null,
      rcon: tpl?.rcon.supported ?? row.rconSecretEnc !== null,
      autoStopMinutes: row.autoStopMinutes,
      externalAddress: row.externalAddress,
      values,
      lastBackupAt: lastBackup === null ? null : iso(lastBackup),
      createdAt: iso(row.createdAt),
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
    return {
      ports: suggestPorts(l.template, used),
      ...ramCheck(this.freeRam(serverId), l.template.ram.recommended),
    };
  }

  // ---- create ----------------------------------------------------------------------

  private resolvePorts(
    t: GameTemplate,
    serverId: string,
    requested: Record<string, number> | undefined,
  ): { ports: HostPort[]; rconPort: number | null } {
    const names = new Set(t.ports.map((p) => p.name));
    for (const k of Object.keys(requested ?? {})) {
      if (!names.has(k)) throw new HttpError(400, 'invalid_input');
    }
    const used = this.usedPorts(serverId);
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
      .where(
        and(
          eq(containers.serverId, server.id),
          or(eq(containers.composeDir, dir), eq(containers.name, `game-${req.name}`)),
        ),
      )
      .get();
    if (taken || foreign) throw new HttpError(409, 'conflict');
    if (!this.deps.hub.isConnected(server.id)) throw new HttpError(409, 'agent_offline');
    const { ports, rconPort } = this.resolvePorts(t, server.id, req.ports);
    const rconPassword = t.rcon.supported ? randomToken(24) : null;
    const files = this.render(l, { name: req.name, ports, rconPort, values, rconPassword });

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
      throw new HttpError(409, 'conflict');
    }
    this.emit(id);
    const secrets = [...(rconPassword ? [rconPassword] : []), ...Object.values(values.secrets)];
    this.track(this.runSetup(id, server.id, dir, files, secrets));
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
    const rows = this.rows().filter(
      (r) =>
        (r.phase === 'running' || r.phase === 'stopped') &&
        !this.busy.has(r.id) &&
        this.deps.hub.isConnected(r.serverId),
    );
    await Promise.all(
      rows.map(async (row) => {
        if (this.containerOf(row)?.state !== 'running') return;
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
      }),
    );
    this.refreshAll();
  }

  /** Every minute: stop running games that had no players for autoStopMinutes. */
  async autoStopTick(): Promise<void> {
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
        await this.action(row.id, 'stop', 'system');
      } catch {
        continue;
      }
      this.deps.alerts.log(
        `game:${row.id}:autostop`,
        'info',
        `Gameserver ${row.name} automatisch gestoppt`,
        `Seit ${row.autoStopMinutes} Min keine Spieler (${clockTime(now)}).`,
        row.serverId,
        'game',
      );
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
    actor: 'admin' | 'system' = 'admin',
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
    this.lock(row, texts[action]);
    const dir = gameDirOf(row.name);
    const hub = this.deps.hub;
    const cIds = this.containerIds(row);
    try {
      if (action === 'start') {
        for (const c of cIds) this.deps.setIntent(c, null);
        await hub.call(row.serverId, 'compose.up', { dir }, { timeoutMs: UP_TIMEOUT_MS });
        this.setRunState(id, 'running');
      } else if (action === 'stop') {
        for (const c of cIds) this.deps.setIntent(c, 'stop');
        await hub.call(row.serverId, 'compose.down', { dir }, { timeoutMs: DOWN_TIMEOUT_MS });
        this.setRunState(id, 'stopped');
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
      this.unlock(id);
    }
    writeAudit(this.deps.db, this.deps.now(), {
      actor,
      action: `game.${action}`,
      target: id,
      details: { name: row.name, serverId: row.serverId },
    });
    return this.summary(id) as GameSummary;
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
      })
      .where(eq(gameServers.id, id))
      .run();
  }

  private async runBackup(row: GameServerRow): Promise<BackupOutcome> {
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
        { gameDir: gameDirOf(row.name), keep: BACKUP_KEEP },
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
    if (req.values === undefined) {
      if (this.busy.has(id)) throw new HttpError(409, 'busy');
      this.deps.db.update(gameServers).set(set).where(eq(gameServers.id, id)).run();
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
    this.lock(row, 'Einstellungen werden übernommen');
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
      this.unlock(id);
    }
    return this.summary(id) as GameSummary;
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
    this.cleanup(id);
    this.deps.alerts.resolveAllWithPrefix(`game:${id}:`);
    this.emit(id, true);
    return row;
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

function mergeUsed(a: UsedPorts, b: UsedPorts): UsedPorts {
  return { tcp: new Set([...a.tcp, ...b.tcp]), udp: new Set([...a.udp, ...b.udp]) };
}

import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { SAVE_COMMANDS } from '../throttle/service.js';
import type { FastifyBaseLogger } from 'fastify';
import {
  gameImportDoneDataSchema,
  migrationActivePhases,
  migrationSchema,
  MIGRATION_MAX_BYTES,
  type GameMigrateRequest,
  type Migration,
  type MigrationErrorCode,
  type MigrationPhase,
  type MigrationSuggestResponse,
  type TransferBegin,
} from '@hz/shared';
import { RpcError, type AgentHub, type RpcStream, type StreamEndInfo } from '../agents/hub.js';
import { TransferRelay, type RelayFailure } from '../agents/transfer.js';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import {
  gameMigrations,
  gameServers,
  servers,
  type GameMigrationRow,
  type GameServerRow,
} from '../db/schema.js';
import { HttpError } from '../http/errors.js';
import type { Scheduler } from '../scheduler.js';
import type { HostPort } from './render.js';
import { BACKUP_TIMEOUT_MS, gameDirOf, SETUP_TIMEOUT_MS, type GameService } from './service.js';

/**
 * M11: moving a game server to another server (ROADMAP M11, contract in
 * packages/shared/src/api/migrate.ts, transfer frames in agent-protocol.ts).
 *
 * Phases: backup -> transfer -> restore -> start -> stop_old -> done | failed.
 *
 * Data safety (decision 2026-11-26, docs/QUESTIONS.md; overrides the contract
 * note "the game keeps running"):
 * - Before the backup the world is saved via RCON (same save commands as the
 *   M10 auto-stop) and the source game is STOPPED with the normal stop path
 *   (compose down). Nothing written after the archive can get lost.
 * - The archive (game.export, only data/) is relayed chunk by chunk through the
 *   core (agents/transfer.ts: ack window, bounded memory, idle timeout, max
 *   bytes, sha256 recomputed in the core) into game.import on the target.
 * - restore: the target verified and extracted data/; the core writes
 *   compose.yml/.env with the ports for the target (the RCON password stays as
 *   it is in the DB, encrypted under the game id).
 * - start: RAM reserve check (M10) on the target, compose up, wait until the
 *   game answers (game.status). Then the game record switches to the target
 *   (same id: share links keep working). A game that was stopped before is
 *   stopped again on the target after the check.
 * - stop_old: the source is already stopped; its folder stays as a fallback.
 * - Failure before the target start succeeded: the target copy is removed
 *   (game.remove, only if game.import was accepted, so a foreign folder is never
 *   touched) and the source is started again if it ran before. Otherwise the
 *   source is unchanged. Steps that cannot run (agent offline, core restart)
 *   are retried by the job `games.migrateCleanup` while the agent is connected.
 * - A core restart marks a running migration failed (`interrupted`) with the
 *   same rollback.
 *
 * Only folder names (gameId = folder name) go to the agents, never paths from
 * the wire. One migration per game and per target server at a time.
 */

const BEGIN_TIMEOUT_MS = BACKUP_TIMEOUT_MS;
const IMPORT_ACCEPT_TIMEOUT_MS = 60_000;
const EXPORT_END_TIMEOUT_MS = 60_000;
const IMPORT_DONE_TIMEOUT_MS = 2 * 60 * 60_000;
const WRITE_TIMEOUT_MS = 60_000;
const UP_TIMEOUT_MS = 10 * 60_000;
const DOWN_TIMEOUT_MS = 5 * 60_000;
const REMOVE_TIMEOUT_MS = 5 * 60_000;
const START_TIMEOUT_MS = SETUP_TIMEOUT_MS;
const START_POLL_MS = 3_000;
const CLEANUP_EVERY_MS = 15_000;
const PERSIST_EVERY_MS = 1_000;
/** cancel waits this long for the rollback before it answers. */
const CANCEL_WAIT_MS = 10_000;

const ERROR_TEXT: Record<MigrationErrorCode, string> = {
  agent_offline: 'Agent offline oder Verbindung verloren',
  export_failed: 'Backup am alten Server fehlgeschlagen',
  too_large: 'Archiv zu groß (höchstens 50 GB)',
  checksum_mismatch: 'Prüfsumme stimmt nicht, Übertragung verworfen',
  bad_archive: 'Archiv enthält unerlaubte Einträge',
  target_exists: 'Am Ziel gibt es diesen Spielordner schon',
  restore_failed: 'Wiederherstellen am Ziel fehlgeschlagen',
  start_failed: 'Start am Ziel fehlgeschlagen',
  stop_old_failed: 'Alter Server konnte nicht gestoppt werden',
  timeout: 'Zeitüberschreitung',
  cancelled: 'Abgebrochen',
  interrupted: 'Zentrale wurde während des Umzugs neu gestartet',
  insufficient_ram: 'Zu wenig RAM am Ziel',
  stop_failed: 'Alter Server konnte vor dem Backup nicht gestoppt werden',
};

const PHASE_TEXT: Record<MigrationPhase, string> = {
  backup: 'Umzug: Backup',
  transfer: 'Umzug: Übertragung',
  restore: 'Umzug: Wiederherstellen',
  start: 'Umzug: Start am Ziel',
  stop_old: 'Umzug: Abschluss',
  done: 'Umzug fertig',
  failed: 'Umzug fehlgeschlagen',
};

type RunningPhase = Exclude<MigrationPhase, 'done' | 'failed'>;

class Failure extends Error {
  constructor(readonly code: MigrationErrorCode) {
    super(code);
    this.name = 'MigrationFailure';
  }
}

interface Active {
  id: string;
  gameId: string;
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
  wasRunning: boolean;
  phase: RunningPhase;
  ports: HostPort[];
  rconPort: number | null;
  relay: TransferRelay;
  exportStream: RpcStream | null;
  importStream: RpcStream | null;
  failure: Failure | null;
  fail: (code: MigrationErrorCode) => void;
  aborted: Promise<never>;
  targetTouched: boolean;
  switched: boolean;
  /** Agent call in flight (rollback waits for it). */
  inflight: Promise<unknown> | null;
  done: Promise<void>;
  bytesTotal: number;
  lastPersist: number;
  lastPct: number;
}

export interface MigrationDeps {
  db: Db;
  now: Clock;
  hub: Pick<AgentHub, 'call' | 'stream' | 'isConnected' | 'sendTransfer'>;
  games: GameService;
  scheduler: Scheduler;
  log: FastifyBaseLogger;
  /** After the game moved (M10: drop throttle state that belonged to the old server). */
  onMoved?: (gameId: string) => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms).unref();
  });

const iso = (ms: number): string => new Date(ms).toISOString();

function parse<T>(json: string | null): T | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** stream.end of game.export -> migration error. */
function exportError(info: StreamEndInfo): MigrationErrorCode {
  switch (info.error) {
    case 'disconnected':
    case 'offline':
      return 'agent_offline';
    case 'too_large':
    case 'checksum_mismatch':
    case 'bad_archive':
    case 'timeout':
    case 'cancelled':
      return info.error;
    default:
      return 'export_failed';
  }
}

/** stream.end (or refusal) of game.import -> migration error. */
function importError(info: StreamEndInfo): MigrationErrorCode {
  switch (info.error) {
    case 'disconnected':
    case 'offline':
      return 'agent_offline';
    case 'busy':
    case 'exists':
      return 'target_exists';
    case 'too_large':
    case 'checksum_mismatch':
    case 'bad_archive':
    case 'timeout':
    case 'cancelled':
      return info.error;
    default:
      return 'restore_failed';
  }
}

function relayError(r: RelayFailure): MigrationErrorCode {
  // `sequence`: the source broke the protocol (gap, wrong size, ignored the window).
  return r === 'sequence' ? 'export_failed' : r;
}

/** Resolves once the agent accepted the stream (rpc.result ok); rejects if it ended first. */
function accepted(stream: RpcStream, onEnd: (info: StreamEndInfo) => Failure): Promise<void> {
  return new Promise((resolve, reject) => {
    void stream.result.then(() => {
      if (!stream.isEnded) resolve();
    });
    void stream.done.then((info) => reject(onEnd(info)));
  });
}

/**
 * Game migrations: start, progress, cancel, rollback, recovery after restart.
 */
export class MigrationService {
  private readonly active = new Map<string, Active>();
  private readonly background = new Set<Promise<unknown>>();
  private cleaning = false;
  private stopping = false;

  constructor(private readonly deps: MigrationDeps) {}

  /** Marks migrations of a previous process failed and registers the cleanup job. */
  start(): void {
    this.recoverAfterRestart();
    this.deps.scheduler.every('games.migrateCleanup', CLEANUP_EVERY_MS, () => this.cleanupTick());
  }

  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /**
   * Core shutdown: aborts running migrations. Their rollback does not call the
   * agents any more; the steps stay pending and are retried after the restart.
   */
  shutdown(): void {
    this.stopping = true;
    for (const a of this.active.values()) a.fail('interrupted');
  }

  // ---- reads ------------------------------------------------------------------------

  private rowOf(id: string): GameMigrationRow | undefined {
    return this.deps.db.select().from(gameMigrations).where(eq(gameMigrations.id, id)).get();
  }

  latest(gameId: string): Migration | null {
    const row = this.deps.db
      .select()
      .from(gameMigrations)
      .where(eq(gameMigrations.gameId, gameId))
      .orderBy(desc(gameMigrations.startedAt), desc(gameMigrations.updatedAt))
      .limit(1)
      .get();
    return row ? this.toApi(row) : null;
  }

  private toApi(r: GameMigrationRow): Migration {
    const ports = parse<HostPort[]>(r.portsJson) ?? [];
    return migrationSchema.parse({
      id: r.id,
      gameId: r.gameId,
      sourceServerId: r.sourceServerId,
      sourceServerName: r.sourceServerName,
      targetServerId: r.targetServerId,
      targetServerName: r.targetServerName,
      phase: r.phase,
      failedPhase: r.phase === 'failed' ? r.failedPhase : null,
      progress: { bytesDone: r.bytesDone, bytesTotal: r.bytesTotal },
      sha256: r.sha256,
      error: r.error,
      errorText: r.errorText,
      rollback: r.rollback,
      ports: ports.map((p) => ({
        name: p.name,
        port: p.port,
        protocol: p.protocol,
        count: p.count,
        local: p.local ?? false,
      })),
      forwardingHint: r.forwardingHint,
      startedAt: iso(r.startedAt),
      updatedAt: iso(r.updatedAt),
      finishedAt: r.finishedAt === null ? null : iso(r.finishedAt),
    });
  }

  private serverName(id: string): string | null {
    return (
      this.deps.db.select({ name: servers.name }).from(servers).where(eq(servers.id, id)).get()
        ?.name ?? null
    );
  }

  private game(id: string): GameServerRow {
    const row = this.deps.games.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  }

  // ---- suggest ----------------------------------------------------------------------

  suggest(gameId: string, targetServerId: string): MigrationSuggestResponse {
    const row = this.game(gameId);
    if (this.serverName(targetServerId) === null) throw new HttpError(404, 'not_found');
    if (targetServerId === row.serverId) throw new HttpError(400, 'invalid_input');
    const plan = this.deps.games.planPorts(row, targetServerId, undefined);
    const ram = this.deps.games.suggest(row.templateId, targetServerId);
    let ramWarning = ram.ramWarning;
    try {
      this.deps.games.checkRamOn(row, targetServerId);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'insufficient_ram') {
        ramWarning = err.userMessage ?? ERROR_TEXT.insufficient_ram;
      } else throw err;
    }
    return {
      ports: Object.fromEntries(plan.ports.map((p) => [p.name, p.port])),
      changed: plan.changed,
      forwardingHint: plan.forwardingHint,
      freeRamBytes: ram.freeRamBytes,
      ramWarning,
    };
  }

  // ---- start ------------------------------------------------------------------------

  private pendingCleanup(gameId: string): boolean {
    return (
      this.deps.db
        .select({ id: gameMigrations.id })
        .from(gameMigrations)
        .where(
          and(
            eq(gameMigrations.gameId, gameId),
            or(eq(gameMigrations.cleanupTarget, true), eq(gameMigrations.restartSource, true)),
          ),
        )
        .get() !== undefined
    );
  }

  /** Validates and starts a migration in the background. Returns its id. */
  begin(gameId: string, req: GameMigrateRequest): string {
    const games = this.deps.games;
    const row = this.game(gameId);
    const targetId = req.targetServerId;
    if (targetId === row.serverId) throw new HttpError(400, 'invalid_input');
    const targetName = this.serverName(targetId);
    const sourceName = this.serverName(row.serverId);
    if (targetName === null || sourceName === null) throw new HttpError(404, 'not_found');
    if (this.active.has(gameId) || this.pendingCleanup(gameId)) throw new HttpError(409, 'busy');
    for (const a of this.active.values()) {
      if (a.targetId === targetId) throw new HttpError(409, 'busy');
    }
    if (row.phase === 'setup') throw new HttpError(409, 'busy');
    if (row.phase === 'failed') throw new HttpError(409, 'conflict');
    if (!this.deps.hub.isConnected(row.serverId) || !this.deps.hub.isConnected(targetId)) {
      throw new HttpError(409, 'agent_offline');
    }
    if (games.folderTakenOn(row, targetId)) throw new HttpError(409, 'conflict');
    const plan = games.planPorts(row, targetId, req.ports);
    games.checkRamOn(row, targetId);
    // Takes the busy lock (409 busy while an action, backup or setup runs).
    games.lockForMigration(gameId, PHASE_TEXT.backup);

    const id = randomToken(12);
    const now = this.deps.now();
    const wasRunning = games.isRunning(gameId);
    this.deps.db
      .insert(gameMigrations)
      .values({
        id,
        gameId,
        gameName: row.name,
        sourceServerId: row.serverId,
        sourceServerName: sourceName,
        targetServerId: targetId,
        targetServerName: targetName,
        phase: 'backup',
        portsJson: JSON.stringify(plan.ports),
        rconPort: plan.rconPort,
        forwardingHint: plan.forwardingHint,
        wasRunning,
        startedAt: now,
        updatedAt: now,
      })
      .run();

    let fail!: (code: MigrationErrorCode) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      fail = (code) => {
        if (a.failure) return;
        a.failure = new Failure(code);
        reject(a.failure);
      };
    });
    aborted.catch(() => undefined);
    const a: Active = {
      id,
      gameId,
      sourceId: row.serverId,
      targetId,
      sourceName,
      targetName,
      wasRunning,
      phase: 'backup',
      ports: plan.ports,
      rconPort: plan.rconPort,
      relay: new TransferRelay({
        maxBytes: MIGRATION_MAX_BYTES,
        onFail: (r) => a.fail(relayError(r)),
        onProgress: (bytes) => this.progress(a, bytes),
      }),
      exportStream: null,
      importStream: null,
      failure: null,
      fail: (code) => fail(code),
      aborted,
      targetTouched: false,
      switched: false,
      inflight: null,
      done: Promise.resolve(),
      bytesTotal: 0,
      lastPersist: 0,
      lastPct: -1,
    };
    this.active.set(gameId, a);
    writeAudit(this.deps.db, now, {
      actor: 'admin',
      action: 'game.migrate_started',
      target: gameId,
      details: {
        name: row.name,
        migrationId: id,
        source: row.serverId,
        target: targetId,
        ports: plan.ports.map((p) => ({ name: p.name, port: p.port })),
      },
    });
    this.deps.games.pushEvent(gameId, 'progress', `Umzug nach ${targetName} gestartet`);
    a.done = this.track(this.run(a));
    return id;
  }

  private track(p: Promise<void>): Promise<void> {
    const tracked = p.catch((err: unknown) => this.logError(err, 'migration task failed'));
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
    return tracked;
  }

  private logError(err: unknown, msg: string): void {
    this.deps.log.error(
      { err: err instanceof Error ? { name: err.name, stack: err.stack } : 'error' },
      msg,
    );
  }

  // ---- cancel -----------------------------------------------------------------------

  async cancel(gameId: string): Promise<Migration | null> {
    this.game(gameId);
    const a = this.active.get(gameId);
    if (!a || (a.phase !== 'backup' && a.phase !== 'transfer' && a.phase !== 'restore')) {
      throw new HttpError(409, 'conflict');
    }
    a.fail('cancelled');
    await Promise.race([a.done, sleep(CANCEL_WAIT_MS)]);
    return this.latest(gameId);
  }

  // ---- run --------------------------------------------------------------------------

  private save(a: Pick<Active, 'id'>, set: Partial<GameMigrationRow>): void {
    this.deps.db
      .update(gameMigrations)
      .set({ ...set, updatedAt: this.deps.now() })
      .where(eq(gameMigrations.id, a.id))
      .run();
  }

  private setPhase(a: Active, phase: RunningPhase, set: Partial<GameMigrationRow> = {}): void {
    a.phase = phase;
    this.save(a, { ...set, phase });
    this.deps.games.setBusyText(a.gameId, PHASE_TEXT[phase]);
    this.deps.games.pushEvent(a.gameId, 'progress', PHASE_TEXT[phase]);
  }

  private progress(a: Active, bytes: number): void {
    const total = a.bytesTotal;
    const pct = total > 0 ? Math.floor((bytes / total) * 100) : 100;
    const now = Date.now();
    if (now - a.lastPersist >= PERSIST_EVERY_MS || bytes === total) {
      a.lastPersist = now;
      this.save(a, { bytesDone: bytes });
    }
    const step = Math.floor(pct / 10) * 10;
    if (step > a.lastPct) {
      a.lastPct = step;
      const text = `${PHASE_TEXT.transfer} ${step} %`;
      this.deps.games.setBusyText(a.gameId, text);
      this.deps.games.pushEvent(a.gameId, 'progress', text);
    }
  }

  /** Races `p` against a failure of the migration and an optional timeout. */
  private wait<T>(a: Active, p: Promise<T>, timeoutMs: number | null): Promise<T> {
    const racers: Promise<T>[] = [p, a.aborted];
    if (timeoutMs !== null) {
      racers.push(
        sleep(timeoutMs).then(() => {
          a.fail('timeout');
          return a.aborted;
        }),
      );
    }
    return Promise.race(racers);
  }

  /** An agent call that fails the migration with `code` (offline: agent_offline). */
  private async step(
    a: Active,
    code: MigrationErrorCode,
    call: () => Promise<unknown>,
  ): Promise<unknown> {
    const p = call();
    a.inflight = p;
    try {
      return await this.wait(
        a,
        p.catch((err: unknown) => {
          const offline =
            err instanceof RpcError && (err.code === 'offline' || err.code === 'disconnected');
          if (offline) a.fail('agent_offline');
          else if (err instanceof RpcError && err.code === 'timeout') a.fail('timeout');
          else a.fail(code);
          return a.aborted;
        }),
        null,
      );
    } finally {
      a.inflight = null;
    }
  }

  private async run(a: Active): Promise<void> {
    const games = this.deps.games;
    const hub = this.deps.hub;
    const row = this.game(a.gameId);
    const dir = gameDirOf(row.name);
    try {
      // backup: save, stop the source, then export.
      if (a.wasRunning) {
        const save = SAVE_COMMANDS[row.templateId];
        if (save && games.hasRcon(a.gameId)) {
          try {
            await this.wait(a, games.rcon(a.gameId, save), null);
          } catch (err) {
            if (err instanceof Failure) throw err;
            // Not fatal: compose down lets the game save on SIGTERM.
          }
        }
        await this.step(a, 'stop_failed', () => games.stopLocked(a.gameId));
      }
      const exportStream = this.openStream(a, 'export', () =>
        hub.stream(
          a.sourceId,
          'game.export',
          { gameId: row.name, maxBytes: MIGRATION_MAX_BYTES },
          { onTransfer: (f) => a.relay.fromSource(f) },
        ),
      );
      a.relay.attachSource(exportStream.id, (f) => hub.sendTransfer(a.sourceId, f));
      void exportStream.done.then((info) => {
        if (info.code !== 0) a.fail(exportError(info));
        // stream.end 0 before a verified transfer.end: the archive is incomplete.
        else if (!a.relay.sourceComplete) a.fail('export_failed');
      });
      const begin: TransferBegin = await this.wait(a, a.relay.begun, BEGIN_TIMEOUT_MS);

      // transfer
      a.bytesTotal = begin.bytes;
      this.setPhase(a, 'transfer', { bytesTotal: begin.bytes, sha256: begin.sha256 });
      this.checkTargetRam(a, row);
      const importStream = this.openStream(a, 'import', () =>
        hub.stream(
          a.targetId,
          'game.import',
          { gameId: row.name, bytes: begin.bytes, sha256: begin.sha256, chunks: begin.chunks },
          { onTransfer: (f) => a.relay.fromTarget(f) },
        ),
      );
      let importResult: unknown = null;
      let partial = '';
      importStream.on('data', (c: { channel: string; chunk: string }) => {
        if (c.channel !== 'progress') return;
        const lines = (partial + c.chunk).split('\n');
        partial = (lines.pop() ?? '').slice(-4096);
        for (const line of lines) if (line.startsWith('result ')) importResult = parseResult(line);
      });
      await this.wait(
        a,
        accepted(importStream, (info) => new Failure(importError(info))).catch((err: unknown) => {
          a.fail(err instanceof Failure ? err.code : 'restore_failed');
          return a.aborted;
        }),
        IMPORT_ACCEPT_TIMEOUT_MS,
      );
      a.targetTouched = true;
      this.save(a, { targetTouched: true });
      void importStream.done.then((info) => {
        if (info.code !== 0) a.fail(importError(info));
      });
      a.relay.attachTarget(importStream.id, (f) => hub.sendTransfer(a.targetId, f));
      const verified = await this.wait(a, a.relay.sourceDone, null);
      await this.wait(a, a.relay.allAcked, null);
      this.save(a, { bytesDone: verified.bytes });

      // restore: target verifies and extracts; the source ends its stream.
      this.setPhase(a, 'restore');
      await this.wait(a, exportStream.done, EXPORT_END_TIMEOUT_MS);
      const end = await this.wait(a, importStream.done, IMPORT_DONE_TIMEOUT_MS);
      if (end.code !== 0) throw new Failure(importError(end));
      if (partial.startsWith('result ')) importResult = parseResult(partial);
      const result = gameImportDoneDataSchema.safeParse(importResult);
      if (!result.success) throw new Failure('restore_failed');
      if (result.data.bytes !== verified.bytes || result.data.sha256 !== verified.sha256) {
        throw new Failure('checksum_mismatch');
      }
      const files = games.renderWithPorts(row, a.ports, a.rconPort);
      await this.step(a, 'restore_failed', () =>
        hub.call(
          a.targetId,
          'compose.write',
          { dir, files: { 'compose.yml': files.compose, '.env': files.env } },
          { timeoutMs: WRITE_TIMEOUT_MS },
        ),
      );

      // start
      this.setPhase(a, 'start');
      this.checkTargetRam(a, row);
      await this.step(a, 'start_failed', () =>
        hub.call(a.targetId, 'compose.up', { dir }, { timeoutMs: UP_TIMEOUT_MS }),
      );
      await this.waitOnline(a, row);

      // The game lives on the target from here on.
      games.moveTo(a.gameId, a.targetId, a.ports, a.rconPort);
      a.switched = true;
      this.deps.onMoved?.(a.gameId);
      if (!a.wasRunning) {
        try {
          await hub.call(a.targetId, 'compose.down', { dir }, { timeoutMs: DOWN_TIMEOUT_MS });
          games.markStopped(a.gameId);
        } catch (err) {
          this.logError(err, 'stop after migration check');
        }
      }

      // stop_old: the source was stopped before the backup; its folder stays.
      this.setPhase(a, 'stop_old');
      this.finish(a, {
        phase: 'done',
        rollback: `Der alte Ordner auf ${a.sourceName} bleibt als Rückfall erhalten.`,
      });
      writeAudit(this.deps.db, this.deps.now(), {
        actor: 'system',
        action: 'game.migrate_done',
        target: a.gameId,
        details: {
          name: row.name,
          migrationId: a.id,
          source: a.sourceId,
          target: a.targetId,
          bytes: verified.bytes,
        },
      });
      games.pushEvent(a.gameId, 'ready', `Umzug nach ${a.targetName} fertig`);
    } catch (err) {
      if (!(err instanceof Failure)) this.logError(err, 'migration step failed');
      const f = a.failure ?? (err instanceof Failure ? err : new Failure('restore_failed'));
      if (!a.failure) a.fail(f.code);
      if (a.switched) {
        // After the switch nothing is rolled back; the game runs on the target.
        this.finish(a, { phase: 'done', rollback: null });
      } else {
        await this.rollback(a, row, f.code);
      }
    } finally {
      a.relay.dispose();
      this.active.delete(a.gameId);
      this.deps.games.unlockMigration(a.gameId);
    }
  }

  private openStream(a: Active, kind: 'export' | 'import', open: () => RpcStream): RpcStream {
    let s: RpcStream;
    try {
      s = open();
    } catch (err) {
      const offline = err instanceof RpcError && err.code === 'offline';
      throw new Failure(
        offline ? 'agent_offline' : kind === 'export' ? 'export_failed' : 'restore_failed',
      );
    }
    if (kind === 'export') a.exportStream = s;
    else a.importStream = s;
    return s;
  }

  private checkTargetRam(a: Active, row: GameServerRow): void {
    try {
      this.deps.games.checkRamOn(row, a.targetId);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'insufficient_ram') {
        throw new Failure('insufficient_ram');
      }
      throw err;
    }
  }

  /** Polls game.status on the target until it answers (no query method: compose up is enough). */
  private async waitOnline(a: Active, row: GameServerRow): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      if (a.failure) throw a.failure;
      try {
        const st = await this.wait(a, this.deps.games.statusOn(row, a.targetId, a.ports), null);
        if (st === null || st.online) return;
      } catch (err) {
        if (err instanceof Failure) throw err;
        if (err instanceof RpcError && (err.code === 'offline' || err.code === 'disconnected')) {
          throw new Failure('agent_offline');
        }
      }
      if (Date.now() > deadline) throw new Failure('start_failed');
      await this.wait(a, sleep(START_POLL_MS), null);
    }
  }

  private finish(
    a: Pick<Active, 'id'>,
    set: Partial<GameMigrationRow> & { phase: 'done' | 'failed' },
  ): void {
    this.save(a, { ...set, finishedAt: this.deps.now() });
  }

  // ---- rollback ---------------------------------------------------------------------

  private async rollback(a: Active, row: GameServerRow, code: MigrationErrorCode): Promise<void> {
    const failedPhase = a.phase;
    a.relay.dispose();
    a.exportStream?.cancel();
    a.importStream?.cancel();
    if (a.inflight) await Promise.allSettled([a.inflight]);
    const games = this.deps.games;
    this.deps.log.info({ gameId: a.gameId, code, phase: failedPhase }, 'migration failed');
    games.pushEvent(a.gameId, 'error', `${PHASE_TEXT.failed}: ${ERROR_TEXT[code]}`);
    const cleanupTarget =
      a.targetTouched && (this.stopping || !(await this.removeTarget(a.targetId, row)));
    const restartSource = a.wasRunning && (this.stopping || !(await this.restartSource(a.gameId)));
    const rollback = rollbackText({
      touched: a.targetTouched,
      cleanupPending: cleanupTarget,
      wasRunning: a.wasRunning,
      restartPending: restartSource,
      sourceName: a.sourceName,
      targetName: a.targetName,
    });
    this.finish(a, {
      phase: 'failed',
      failedPhase,
      error: code,
      errorText: ERROR_TEXT[code],
      rollback,
      cleanupTarget,
      restartSource,
    });
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'system',
      action: 'game.migrate_failed',
      target: a.gameId,
      details: {
        name: row.name,
        migrationId: a.id,
        source: a.sourceId,
        target: a.targetId,
        phase: failedPhase,
        error: code,
        bytes: a.relay.bytesDone,
      },
    });
  }

  /** game.remove of the copy on the target. True when done (or nothing there). */
  private async removeTarget(targetId: string, row: GameServerRow): Promise<boolean> {
    const current = this.deps.games.row(row.id);
    // Never remove the folder of the live game or of another game with that name
    // (containers of our own copy on the target do not block the removal).
    if (!current || current.serverId === targetId) return true;
    if (this.gameNamedOn(current.name, targetId)) return true;
    if (!this.deps.hub.isConnected(targetId)) return false;
    try {
      await this.deps.hub.call(
        targetId,
        'game.remove',
        { gameDir: gameDirOf(current.name) },
        { timeoutMs: REMOVE_TIMEOUT_MS },
      );
      return true;
    } catch (err) {
      if (err instanceof RpcError && err.code === 'not_found') return true;
      this.logError(err, 'migration: remove target copy');
      return false;
    }
  }

  private gameNamedOn(name: string, serverId: string): boolean {
    return (
      this.deps.db
        .select({ id: gameServers.id })
        .from(gameServers)
        .where(and(eq(gameServers.serverId, serverId), eq(gameServers.name, name)))
        .get() !== undefined
    );
  }

  /** Starts the source game again. True when done (or no longer needed). */
  private async restartSource(gameId: string): Promise<boolean> {
    const games = this.deps.games;
    const row = games.row(gameId);
    if (!row) return true;
    if (games.isRunning(gameId)) return true;
    if (!this.deps.hub.isConnected(row.serverId)) return false;
    try {
      if (games.isBusy(gameId)) await games.startLocked(gameId);
      else await games.action(gameId, 'start', 'system');
      return true;
    } catch (err) {
      // insufficient_ram and other refusals: the admin starts it by hand.
      if (err instanceof HttpError) return true;
      this.logError(err, 'migration: restart source');
      return false;
    }
  }

  // ---- restart and retries ------------------------------------------------------------

  private recoverAfterRestart(): void {
    const rows = this.deps.db
      .select()
      .from(gameMigrations)
      .where(inArray(gameMigrations.phase, [...migrationActivePhases]))
      .all();
    const now = this.deps.now();
    for (const r of rows) {
      const game = this.deps.games.row(r.gameId);
      if (game && game.serverId === r.targetServerId) {
        // The switch happened; only the final bookkeeping was lost.
        this.finish(r, { phase: 'done', rollback: null });
        continue;
      }
      const cleanupTarget = r.targetTouched;
      const restartSource = r.wasRunning;
      this.finish(r, {
        phase: 'failed',
        failedPhase: r.phase,
        error: 'interrupted',
        errorText: ERROR_TEXT.interrupted,
        rollback: rollbackText({
          touched: cleanupTarget,
          cleanupPending: cleanupTarget,
          wasRunning: restartSource,
          restartPending: restartSource,
          sourceName: r.sourceServerName,
          targetName: r.targetServerName,
        }),
        cleanupTarget,
        restartSource,
      });
      writeAudit(this.deps.db, now, {
        actor: 'system',
        action: 'game.migrate_failed',
        target: r.gameId,
        details: {
          name: r.gameName,
          migrationId: r.id,
          source: r.sourceServerId,
          target: r.targetServerId,
          phase: r.phase,
          error: 'interrupted',
          bytes: r.bytesDone,
        },
      });
    }
  }

  /** Retries rollback steps that could not run (agent offline, core restart). */
  async cleanupTick(): Promise<void> {
    if (this.cleaning || !this.deps.games.enabled) return;
    this.cleaning = true;
    try {
      const rows = this.deps.db
        .select()
        .from(gameMigrations)
        .where(
          and(
            eq(gameMigrations.phase, 'failed'),
            or(eq(gameMigrations.cleanupTarget, true), eq(gameMigrations.restartSource, true)),
          ),
        )
        .all();
      for (const r of rows) {
        if (this.active.has(r.gameId)) continue;
        const game = this.deps.games.row(r.gameId);
        let cleanupTarget = r.cleanupTarget;
        let restartSource = r.restartSource;
        if (!game) {
          cleanupTarget = false;
          restartSource = false;
        } else {
          if (cleanupTarget) cleanupTarget = !(await this.removeTarget(r.targetServerId, game));
          if (restartSource && !this.deps.games.isBusy(r.gameId)) {
            restartSource =
              game.serverId === r.sourceServerId ? !(await this.restartSource(r.gameId)) : false;
          }
        }
        if (cleanupTarget === r.cleanupTarget && restartSource === r.restartSource) continue;
        this.save(r, {
          cleanupTarget,
          restartSource,
          rollback: rollbackText({
            touched: r.targetTouched,
            cleanupPending: cleanupTarget,
            wasRunning: r.wasRunning,
            restartPending: restartSource,
            sourceName: r.sourceServerName,
            targetName: r.targetServerName,
          }),
        });
      }
    } finally {
      this.cleaning = false;
    }
  }
}

function parseResult(line: string): unknown {
  try {
    return JSON.parse(line.slice('result '.length));
  } catch {
    return null;
  }
}

/** German rollback sentence (fixed texts, server names from the DB). */
export function rollbackText(s: {
  touched: boolean;
  cleanupPending: boolean;
  wasRunning: boolean;
  restartPending: boolean;
  sourceName: string;
  targetName: string;
}): string {
  const parts: string[] = [];
  if (s.touched) {
    parts.push(
      s.cleanupPending
        ? `Die Kopie auf ${s.targetName} wird entfernt, sobald der Server verbunden ist.`
        : `Die Kopie auf ${s.targetName} wurde entfernt.`,
    );
  }
  if (s.wasRunning) {
    parts.push(
      s.restartPending
        ? `Der alte Server ${s.sourceName} wird wieder gestartet, sobald er verbunden ist.`
        : `Der alte Server ${s.sourceName} ist unverändert und läuft wieder.`,
    );
  } else {
    parts.push(`Der alte Server ${s.sourceName} ist unverändert.`);
  }
  return parts.join(' ').slice(0, 300);
}

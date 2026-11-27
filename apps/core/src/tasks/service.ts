import { and, asc, desc, eq, lte, notInArray, sql } from 'drizzle-orm';
import {
  cleanupResponseSchema,
  taskActionPublicSchema,
  taskAlertKey,
  taskExecDataSchema,
  taskRunSchema,
  taskScheduleSchema,
  taskSchema,
  TASK_LIMIT_PER_SERVER,
  TASK_LIMIT_TOTAL,
  TASK_RUNS_KEEP,
  type Task,
  type TaskAction,
  type TaskActionPublic,
  type TaskKind,
  type TaskRun,
  type TaskRunState,
  type TaskSchedule,
} from '@hz/shared';
import { RpcError } from '../agents/hub.js';
import { managedComposeDir } from '../containers/service.js';
import { INTENT_TTL_MS } from '../containers/status.js';
import { deriveSubkey, hmacSha256Hex, randomToken } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import {
  containers,
  scheduledTasks,
  servers,
  taskRuns,
  type ContainerRow,
  type ScheduledTaskRow,
  type TaskRunRow,
} from '../db/schema.js';
import type { FeatureContext } from '../features.js';
import { clockTime, gigabytes } from '../format.js';
import { HttpError } from '../http/errors.js';
import { isProtected } from '../throttle/service.js';
import { nextTaskRun } from './schedule.js';

export const COMMAND_AAD = 'scheduled_tasks.command';
/** HKDF context of the key for commandHash (keyed, so short commands cannot be guessed). */
export const COMMAND_HASH_INFO = 'scheduled_tasks.command_hash';
/** Scheduler tick of the tasks module. */
export const TASKS_TICK_MS = 15_000;
/** A run due longer ago than this (core down, module off) is not caught up. */
export const MISSED_GRACE_MS = 2 * 60_000;

const MIN = 60_000;
const ACTION_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 15 * MIN;
const UP_TIMEOUT_MS = 10 * MIN;
const CLEANUP_TIMEOUT_MS = 15 * MIN;
/** After a restart/update returns, a short grace for the last state changes. */
const SETTLE_MS = 60_000;
/** Longest output kept per run (characters, taskRunSchema). */
const OUTPUT_KEEP = 32 * 1024;

/**
 * Fixed German messages for refusals. The error codes are generic ones of
 * errorCodeSchema (there is no `not_supported` / `protected` code, see report).
 */
export const MSG_NOT_SUPPORTED = 'Der Agent erlaubt keine Befehle (HZ_AGENT_ALLOW_TASKS=1 fehlt)';
export const MSG_PROTECTED = 'Geschützter Container (hz.role) kann nicht gesteuert werden';
export const MSG_GAME = 'Gameserver über die Gameserver-Seite steuern';
export const MSG_LIMIT_SERVER = `Höchstens ${TASK_LIMIT_PER_SERVER} Aufgaben pro Server`;
export const MSG_LIMIT_TOTAL = `Höchstens ${TASK_LIMIT_TOTAL} Aufgaben insgesamt`;
export const MSG_NO_CONTAINER = 'Container auf diesem Server nicht gefunden';

export type Trigger = 'schedule' | 'manual';

/** What the runner reports back (no command text, never the RPC detail). */
interface Outcome {
  state: Exclude<TaskRunState, 'running' | 'skipped'>;
  summary: string;
  exitCode: number | null;
  output: string;
}

const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
};

/** Stored action (action_json) without command text; commandHash is added on read. */
type StoredAction =
  | Exclude<TaskAction, { kind: 'command' }>
  | { kind: 'command'; timeoutSec: number; commandHash: string };

const rpcSummary = (err: unknown): string => {
  if (!(err instanceof RpcError)) return 'Fehlgeschlagen';
  switch (err.code) {
    case 'offline':
    case 'disconnected':
      return 'Server offline';
    case 'timeout':
      return 'Zeitüberschreitung';
    case 'not_allowed':
      return 'Vom Agent abgelehnt';
    case 'busy':
      return 'Agent beschäftigt';
    case 'not_found':
      return 'Nicht gefunden';
    case 'bad_path':
      return 'Ungültiger Pfad';
    default:
      return 'Fehlgeschlagen';
  }
};

/** Last `max` characters (the agent already cut to the tail; this is defense in depth). */
const tail = (s: string, max: number): string => (s.length > max ? s.slice(s.length - max) : s);

/**
 * Scheduled tasks (api/tasks.ts). One scheduler job `tasks.tick` starts due
 * tasks; each run is tracked until its agent call returns, so `idle()` can wait.
 * The command text of `command` tasks is only decrypted right before task.exec
 * and in `command()` (GET .../command, step-up); it is never logged.
 */
export class TaskService {
  private readonly running = new Map<string, Promise<void>>();
  private removeJob: (() => void) | null = null;
  private readonly hashKey: Buffer;

  constructor(
    private readonly ctx: FeatureContext,
    private readonly opts: { tickMs: number },
  ) {
    this.hashKey = deriveSubkey(ctx.config.secretKey, COMMAND_HASH_INFO);
  }

  /** First 8 hex of HMAC-SHA256(command) with a key derived from HZ_SECRET_KEY. */
  commandHash(command: string): string {
    return hmacSha256Hex(this.hashKey, command).slice(0, 8);
  }

  get enabled(): boolean {
    return this.ctx.modules.enabled('tasks');
  }

  // ---- lifecycle -----------------------------------------------------------------

  start(): void {
    if (this.removeJob) return;
    this.rescheduleMissed();
    this.removeJob = this.ctx.scheduler.every('tasks.tick', this.opts.tickMs, () => this.tick());
  }

  stop(): void {
    this.removeJob?.();
    this.removeJob = null;
  }

  /** Module switched off: no jobs, no alerts left open. */
  disable(): void {
    this.stop();
    this.ctx.alerts.resolveAllWithPrefix('task:');
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  // ---- reads -----------------------------------------------------------------------

  row(id: string): ScheduledTaskRow | undefined {
    return this.ctx.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get();
  }

  private serverName(serverId: string): string {
    return (
      this.ctx.db.select({ name: servers.name }).from(servers).where(eq(servers.id, serverId)).get()
        ?.name ?? serverId
    );
  }

  private schedule(r: ScheduledTaskRow): TaskSchedule {
    return taskScheduleSchema.parse(parseJson(r.scheduleJson));
  }

  private publicAction(r: ScheduledTaskRow): TaskActionPublic {
    return taskActionPublicSchema.parse(parseJson(r.actionJson));
  }

  private toRun(r: TaskRunRow): TaskRun {
    return taskRunSchema.parse({
      id: r.id,
      taskId: r.taskId,
      trigger: r.trigger,
      state: r.state,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.finishedAt === null ? null : r.finishedAt - r.startedAt,
      exitCode: r.exitCode,
      summary: r.summary,
      output: r.output,
    });
  }

  private lastRun(taskId: string): TaskRun | null {
    const r = this.ctx.db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.taskId, taskId))
      .orderBy(desc(taskRuns.startedAt), desc(sql`rowid`))
      .limit(1)
      .get();
    return r ? this.toRun(r) : null;
  }

  private toTask(r: ScheduledTaskRow, serverName = this.serverName(r.serverId)): Task {
    return taskSchema.parse({
      id: r.id,
      serverId: r.serverId,
      serverName,
      name: r.name,
      action: this.publicAction(r),
      schedule: this.schedule(r),
      enabled: r.enabled,
      notifyOnFailure: r.notifyOnFailure,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      nextRunAt: r.nextRunAt,
      lastRun: this.lastRun(r.id),
    });
  }

  get(id: string): Task | null {
    const r = this.row(id);
    return r ? this.toTask(r) : null;
  }

  list(): Task[] {
    const rows = this.ctx.db
      .select({ t: scheduledTasks, serverName: servers.name })
      .from(scheduledTasks)
      .innerJoin(servers, eq(servers.id, scheduledTasks.serverId))
      .orderBy(asc(servers.name), asc(scheduledTasks.name), asc(scheduledTasks.createdAt))
      .all();
    return rows.map((r) => this.toTask(r.t, r.serverName));
  }

  /** Connected servers whose agent allows command tasks (capabilities.tasks). */
  commandServers(): string[] {
    return this.ctx.hub
      .connectedIds()
      .filter((id) => this.ctx.hub.capabilities(id)?.tasks === true)
      .sort();
  }

  canRunCommands(serverId: string): boolean {
    return this.ctx.hub.capabilities(serverId)?.tasks === true;
  }

  runs(taskId: string): TaskRun[] {
    return this.ctx.db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.taskId, taskId))
      .orderBy(desc(taskRuns.startedAt), desc(sql`rowid`))
      .limit(TASK_RUNS_KEEP)
      .all()
      .map((r) => this.toRun(r));
  }

  /** The decrypted command (GET .../command with step-up). Null if not a command task. */
  command(id: string): string | null {
    const r = this.row(id);
    if (!r || r.kind !== 'command' || r.commandEnc === null) return null;
    return this.ctx.box.decrypt(r.commandEnc, COMMAND_AAD);
  }

  // ---- validation --------------------------------------------------------------------

  private containerRow(serverId: string, name: string): ContainerRow | undefined {
    return this.ctx.db
      .select()
      .from(containers)
      .where(and(eq(containers.serverId, serverId), eq(containers.name, name)))
      .get();
  }

  private isGameContainer(row: ContainerRow): boolean {
    return this.ctx.throttle.control(row).gameId !== null;
  }

  /** Throws for actions the core refuses (protected or game containers, no task capability). */
  checkAction(serverId: string, action: TaskAction): void {
    if (
      action.kind === 'container.restart' ||
      action.kind === 'container.start' ||
      action.kind === 'container.stop'
    ) {
      const c = this.containerRow(serverId, action.container);
      if (!c) throw new HttpError(404, 'not_found', undefined, MSG_NO_CONTAINER);
      if (isProtected(c)) throw new HttpError(403, 'forbidden', undefined, MSG_PROTECTED);
      if (this.isGameContainer(c)) throw new HttpError(409, 'conflict', undefined, MSG_GAME);
    }
    if (action.kind === 'command' && !this.canRunCommands(serverId)) {
      throw new HttpError(409, 'conflict', undefined, MSG_NOT_SUPPORTED);
    }
  }

  checkLimits(serverId: string): void {
    const count = (where?: ReturnType<typeof eq>): number =>
      this.ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(scheduledTasks)
        .where(where)
        .get()?.n ?? 0;
    if (count() >= TASK_LIMIT_TOTAL) {
      throw new HttpError(409, 'conflict', undefined, MSG_LIMIT_TOTAL);
    }
    if (count(eq(scheduledTasks.serverId, serverId)) >= TASK_LIMIT_PER_SERVER) {
      throw new HttpError(409, 'conflict', undefined, MSG_LIMIT_SERVER);
    }
  }

  /** action_json + command_enc for an action; the command only goes encrypted. */
  private storeAction(action: TaskAction): { actionJson: string; commandEnc: string | null } {
    if (action.kind !== 'command') return { actionJson: JSON.stringify(action), commandEnc: null };
    const stored: StoredAction = {
      kind: 'command',
      timeoutSec: action.timeoutSec,
      commandHash: this.commandHash(action.command),
    };
    return {
      actionJson: JSON.stringify(stored),
      commandEnc: this.ctx.box.encrypt(action.command, COMMAND_AAD),
    };
  }

  // ---- writes ------------------------------------------------------------------------

  create(req: {
    serverId: string;
    name: string;
    action: TaskAction;
    schedule: TaskSchedule;
    enabled: boolean;
    notifyOnFailure: boolean;
  }): string {
    const now = this.ctx.now();
    const id = randomToken(12);
    const { actionJson, commandEnc } = this.storeAction(req.action);
    this.ctx.db
      .insert(scheduledTasks)
      .values({
        id,
        serverId: req.serverId,
        name: req.name,
        kind: req.action.kind,
        actionJson,
        commandEnc,
        scheduleJson: JSON.stringify(req.schedule),
        enabled: req.enabled,
        notifyOnFailure: req.notifyOnFailure,
        nextRunAt: req.enabled ? nextTaskRun(req.schedule, now) : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    writeAudit(this.ctx.db, now, {
      actor: 'admin',
      action: 'task.create',
      target: id,
      details: { serverId: req.serverId, name: req.name, kind: req.action.kind },
    });
    return id;
  }

  update(
    row: ScheduledTaskRow,
    patch: {
      name?: string | undefined;
      action?: TaskAction | undefined;
      schedule?: TaskSchedule | undefined;
      enabled?: boolean | undefined;
      notifyOnFailure?: boolean | undefined;
    },
  ): void {
    const now = this.ctx.now();
    const schedule = patch.schedule ?? this.schedule(row);
    const enabled = patch.enabled ?? row.enabled;
    const set: Partial<ScheduledTaskRow> = { updatedAt: now };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.notifyOnFailure !== undefined) set.notifyOnFailure = patch.notifyOnFailure;
    if (patch.action !== undefined) {
      const stored = this.storeAction(patch.action);
      set.kind = patch.action.kind;
      set.actionJson = stored.actionJson;
      set.commandEnc = stored.commandEnc;
    }
    if (patch.schedule !== undefined || patch.enabled !== undefined) {
      set.scheduleJson = JSON.stringify(schedule);
      set.enabled = enabled;
      set.nextRunAt = enabled ? nextTaskRun(schedule, now) : null;
    }
    this.ctx.db.update(scheduledTasks).set(set).where(eq(scheduledTasks.id, row.id)).run();
    writeAudit(this.ctx.db, now, {
      actor: 'admin',
      action: 'task.update',
      target: row.id,
      details: {
        serverId: row.serverId,
        name: set.name ?? row.name,
        kind: set.kind ?? row.kind,
        fields: Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined),
      },
    });
  }

  remove(row: ScheduledTaskRow): void {
    const now = this.ctx.now();
    this.ctx.db.delete(scheduledTasks).where(eq(scheduledTasks.id, row.id)).run();
    const a = this.ctx.alerts.active(taskAlertKey(row.id));
    if (a) this.ctx.alerts.resolveById(a.id);
    writeAudit(this.ctx.db, now, {
      actor: 'admin',
      action: 'task.delete',
      target: row.id,
      details: { serverId: row.serverId, name: row.name, kind: row.kind },
    });
  }

  // ---- scheduling ----------------------------------------------------------------------

  /** Due times far in the past (core was down, module was off) move to the next slot. */
  private rescheduleMissed(): void {
    const now = this.ctx.now();
    const rows = this.ctx.db
      .select()
      .from(scheduledTasks)
      .where(
        and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextRunAt, now - MISSED_GRACE_MS)),
      )
      .all();
    for (const r of rows) this.setNext(r, now);
  }

  private setNext(r: ScheduledTaskRow, from: number): void {
    let next: number | null;
    try {
      next = r.enabled ? nextTaskRun(this.schedule(r), from) : null;
    } catch {
      next = null;
    }
    this.ctx.db
      .update(scheduledTasks)
      .set({ nextRunAt: next })
      .where(eq(scheduledTasks.id, r.id))
      .run();
  }

  /** Starts every due task (does not wait for the runs). */
  tick(): void {
    if (!this.enabled) return;
    const now = this.ctx.now();
    const due = this.ctx.db
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextRunAt, now)))
      .orderBy(asc(scheduledTasks.nextRunAt))
      .all();
    for (const r of due) {
      const missed = r.nextRunAt !== null && now - r.nextRunAt > MISSED_GRACE_MS;
      // Interval schedules count from the start; weekly ones from the slot.
      this.setNext(r, now);
      if (missed) continue;
      try {
        this.startRun(r, 'schedule');
      } catch (err) {
        this.ctx.log.error(
          { taskId: r.id, err: err instanceof Error ? err.name : 'error' },
          'task start failed',
        );
      }
    }
  }

  // ---- runs ------------------------------------------------------------------------------

  private insertRun(taskId: string, trigger: Trigger, state: TaskRunState, now: number): string {
    const id = randomToken(12);
    this.ctx.db
      .insert(taskRuns)
      .values({
        id,
        taskId,
        trigger,
        state,
        startedAt: now,
        finishedAt: state === 'skipped' ? now : null,
        exitCode: null,
        summary: state === 'skipped' ? 'Läuft noch (übersprungen)' : 'Läuft',
        output: '',
      })
      .run();
    this.pruneRuns(taskId);
    return id;
  }

  /** Keeps the last TASK_RUNS_KEEP runs of a task. */
  private pruneRuns(taskId: string): void {
    const keep = this.ctx.db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(eq(taskRuns.taskId, taskId))
      .orderBy(desc(taskRuns.startedAt), desc(sql`rowid`))
      .limit(TASK_RUNS_KEEP)
      .all()
      .map((r) => r.id);
    if (keep.length < TASK_RUNS_KEEP) return;
    this.ctx.db
      .delete(taskRuns)
      .where(and(eq(taskRuns.taskId, taskId), notInArray(taskRuns.id, keep)))
      .run();
  }

  /**
   * Starts a run. An overlapping one is recorded as `skipped` (schedule) or
   * refused with 409 busy (manual). Returns the run as stored.
   */
  startRun(r: ScheduledTaskRow, trigger: Trigger): TaskRun {
    const now = this.ctx.now();
    if (this.running.has(r.id)) {
      if (trigger === 'manual') throw new HttpError(409, 'busy');
      const skipped = this.insertRun(r.id, trigger, 'skipped', now);
      return this.runOf(skipped);
    }
    const runId = this.insertRun(r.id, trigger, 'running', now);
    writeAudit(this.ctx.db, now, {
      actor: trigger === 'manual' ? 'admin' : 'system',
      action: 'task.run',
      target: r.id,
      details: { serverId: r.serverId, name: r.name, kind: r.kind, trigger },
    });
    const p = this.execute(r)
      .catch((err: unknown): Outcome => {
        this.ctx.log.error(
          { taskId: r.id, err: err instanceof Error ? err.name : 'error' },
          'task run failed',
        );
        return { state: 'failed', summary: 'Fehlgeschlagen', exitCode: null, output: '' };
      })
      .then((o) => this.finish(r, runId, o))
      .finally(() => this.running.delete(r.id));
    this.running.set(r.id, p);
    return this.runOf(runId);
  }

  private runOf(runId: string): TaskRun {
    const row = this.ctx.db.select().from(taskRuns).where(eq(taskRuns.id, runId)).get();
    if (!row) throw new HttpError(404, 'not_found');
    return this.toRun(row);
  }

  private finish(r: ScheduledTaskRow, runId: string, o: Outcome): void {
    const now = this.ctx.now();
    this.ctx.db
      .update(taskRuns)
      .set({
        state: o.state,
        finishedAt: now,
        exitCode: o.exitCode,
        summary: o.summary.slice(0, 200),
        output: tail(o.output, OUTPUT_KEEP),
      })
      .where(eq(taskRuns.id, runId))
      .run();
    // Deleted while running: nothing left to alert about.
    const current = this.row(r.id);
    if (!current || !this.enabled) return;
    const key = taskAlertKey(r.id);
    const serverName = this.serverName(r.serverId);
    if (o.state === 'failed') {
      if (!current.notifyOnFailure) return;
      this.ctx.alerts.raise(
        key,
        'warn',
        `Aufgabe „${current.name}“ fehlgeschlagen`,
        `${serverName}: ${o.summary} (${clockTime(now)}).`,
        r.serverId,
        'system',
      );
    } else {
      this.ctx.alerts.resolve(key, {
        title: `Aufgabe „${current.name}“ wieder erfolgreich`,
        body: `${serverName}: um ${clockTime(now)} erfolgreich gelaufen.`,
      });
    }
  }

  /** Runs the action on the agent. Never throws the command or the agent detail upwards. */
  private async execute(r: ScheduledTaskRow): Promise<Outcome> {
    const fail = (summary: string): Outcome => ({
      state: 'failed',
      summary,
      exitCode: null,
      output: '',
    });
    const ok = (summary = 'OK'): Outcome => ({ state: 'ok', summary, exitCode: null, output: '' });
    if (!this.ctx.hub.isConnected(r.serverId)) return fail('Server offline');
    const action = this.publicAction(r);
    const kind: TaskKind = action.kind;
    const hub = this.ctx.hub;
    const c = this.ctx.containers;
    try {
      switch (action.kind) {
        case 'container.restart':
        case 'container.start':
        case 'container.stop': {
          const row = this.containerRow(r.serverId, action.container);
          if (!row) return fail('Container nicht gefunden');
          if (isProtected(row)) return fail('Geschützter Container');
          if (this.isGameContainer(row)) return fail('Gameserver-Container');
          const ref = { id: row.dockerId };
          const opts = { timeoutMs: ACTION_TIMEOUT_MS };
          if (kind === 'container.stop') {
            // Taken down on purpose: no "down" alert, no self-healing (selfheal skips intents).
            c.setIntent(row.id, 'stop');
            try {
              await hub.call(r.serverId, 'container.stop', ref, opts);
            } catch (err) {
              c.setIntent(row.id, null);
              throw err;
            }
          } else if (kind === 'container.restart') {
            c.setIntent(row.id, 'restart', INTENT_TTL_MS);
            try {
              await hub.call(r.serverId, 'container.restart', ref, opts);
            } catch (err) {
              c.setIntent(row.id, null);
              throw err;
            }
            c.setIntent(row.id, 'restart', SETTLE_MS);
          } else {
            c.setIntent(row.id, null);
            await hub.call(r.serverId, 'container.start', ref, opts);
          }
          return ok();
        }
        case 'compose.update': {
          const ids = this.ctx.db
            .select()
            .from(containers)
            .where(eq(containers.serverId, r.serverId))
            .all()
            .filter((x) => managedComposeDir(x.composeDir) === action.dir)
            .map((x) => x.id);
          for (const id of ids) c.setIntent(id, 'restart', INTENT_TTL_MS);
          try {
            await hub.call(
              r.serverId,
              'compose.pull',
              { dir: action.dir },
              { timeoutMs: PULL_TIMEOUT_MS },
            );
            await hub.call(
              r.serverId,
              'compose.up',
              { dir: action.dir },
              { timeoutMs: UP_TIMEOUT_MS },
            );
          } catch (err) {
            for (const id of ids) c.setIntent(id, null);
            throw err;
          }
          for (const id of ids) c.setIntent(id, 'restart', SETTLE_MS);
          return ok();
        }
        case 'system.cleanup': {
          const data = await hub.call(
            r.serverId,
            'system.cleanup',
            {},
            { timeoutMs: CLEANUP_TIMEOUT_MS },
          );
          const parsed = cleanupResponseSchema.safeParse(data);
          if (!parsed.success) return fail('Ungültige Antwort des Agents');
          return ok(`OK, ${gigabytes(parsed.data.freedBytes)} frei geworden`);
        }
        case 'command': {
          if (!this.canRunCommands(r.serverId)) return fail('Agent erlaubt keine Befehle');
          if (r.commandEnc === null) return fail('Kein Befehl gespeichert');
          const command = this.ctx.box.decrypt(r.commandEnc, COMMAND_AAD);
          const data = await hub.call(
            r.serverId,
            'task.exec',
            { taskId: r.id, command, timeoutSec: action.timeoutSec },
            { timeoutMs: (action.timeoutSec + 30) * 1000 },
          );
          const parsed = taskExecDataSchema.safeParse(data);
          if (!parsed.success) return fail('Ungültige Antwort des Agents');
          const d = parsed.data;
          const output = tail(d.output, OUTPUT_KEEP);
          if (d.timedOut) {
            return {
              state: 'failed',
              summary: `Zeitüberschreitung nach ${action.timeoutSec} s`,
              exitCode: d.exitCode,
              output,
            };
          }
          if (d.exitCode === 0) return { state: 'ok', summary: 'OK', exitCode: 0, output };
          return {
            state: 'failed',
            summary: d.exitCode === null ? 'Abgebrochen' : `Exit-Code ${d.exitCode}`,
            exitCode: d.exitCode,
            output,
          };
        }
      }
    } catch (err) {
      return fail(rpcSummary(err));
    }
  }
}

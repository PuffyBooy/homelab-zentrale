import { z } from 'zod';
import { containerRefSchema, homelabPathSchema } from '../agent-protocol.js';
import { taskCommandSchema, TASK_MAX_TIMEOUT_SEC } from '../agent-automation.js';
import { clockTimeSchema } from './game-features.js';
import { serverIdSchema } from './servers.js';

/**
 * M20 "Geplante Aufgaben" (ROADMAP M20, SPEC 18.1). Module `tasks` (off by default).
 *
 * A task runs one allowlisted action on one server on a schedule. Kinds map to
 * agent actions that already exist (container.*, compose.pull + compose.up,
 * system.cleanup); only `command` runs a shell line (agent action task.exec),
 * and only when the server's agent runs with HZ_AGENT_ALLOW_TASKS=1.
 *
 * Rules:
 * - Creating, editing or manually running a `command` task needs step-up; so does
 *   turning any task into a `command` task. The command text is stored encrypted
 *   (AES-256-GCM, AAD `scheduled_tasks.command`) and shown to the admin in the
 *   detail only; it never appears in logs, alerts or pushes (only the task name).
 * - Containers with the label hz.role (core, agent) are refused (`protected`).
 * - A task never starts while its previous run still runs (run skipped, recorded).
 * - Runs missed while the core was down are not caught up.
 * - Server offline: run recorded as failed "Server offline".
 * - Failed run: alert `task:<id>` warn when notifyOnFailure; the next successful run
 *   resolves it.
 * - Every create/update/delete/manual run goes to the audit log.
 *
 * Routes (admin session):
 * GET    /api/tasks                 -> TasksResponse
 * POST   /api/tasks                 TaskCreateRequest -> Task (201)
 * PUT    /api/tasks/:id             TaskUpdateRequest -> Task
 * DELETE /api/tasks/:id             -> 204
 * POST   /api/tasks/:id/run         -> 202 TaskRun (state running)
 * GET    /api/tasks/:id/runs        -> TaskRunsResponse (last TASK_RUNS_KEEP)
 * GET    /api/tasks/:id/command     -> { command } (step-up; only for kind command)
 */

export const taskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const taskIdParamsSchema = z.strictObject({ id: taskIdSchema });

export const TASK_KINDS = [
  'container.restart',
  'container.start',
  'container.stop',
  'compose.update',
  'system.cleanup',
  'command',
] as const;
export const taskKindSchema = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof taskKindSchema>;

/** German labels for the UI. */
export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  'container.restart': 'Container neu starten',
  'container.start': 'Container starten',
  'container.stop': 'Container stoppen',
  'compose.update': 'Stack aktualisieren (pull + up)',
  'system.cleanup': 'Docker aufräumen',
  command: 'Befehl ausführen',
};

/** What the task does. `command` text is write-only in the API (see GET .../command). */
export const taskActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('container.restart'), container: containerRefSchema }),
  z.strictObject({ kind: z.literal('container.start'), container: containerRefSchema }),
  z.strictObject({ kind: z.literal('container.stop'), container: containerRefSchema }),
  /** compose pull, then compose up -d in this folder (below /opt/homelab/). */
  z.strictObject({ kind: z.literal('compose.update'), dir: homelabPathSchema }),
  z.strictObject({ kind: z.literal('system.cleanup') }),
  z.strictObject({
    kind: z.literal('command'),
    command: taskCommandSchema,
    timeoutSec: z.number().int().min(5).max(TASK_MAX_TIMEOUT_SEC).default(300),
  }),
]);
export type TaskAction = z.infer<typeof taskActionSchema>;

/** The same without the command text (responses). */
export const taskActionPublicSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('container.restart'), container: containerRefSchema }),
  z.strictObject({ kind: z.literal('container.start'), container: containerRefSchema }),
  z.strictObject({ kind: z.literal('container.stop'), container: containerRefSchema }),
  z.strictObject({ kind: z.literal('compose.update'), dir: homelabPathSchema }),
  z.strictObject({ kind: z.literal('system.cleanup') }),
  z.strictObject({
    kind: z.literal('command'),
    timeoutSec: z.number().int(),
    /** First 8 hex of sha256(command), so the admin sees when it changed. */
    commandHash: z.string().regex(/^[0-9a-f]{8}$/),
  }),
]);
export type TaskActionPublic = z.infer<typeof taskActionPublicSchema>;

/** Smallest interval of an interval schedule (minutes). */
export const TASK_MIN_INTERVAL_MINUTES = 5;
export const TASK_MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export const taskScheduleSchema = z.discriminatedUnion('type', [
  /** ISO weekdays 1 = Monday .. 7 = Sunday at fixed times (HZ_TIMEZONE). */
  z.strictObject({
    type: z.literal('weekly'),
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, { message: 'duplicate day' }),
    times: z
      .array(clockTimeSchema)
      .min(1)
      .max(6)
      .refine((t) => new Set(t).size === t.length, { message: 'duplicate time' }),
  }),
  /** Every N minutes, counted from the last start (first run N minutes after saving). */
  z.strictObject({
    type: z.literal('interval'),
    minutes: z.number().int().min(TASK_MIN_INTERVAL_MINUTES).max(TASK_MAX_INTERVAL_MINUTES),
  }),
]);
export type TaskSchedule = z.infer<typeof taskScheduleSchema>;

export const taskNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}\p{N} .,:()_+/-]+$/u);

export const TASK_LIMIT_PER_SERVER = 50;
export const TASK_LIMIT_TOTAL = 200;
export const TASK_RUNS_KEEP = 50;

export const taskRunStateSchema = z.enum(['running', 'ok', 'failed', 'skipped']);
export type TaskRunState = z.infer<typeof taskRunStateSchema>;

export const taskRunSchema = z.strictObject({
  id: z.string().max(64),
  taskId: taskIdSchema,
  trigger: z.enum(['schedule', 'manual']),
  state: taskRunStateSchema,
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  /** Only for command tasks. */
  exitCode: z.number().int().nullable(),
  /** German one-liner: "OK", "Exit-Code 1", "Server offline", "Läuft noch (übersprungen)". */
  summary: z.string().max(200),
  /** Tail of the command output (command tasks only), else "". */
  output: z.string().max(32 * 1024),
});
export type TaskRun = z.infer<typeof taskRunSchema>;

export const taskSchema = z.strictObject({
  id: taskIdSchema,
  serverId: serverIdSchema,
  serverName: z.string().max(64),
  name: taskNameSchema,
  action: taskActionPublicSchema,
  schedule: taskScheduleSchema,
  enabled: z.boolean(),
  notifyOnFailure: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  nextRunAt: z.number().int().nullable(),
  lastRun: taskRunSchema.nullable(),
});
export type Task = z.infer<typeof taskSchema>;

export const tasksResponseSchema = z.strictObject({
  tasks: z.array(taskSchema),
  /** Servers whose agent allows command tasks (capabilities.tasks). */
  commandServers: z.array(serverIdSchema),
});
export type TasksResponse = z.infer<typeof tasksResponseSchema>;

export const taskCreateRequestSchema = z.strictObject({
  serverId: serverIdSchema,
  name: taskNameSchema,
  action: taskActionSchema,
  schedule: taskScheduleSchema,
  enabled: z.boolean().default(true),
  notifyOnFailure: z.boolean().default(true),
});
export type TaskCreateRequest = z.input<typeof taskCreateRequestSchema>;

/**
 * Partial update. `action` replaces the whole action; for a command task the
 * command must be sent again (it is never sent to the browser without step-up).
 */
export const taskUpdateRequestSchema = z
  .strictObject({
    name: taskNameSchema.optional(),
    action: taskActionSchema.optional(),
    schedule: taskScheduleSchema.optional(),
    enabled: z.boolean().optional(),
    notifyOnFailure: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length >= 1, { message: 'nothing to update' });
export type TaskUpdateRequest = z.input<typeof taskUpdateRequestSchema>;

export const taskRunsResponseSchema = z.strictObject({ runs: z.array(taskRunSchema) });
export type TaskRunsResponse = z.infer<typeof taskRunsResponseSchema>;

export const taskCommandResponseSchema = z.strictObject({ command: taskCommandSchema });

export const taskAlertKey = (taskId: string) => `task:${taskId}`;

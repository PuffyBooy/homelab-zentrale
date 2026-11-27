import {
  TASK_KIND_LABELS,
  TASK_KINDS,
  TASK_MAX_INTERVAL_MINUTES,
  TASK_MAX_TIMEOUT_SEC,
  TASK_MIN_INTERVAL_MINUTES,
  containerRefSchema,
  homelabPathSchema,
  taskCommandResponseSchema,
  taskCommandSchema,
  taskNameSchema,
  taskRunSchema,
  taskRunsResponseSchema,
  taskSchema,
  tasksResponseSchema,
  type ContainerSummary,
  type Task,
  type TaskAction,
  type TaskActionPublic,
  type TaskCreateRequest,
  type TaskKind,
  type TaskRun,
  type TaskRunState,
  type TaskSchedule,
  type TaskUpdateRequest,
  type TasksResponse,
} from '@hz/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Status } from '@hz/ui';
import { api } from './api.js';
import { formatNumber, formatWhen, plural } from './format.js';
import { daysText, normalizeTime } from './gameFeatures.js';

/**
 * M20 "Geplante Aufgaben" (packages/shared/src/api/tasks.ts). Queries, German texts for
 * schedules and runs, and the form of the create/edit dialog.
 */

export { TASK_KIND_LABELS, TASK_KINDS, TASK_MIN_INTERVAL_MINUTES };
export type { Task, TaskRun, TasksResponse };

export const tasksKey = ['tasks'] as const;
export const taskRunsKey = (id: string) => ['tasks', 'runs', id] as const;

const enc = encodeURIComponent;
const noBody = { parse: (d: unknown): unknown => d };

export function fetchTasks(signal?: AbortSignal): Promise<TasksResponse> {
  return api('/api/tasks', { schema: tasksResponseSchema, signal });
}

/** Command tasks need step-up; api() asks for the code and repeats. */
export function createTask(body: TaskCreateRequest): Promise<Task> {
  return api('/api/tasks', { method: 'POST', body, schema: taskSchema });
}

export function updateTask(id: string, body: TaskUpdateRequest): Promise<Task> {
  return api(`/api/tasks/${enc(id)}`, { method: 'PUT', body, schema: taskSchema });
}

export async function deleteTask(id: string): Promise<void> {
  await api(`/api/tasks/${enc(id)}`, { method: 'DELETE', schema: noBody });
}

/** 202 with the run in state running. */
export function runTask(id: string): Promise<TaskRun> {
  return api(`/api/tasks/${enc(id)}/run`, { method: 'POST', body: {}, schema: taskRunSchema });
}

export async function fetchTaskRuns(id: string, signal?: AbortSignal): Promise<TaskRun[]> {
  const res = await api(`/api/tasks/${enc(id)}/runs`, { schema: taskRunsResponseSchema, signal });
  return res.runs;
}

/** Only for command tasks, step-up. */
export async function fetchTaskCommand(id: string): Promise<string> {
  const res = await api(`/api/tasks/${enc(id)}/command`, { schema: taskCommandResponseSchema });
  return res.command;
}

// ---------------------------------------------------------------------------
// Texts (pure, unit tested)

/** "alle 5 Min", "jede Stunde", "alle 6 Std", "alle 2 Tage". */
export function intervalText(minutes: number): string {
  if (minutes % 60 !== 0) return `alle ${formatNumber(minutes, 0)} Min`;
  const h = minutes / 60;
  if (h === 1) return 'jede Stunde';
  if (h % 24 === 0 && h > 24) return `alle ${formatNumber(h / 24, 0)} Tage`;
  return `alle ${formatNumber(h, 0)} Std`;
}

/** "täglich um 04:00", "Mo–Fr um 06:00 und 18:00", "alle 30 Min". */
export function scheduleText(s: TaskSchedule): string {
  if (s.type === 'interval') return intervalText(s.minutes);
  const times = [...s.times].sort();
  const last = times.pop() ?? '';
  const t = times.length ? `${times.join(', ')} und ${last}` : last;
  return `${daysText(s.days)} um ${t}`;
}

/** "Container neu starten · nextcloud", "Befehl ausführen · #1a2b3c4d". */
export function actionText(a: TaskActionPublic): string {
  const label = TASK_KIND_LABELS[a.kind];
  switch (a.kind) {
    case 'container.restart':
    case 'container.start':
    case 'container.stop':
      return `${label} · ${a.container}`;
    case 'compose.update':
      return `${label} · ${a.dir}`;
    case 'command':
      return `${label} · #${a.commandHash}`;
    default:
      return label;
  }
}

export const RUN_STATE_STATUS: Record<TaskRunState, Status> = {
  running: 'busy',
  ok: 'ok',
  failed: 'crit',
  skipped: 'warn',
};

export const RUN_STATE_TEXT: Record<TaskRunState, string> = {
  running: 'läuft',
  ok: 'OK',
  failed: 'fehlgeschlagen',
  skipped: 'übersprungen',
};

export const TRIGGER_TEXT: Record<TaskRun['trigger'], string> = {
  schedule: 'Zeitplan',
  manual: 'von Hand',
};

/** "0,8 s", "42 s", "3 Min 4 s". */
export function durationText(ms: number | null): string {
  if (ms == null || ms < 0) return '—';
  if (ms < 10_000) return `${formatNumber(ms / 1000, 1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} Min ${s % 60} s` : `${m} Min`;
}

/** Status of the task row: last run, paused, or never run. */
export function taskStatus(t: Pick<Task, 'enabled' | 'lastRun'>): Status {
  if (t.lastRun?.state === 'running') return 'busy';
  if (!t.enabled) return 'off';
  if (!t.lastRun) return 'info';
  return RUN_STATE_STATUS[t.lastRun.state];
}

export function taskStatusLabel(t: Pick<Task, 'enabled' | 'lastRun'>): string {
  if (t.lastRun?.state === 'running') return 'läuft gerade';
  if (!t.enabled) return 'pausiert';
  if (!t.lastRun) return 'noch nie gelaufen';
  return `letzter Lauf ${RUN_STATE_TEXT[t.lastRun.state]}`;
}

/** "nächster Lauf 23:04", "pausiert", "kein Lauf geplant". */
export function nextRunText(t: Pick<Task, 'enabled' | 'nextRunAt'>, now: Date): string {
  if (!t.enabled) return 'pausiert';
  if (t.nextRunAt == null) return 'kein Lauf geplant';
  return `nächster Lauf ${formatWhen(new Date(t.nextRunAt), now)}`;
}

/** "zuletzt 23:04 · OK" or "noch nie gelaufen". */
export function lastRunText(run: TaskRun | null, now: Date): string {
  if (!run) return 'noch nie gelaufen';
  const when = formatWhen(new Date(run.startedAt), now);
  if (run.state === 'running') return `läuft seit ${when}`;
  return `zuletzt ${when} · ${run.summary || RUN_STATE_TEXT[run.state]}`;
}

/** Statussatz of the tasks section. */
export function tasksSentence(tasks: readonly Task[]): { em: string | null; rest: string } {
  if (tasks.length === 0) return { em: null, rest: 'Noch keine geplanten Aufgaben.' };
  const failed = tasks.filter((t) => t.enabled && t.lastRun?.state === 'failed');
  const active = tasks.filter((t) => t.enabled).length;
  const rest = `${active} von ${plural(tasks.length, 'Aufgabe', 'Aufgaben')} aktiv`;
  const one = failed.length === 1 ? failed[0] : undefined;
  if (one) return { em: `${one.name} auf ${one.serverName} fehlgeschlagen`, rest: ` · ${rest}` };
  if (failed.length) {
    return {
      em: `${plural(failed.length, 'Aufgabe', 'Aufgaben')} fehlgeschlagen`,
      rest: ` · ${rest}`,
    };
  }
  return { em: null, rest: `${rest}.` };
}

/** Problems first, then by next run. */
export function sortTasks(tasks: readonly Task[]): Task[] {
  const rank = (t: Task): number =>
    taskStatus(t) === 'crit' ? 0 : taskStatus(t) === 'warn' ? 1 : 2;
  return [...tasks].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name, 'de'),
  );
}

// ---------------------------------------------------------------------------
// Form

export type ScheduleType = TaskSchedule['type'];

export interface TaskDraft {
  serverId: string;
  name: string;
  kind: TaskKind;
  container: string;
  dir: string;
  command: string;
  timeoutSec: string;
  scheduleType: ScheduleType;
  days: number[];
  /** "04:00, 18:30" */
  times: string;
  minutes: string;
  enabled: boolean;
  notifyOnFailure: boolean;
}

export type TaskDraftField =
  | 'serverId'
  | 'name'
  | 'container'
  | 'dir'
  | 'command'
  | 'timeoutSec'
  | 'days'
  | 'times'
  | 'minutes';
export type TaskDraftErrors = Partial<Record<TaskDraftField, string>>;

export function emptyTaskDraft(serverId = ''): TaskDraft {
  return {
    serverId,
    name: '',
    kind: 'container.restart',
    container: '',
    dir: '',
    command: '',
    timeoutSec: '300',
    scheduleType: 'weekly',
    days: [1, 2, 3, 4, 5, 6, 7],
    times: '04:00',
    minutes: '60',
    enabled: true,
    notifyOnFailure: true,
  };
}

/** Edit form of a saved task. The command text is never in the browser, so it stays empty. */
export function taskToDraft(t: Task): TaskDraft {
  const d = emptyTaskDraft(t.serverId);
  d.name = t.name;
  d.kind = t.action.kind;
  d.enabled = t.enabled;
  d.notifyOnFailure = t.notifyOnFailure;
  const a = t.action;
  if (
    a.kind === 'container.restart' ||
    a.kind === 'container.start' ||
    a.kind === 'container.stop'
  ) {
    d.container = a.container;
  } else if (a.kind === 'compose.update') {
    d.dir = a.dir;
  } else if (a.kind === 'command') {
    d.timeoutSec = String(a.timeoutSec);
  }
  if (t.schedule.type === 'weekly') {
    d.scheduleType = 'weekly';
    d.days = [...t.schedule.days].sort((x, y) => x - y);
    d.times = [...t.schedule.times].sort().join(', ');
  } else {
    d.scheduleType = 'interval';
    d.minutes = String(t.schedule.minutes);
  }
  return d;
}

const SHORT_KIND: Record<TaskKind, string> = {
  'container.restart': 'Neustart',
  'container.start': 'Start',
  'container.stop': 'Stopp',
  'compose.update': 'Update',
  'system.cleanup': 'Aufräumen',
  command: 'Befehl',
};

/** Name used when the field stays empty: "Neustart nextcloud", "Aufräumen heimserver". */
export function defaultTaskName(d: TaskDraft, serverName = ''): string {
  let target = '';
  if (d.kind.startsWith('container.')) target = d.container;
  else if (d.kind === 'compose.update') target = d.dir.replace(/\/+$/, '').split('/').pop() ?? '';
  else if (d.kind === 'system.cleanup') target = serverName;
  const name = `${SHORT_KIND[d.kind]} ${target}`.trim().slice(0, 60);
  return taskNameSchema.safeParse(name).success ? name : SHORT_KIND[d.kind];
}

/** Parses "04:00, 18:30" (also spaces or ";"). Null entries are invalid. */
export function parseTimes(raw: string): (string | null)[] {
  return raw
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map(normalizeTime);
}

/** Containers a task may target: on that server and not the core/agent (hz.role). */
export function taskContainers(
  containers: readonly ContainerSummary[],
  serverId: string,
): ContainerSummary[] {
  return containers
    .filter((c) => c.serverId === serverId && !c.protected)
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

type DraftResult =
  | { ok: true; action: TaskAction | null; schedule: TaskSchedule; name: string }
  | { ok: false; errors: TaskDraftErrors };

/**
 * Validates the draft. `keepCommand`: editing a command task with an empty command field
 * keeps the stored command (action is left out of the update).
 */
function checkDraft(d: TaskDraft, serverName: string, keepCommand: boolean): DraftResult {
  const errors: TaskDraftErrors = {};
  if (!d.serverId) errors.serverId = 'Server wählen.';

  const rawName = d.name.trim() || defaultTaskName(d, serverName);
  if (!taskNameSchema.safeParse(rawName).success) {
    errors.name = 'Höchstens 60 Zeichen: Buchstaben, Ziffern, Leerzeichen und . , : ( ) _ + / -';
  }

  let action: TaskAction | null = null;
  switch (d.kind) {
    case 'container.restart':
    case 'container.start':
    case 'container.stop':
      if (!containerRefSchema.safeParse(d.container).success)
        errors.container = 'Container wählen.';
      else action = { kind: d.kind, container: d.container };
      break;
    case 'compose.update': {
      const dir = d.dir.trim();
      if (!homelabPathSchema.safeParse(dir).success || dir.includes('..')) {
        errors.dir = 'Ordner unter /opt/homelab/, z. B. /opt/homelab/apps/nextcloud';
      } else action = { kind: 'compose.update', dir };
      break;
    }
    case 'system.cleanup':
      action = { kind: 'system.cleanup' };
      break;
    case 'command': {
      const timeout = Number(d.timeoutSec);
      if (!Number.isInteger(timeout) || timeout < 5 || timeout > TASK_MAX_TIMEOUT_SEC) {
        errors.timeoutSec = `5 bis ${TASK_MAX_TIMEOUT_SEC} s`;
      }
      if (keepCommand && d.command === '') break;
      if (!taskCommandSchema.safeParse(d.command).success) {
        errors.command = 'Eine Zeile, höchstens 2000 Zeichen.';
      } else if (!errors.timeoutSec) {
        action = { kind: 'command', command: d.command, timeoutSec: timeout };
      }
      break;
    }
  }

  let schedule: TaskSchedule | null = null;
  if (d.scheduleType === 'weekly') {
    const days = [...new Set(d.days)].sort((a, b) => a - b);
    const times = parseTimes(d.times);
    if (days.length === 0) errors.days = 'Mindestens einen Wochentag wählen.';
    if (times.length === 0 || times.some((t) => t === null)) {
      errors.times = 'Uhrzeiten wie 04:00, mehrere mit Komma.';
    } else if (times.length > 6) {
      errors.times = 'Höchstens 6 Uhrzeiten.';
    } else if (new Set(times).size !== times.length) {
      errors.times = 'Jede Uhrzeit nur einmal.';
    }
    if (!errors.days && !errors.times) {
      schedule = { type: 'weekly', days, times: (times as string[]).sort() };
    }
  } else {
    const m = Number(d.minutes);
    if (!Number.isInteger(m) || m < TASK_MIN_INTERVAL_MINUTES || m > TASK_MAX_INTERVAL_MINUTES) {
      errors.minutes = `${TASK_MIN_INTERVAL_MINUTES} bis ${formatNumber(TASK_MAX_INTERVAL_MINUTES, 0)} Min`;
    } else schedule = { type: 'interval', minutes: m };
  }

  if (Object.keys(errors).length || !schedule) return { ok: false, errors };
  return { ok: true, action, schedule, name: rawName };
}

export function draftToCreate(
  d: TaskDraft,
  serverName = '',
): { ok: true; body: TaskCreateRequest } | { ok: false; errors: TaskDraftErrors } {
  const res = checkDraft(d, serverName, false);
  if (!res.ok) return res;
  if (!res.action) return { ok: false, errors: { command: 'Befehl eintragen.' } };
  return {
    ok: true,
    body: {
      serverId: d.serverId,
      name: res.name,
      action: res.action,
      schedule: res.schedule,
      enabled: d.enabled,
      notifyOnFailure: d.notifyOnFailure,
    },
  };
}

/** Update of a saved task. A kind change to `command` needs the command text. */
export function draftToUpdate(
  d: TaskDraft,
  saved: Task,
  serverName = '',
): { ok: true; body: TaskUpdateRequest } | { ok: false; errors: TaskDraftErrors } {
  const keep = saved.action.kind === 'command' && d.kind === 'command';
  const res = checkDraft(d, serverName, keep);
  if (!res.ok) return res;
  if (!res.action && !keep) return { ok: false, errors: { command: 'Befehl eintragen.' } };
  const body: TaskUpdateRequest = {
    name: res.name,
    schedule: res.schedule,
    enabled: d.enabled,
    notifyOnFailure: d.notifyOnFailure,
  };
  if (res.action) body.action = res.action;
  return { ok: true, body };
}

/** The request needs step-up (command tasks, and any change to a command task). */
export function needsStepUp(d: Pick<TaskDraft, 'kind'>, saved?: Pick<Task, 'action'>): boolean {
  return d.kind === 'command' || saved?.action.kind === 'command';
}

/**
 * All tasks plus the servers that allow command tasks. Polled, no live topic: every
 * 3 s while a run is in progress (POST run answers 202 with `running`), else 30 s.
 */
export function useTasks(enabled = true): UseQueryResult<TasksResponse> {
  return useQuery({
    queryKey: tasksKey,
    queryFn: ({ signal }) => fetchTasks(signal),
    enabled,
    refetchInterval: (q) =>
      q.state.data?.tasks.some((t) => t.lastRun?.state === 'running') ? 3_000 : 30_000,
  });
}

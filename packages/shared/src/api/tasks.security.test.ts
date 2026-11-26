import { describe, expect, it } from 'vitest';
import {
  taskActionPublicSchema,
  taskAlertKey,
  taskCommandResponseSchema,
  taskCreateRequestSchema,
  taskIdParamsSchema,
  taskRunSchema,
  taskScheduleSchema,
  taskSchema,
  tasksResponseSchema,
  taskUpdateRequestSchema,
  TASK_KIND_LABELS,
  TASK_KINDS,
  TASK_MAX_INTERVAL_MINUTES,
  TASK_MIN_INTERVAL_MINUTES,
} from './tasks.js';

const SERVER = 'abcdefgh12345678';
const base = {
  serverId: SERVER,
  name: 'Nachts neu starten',
  action: { kind: 'container.restart', container: 'webapp' },
  schedule: { type: 'weekly', days: [1, 3], times: ['04:00'] },
};

const ok = (v: unknown) => taskCreateRequestSchema.safeParse(v).success;

describe('tasks schema: create', () => {
  it('accepts every kind and fills defaults', () => {
    const p = taskCreateRequestSchema.parse(base);
    expect(p).toMatchObject({ enabled: true, notifyOnFailure: true });
    for (const action of [
      { kind: 'container.start', container: 'db' },
      { kind: 'container.stop', container: 'db' },
      { kind: 'compose.update', dir: '/opt/homelab/stacks/web' },
      { kind: 'system.cleanup' },
      { kind: 'command', command: 'docker image prune -f' },
    ]) {
      expect(ok({ ...base, action }), action.kind).toBe(true);
    }
    const cmd = taskCreateRequestSchema.parse({
      ...base,
      action: { kind: 'command', command: 'ls' },
    });
    expect(cmd.action).toEqual({ kind: 'command', command: 'ls', timeoutSec: 300 });
    expect(Object.keys(TASK_KIND_LABELS).sort()).toEqual([...TASK_KINDS].sort());
  });

  it.each([
    ['unknown kind', { ...base, action: { kind: 'shell', command: 'ls' } }],
    ['command with newline', { ...base, action: { kind: 'command', command: 'a\nb' } }],
    ['command with NUL', { ...base, action: { kind: 'command', command: 'a\0' } }],
    ['command too long', { ...base, action: { kind: 'command', command: 'x'.repeat(2001) } }],
    ['timeout below 5', { ...base, action: { kind: 'command', command: 'ls', timeoutSec: 4 } }],
    [
      'timeout above 1800',
      { ...base, action: { kind: 'command', command: 'ls', timeoutSec: 1801 } },
    ],
    [
      'extra field on a container kind',
      { ...base, action: { kind: 'container.stop', container: 'db', command: 'ls' } },
    ],
    ['container ref with slash', { ...base, action: { kind: 'container.stop', container: 'a/b' } }],
    [
      'container ref with dots first',
      { ...base, action: { kind: 'container.stop', container: '..' } },
    ],
    [
      'compose dir outside /opt/homelab',
      { ...base, action: { kind: 'compose.update', dir: '/etc/compose' } },
    ],
    [
      'compose dir with ..',
      { ...base, action: { kind: 'compose.update', dir: '/opt/homelab/../root' } },
    ],
    ['compose dir relative', { ...base, action: { kind: 'compose.update', dir: 'stacks/web' } }],
    ['bad server id', { ...base, serverId: '../x' }],
    ['empty name', { ...base, name: '   ' }],
    ['name too long', { ...base, name: 'x'.repeat(61) }],
    ['name with markup', { ...base, name: '<b>x</b>' }],
    ['name with newline', { ...base, name: 'a\nb' }],
    ['unknown top-level field', { ...base, command: 'ls' }],
    ['enabled as string', { ...base, enabled: 'true' }],
  ])('rejects %s', (_n, v) => expect(ok(v)).toBe(false));
});

describe('tasks schema: schedule', () => {
  const s = (v: unknown) => taskScheduleSchema.safeParse(v).success;
  it('interval bounds', () => {
    expect(s({ type: 'interval', minutes: TASK_MIN_INTERVAL_MINUTES })).toBe(true);
    expect(s({ type: 'interval', minutes: TASK_MAX_INTERVAL_MINUTES })).toBe(true);
    expect(s({ type: 'interval', minutes: TASK_MIN_INTERVAL_MINUTES - 1 })).toBe(false);
    expect(s({ type: 'interval', minutes: TASK_MAX_INTERVAL_MINUTES + 1 })).toBe(false);
    expect(s({ type: 'interval', minutes: 7.5 })).toBe(false);
    expect(s({ type: 'interval', minutes: '10' })).toBe(false);
  });
  it('weekly: ISO days, HH:MM, no duplicates, at most 6 times', () => {
    expect(s({ type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['00:00', '23:59'] })).toBe(
      true,
    );
    for (const bad of [
      { type: 'weekly', days: [], times: ['04:00'] },
      { type: 'weekly', days: [0], times: ['04:00'] },
      { type: 'weekly', days: [8], times: ['04:00'] },
      { type: 'weekly', days: [1, 1], times: ['04:00'] },
      { type: 'weekly', days: [1], times: [] },
      { type: 'weekly', days: [1], times: ['4:00'] },
      { type: 'weekly', days: [1], times: ['24:00'] },
      { type: 'weekly', days: [1], times: ['04:60'] },
      { type: 'weekly', days: [1], times: ['04:00', '04:00'] },
      {
        type: 'weekly',
        days: [1],
        times: ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00'],
      },
      { type: 'weekly', days: [1], times: ['04:00'], minutes: 5 },
      { type: 'cron', expr: '* * * * *' },
    ]) {
      expect(s(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('tasks schema: update and params', () => {
  it('needs at least one field and stays strict', () => {
    expect(taskUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(taskUpdateRequestSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(taskUpdateRequestSchema.safeParse({ serverId: SERVER }).success).toBe(false);
  });
  it('task ids are url-safe', () => {
    expect(taskIdParamsSchema.safeParse({ id: 'abcdefgh' }).success).toBe(true);
    for (const id of ['abc', '../../x', 'a'.repeat(65), 'a b c d e f']) {
      expect(taskIdParamsSchema.safeParse({ id }).success, id).toBe(false);
    }
  });
});

describe('tasks schema: responses never carry the command', () => {
  const publicCmd = { kind: 'command', timeoutSec: 60, commandHash: '0123abcd' };

  it('the public action of a command task has only timeout and hash', () => {
    expect(taskActionPublicSchema.safeParse(publicCmd).success).toBe(true);
    expect(taskActionPublicSchema.safeParse({ ...publicCmd, command: 'ls' }).success).toBe(false);
    expect(
      taskActionPublicSchema.safeParse({ ...publicCmd, commandHash: '0123ABCD' }).success,
    ).toBe(false);
    expect(
      taskActionPublicSchema.safeParse({ ...publicCmd, commandHash: '0123abcd0' }).success,
    ).toBe(false);
  });

  it('task and list responses are strict', () => {
    const run = {
      id: 'r1',
      taskId: 'abcdefgh',
      trigger: 'manual',
      state: 'ok',
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
      exitCode: 0,
      summary: 'OK',
      output: '',
    };
    const task = {
      id: 'abcdefgh',
      serverId: SERVER,
      serverName: 'heimserver',
      name: 'X',
      action: publicCmd,
      schedule: { type: 'interval', minutes: 5 },
      enabled: true,
      notifyOnFailure: true,
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: null,
      lastRun: run,
    };
    expect(taskSchema.safeParse(task).success).toBe(true);
    expect(taskSchema.safeParse({ ...task, command: 'ls' }).success).toBe(false);
    expect(
      taskSchema.safeParse({ ...task, action: { kind: 'command', command: 'ls', timeoutSec: 60 } })
        .success,
    ).toBe(false);
    expect(taskRunSchema.safeParse({ ...run, command: 'ls' }).success).toBe(false);
    expect(taskRunSchema.safeParse({ ...run, output: 'x'.repeat(32 * 1024 + 1) }).success).toBe(
      false,
    );
    expect(taskRunSchema.safeParse({ ...run, summary: 'x'.repeat(201) }).success).toBe(false);
    expect(tasksResponseSchema.safeParse({ tasks: [task], commandServers: [SERVER] }).success).toBe(
      true,
    );
    expect(taskCommandResponseSchema.safeParse({ command: 'ls\nx' }).success).toBe(false);
  });

  it('alert key contains only the id', () => {
    expect(taskAlertKey('abcdefgh')).toBe('task:abcdefgh');
  });
});

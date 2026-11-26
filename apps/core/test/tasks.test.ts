import { afterEach, describe, expect, it } from 'vitest';
import {
  taskAlertKey,
  taskRunSchema,
  taskRunsResponseSchema,
  taskSchema,
  tasksResponseSchema,
  TASK_RUNS_KEEP,
  type Task,
} from '@hz/shared';
import { type Received, type WsClient, until } from './agent-helpers.js';
import { dockerIdOf, info } from './container-helpers.js';
import { nextTaskRun } from '../src/tasks/schedule.js';
import type { TestApp } from './helpers.js';
import {
  advance,
  api,
  grantStepUp,
  MIN,
  ok,
  rpcFail,
  rpcsOf,
  settle,
  withAutomation,
  type AutoSetup,
  type Reply,
} from './tasks-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(opts: Parameters<typeof withAutomation>[1] = {}): Promise<AutoSetup> {
  const s = await withAutomation(clients, opts);
  t = s.t;
  return s;
}

async function create(s: AutoSetup, body: Record<string, unknown>): Promise<Task> {
  const res = await api(s, 'POST', '/api/tasks', {
    serverId: s.serverId,
    name: 'Aufgabe',
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return taskSchema.parse(res.json());
}

const runsOf = async (s: AutoSetup, id: string) => {
  const res = await api(s, 'GET', `/api/tasks/${id}/runs`);
  expect(res.statusCode).toBe(200);
  return taskRunsResponseSchema.parse(res.json()).runs;
};

// T0 = Wed 2026-11-25 12:00 UTC = 13:00 in Europe/Vienna (ISO weekday 3).
const T0_LOCAL_DAY = 3;

describe('M20 acceptance: scheduled task', () => {
  it('restarts a sim container at the configured minute', async () => {
    const s = await setup();
    const task = await create(s, {
      name: 'Webapp nachts neu starten',
      action: { kind: 'container.restart', container: 'webapp' },
      schedule: { type: 'weekly', days: [T0_LOCAL_DAY], times: ['13:05'] },
    });
    const due = Date.UTC(2026, 10, 25, 12, 5, 0);
    expect(task.nextRunAt).toBe(due);

    // 13:04:50 local: nothing yet.
    await advance(s, due - 10_000 - s.t.clock.t);
    expect(rpcsOf(s, 'container.restart')).toHaveLength(0);

    // 13:05:05: the tick starts it.
    await advance(s, 15_000);
    const restarts = rpcsOf(s, 'container.restart');
    expect(restarts).toHaveLength(1);
    expect(restarts[0]?.params).toEqual({ id: dockerIdOf('webapp') });

    const runs = await runsOf(s, task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', state: 'ok', summary: 'OK' });
    const after = taskSchema.parse(
      (await api(s, 'GET', '/api/tasks')).json<{ tasks: Task[] }>().tasks[0],
    );
    expect(after.nextRunAt).toBe(due + 7 * 24 * 60 * MIN);
    expect(after.lastRun?.state).toBe('ok');

    // Not twice in the same minute.
    await advance(s, 20_000);
    expect(rpcsOf(s, 'container.restart')).toHaveLength(1);

    const audit = s.t.db.sqlite
      .prepare("SELECT actor, details_json AS d FROM audit_log WHERE action = 'task.run'")
      .all() as { actor: string; d: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe('system');
  });
});

describe('tasks: schedules', () => {
  it('interval: first run N minutes after saving, then counted from the start', async () => {
    const s = await setup();
    const task = await create(s, {
      action: { kind: 'container.start', container: 'webapp' },
      schedule: { type: 'interval', minutes: 5 },
    });
    expect(task.nextRunAt).toBe(s.t.clock.t + 5 * MIN);
    await advance(s, 4 * MIN);
    expect(rpcsOf(s, 'container.start')).toHaveLength(0);
    await advance(s, MIN);
    expect(rpcsOf(s, 'container.start')).toHaveLength(1);
    await advance(s, 5 * MIN);
    expect(rpcsOf(s, 'container.start')).toHaveLength(2);
  });

  it('does not catch up runs missed while the core or module was away', async () => {
    const s = await setup();
    const task = await create(s, {
      action: { kind: 'container.restart', container: 'webapp' },
      schedule: { type: 'interval', minutes: 5 },
    });
    // The scheduler did not run for 20 minutes (e.g. the core was down).
    await advance(s, 20 * MIN);
    expect(rpcsOf(s, 'container.restart')).toHaveLength(0);
    const next = s.t.app.hzCore.features.tasks.service.get(task.id)?.nextRunAt;
    expect(next).toBe(s.t.clock.t + 5 * MIN);
  });

  it('updating the schedule or disabling recomputes the next run', async () => {
    const s = await setup();
    const task = await create(s, {
      action: { kind: 'container.restart', container: 'webapp' },
      schedule: { type: 'interval', minutes: 5 },
    });
    const res = await api(s, 'PUT', `/api/tasks/${task.id}`, {
      schedule: { type: 'interval', minutes: 60 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(taskSchema.parse(res.json()).nextRunAt).toBe(s.t.clock.t + 60 * MIN);
    const off = await api(s, 'PUT', `/api/tasks/${task.id}`, { enabled: false });
    expect(taskSchema.parse(off.json())).toMatchObject({ enabled: false, nextRunAt: null });
    await advance(s, 61 * MIN);
    expect(rpcsOf(s, 'container.restart')).toHaveLength(0);
  });
});

describe('tasks: kinds', () => {
  it('compose.update pulls, then ups the folder', async () => {
    const s = await setup();
    const task = await create(s, {
      action: { kind: 'compose.update', dir: '/opt/homelab/stacks/web' },
      schedule: { type: 'interval', minutes: 30 },
    });
    const res = await api(s, 'POST', `/api/tasks/${task.id}/run`);
    expect(res.statusCode, res.body).toBe(202);
    expect(taskRunSchema.parse(res.json()).state).toBe('running');
    await settle(s);
    const actions = s.rpcs.map((r) => r.action).filter((a) => String(a).startsWith('compose.'));
    expect(actions).toEqual(['compose.pull', 'compose.up']);
    for (const r of rpcsOf(s, 'compose.up'))
      expect(r.params).toEqual({ dir: '/opt/homelab/stacks/web' });
    expect((await runsOf(s, task.id))[0]?.state).toBe('ok');
  });

  it('compose.update stops after a failed pull', async () => {
    const s = await setup({
      reply: (m) => (m.action === 'compose.pull' ? rpcFail(m, 'failed', 'pull failed') : null),
    });
    const task = await create(s, {
      action: { kind: 'compose.update', dir: '/opt/homelab/stacks/web' },
      schedule: { type: 'interval', minutes: 30 },
    });
    await api(s, 'POST', `/api/tasks/${task.id}/run`);
    await settle(s);
    expect(rpcsOf(s, 'compose.up')).toHaveLength(0);
    expect((await runsOf(s, task.id))[0]).toMatchObject({
      state: 'failed',
      summary: 'Fehlgeschlagen',
    });
  });

  it('system.cleanup reports the freed space', async () => {
    const s = await setup({
      reply: (m) => (m.action === 'system.cleanup' ? ok(m, { freedBytes: 2 * 1024 ** 3 }) : null),
    });
    const task = await create(s, {
      action: { kind: 'system.cleanup' },
      schedule: { type: 'weekly', days: [7], times: ['04:00'] },
    });
    await api(s, 'POST', `/api/tasks/${task.id}/run`);
    await settle(s);
    expect((await runsOf(s, task.id))[0]?.summary).toBe('OK, 2 GB frei geworden');
  });

  it('container.stop marks the stop as intended (no down alert)', async () => {
    const s = await setup();
    const task = await create(s, {
      action: { kind: 'container.stop', container: 'webapp' },
      schedule: { type: 'interval', minutes: 30 },
    });
    await api(s, 'POST', `/api/tasks/${task.id}/run`);
    await settle(s);
    const row = s.t.app.hzCore.containers.list().find((c) => c.name === 'webapp');
    const raw = s.t.app.hzCore.containers.row(row?.id ?? '');
    expect(raw?.intent).toBe('stop');
  });

  it('command: runs task.exec, keeps the output tail and alerts on failure', async () => {
    let exit = 1;
    const s = await setup({
      tasks: true,
      reply: (m) =>
        m.action === 'task.exec'
          ? ok(m, {
              exitCode: exit,
              timedOut: false,
              durationMs: 120,
              output: 'line 1\nline 2\n',
              truncated: false,
            })
          : null,
    });
    grantStepUp(s.t);
    const task = await create(s, {
      name: 'Backup-Skript',
      action: { kind: 'command', command: '/opt/homelab/bin/backup.sh --quick', timeoutSec: 60 },
      schedule: { type: 'interval', minutes: 60 },
    });
    expect(task.action).toMatchObject({ kind: 'command', timeoutSec: 60 });
    const run = await api(s, 'POST', `/api/tasks/${task.id}/run`);
    expect(run.statusCode, run.body).toBe(202);
    await settle(s);
    const exec = rpcsOf(s, 'task.exec')[0];
    expect(exec?.params).toEqual({
      taskId: task.id,
      command: '/opt/homelab/bin/backup.sh --quick',
      timeoutSec: 60,
    });
    const runs = await runsOf(s, task.id);
    expect(runs[0]).toMatchObject({
      state: 'failed',
      exitCode: 1,
      summary: 'Exit-Code 1',
      output: 'line 1\nline 2\n',
    });
    const alert = s.t.app.hzCore.alerts.active(taskAlertKey(task.id));
    expect(alert).toMatchObject({ level: 'warn', title: 'Aufgabe „Backup-Skript“ fehlgeschlagen' });
    expect(alert?.body).not.toContain('backup.sh');

    exit = 0;
    await api(s, 'POST', `/api/tasks/${task.id}/run`);
    await settle(s);
    expect((await runsOf(s, task.id))[0]).toMatchObject({ state: 'ok', exitCode: 0 });
    expect(s.t.app.hzCore.alerts.active(taskAlertKey(task.id))).toBeNull();
    const okAlert = s.t.app.hzCore.alerts
      .list({ state: 'all', limit: 50 })
      .find((a) => a.key === taskAlertKey(task.id) && a.level === 'ok');
    expect(okAlert?.title).toBe('Aufgabe „Backup-Skript“ wieder erfolgreich');
  });

  it('command: a timeout is a failed run', async () => {
    const s = await setup({
      tasks: true,
      reply: (m) =>
        m.action === 'task.exec'
          ? ok(m, {
              exitCode: null,
              timedOut: true,
              durationMs: 5000,
              output: '',
              truncated: false,
            })
          : null,
    });
    grantStepUp(s.t);
    const task = await create(s, {
      action: { kind: 'command', command: 'sleep 999', timeoutSec: 5 },
      schedule: { type: 'interval', minutes: 60 },
      notifyOnFailure: false,
    });
    await api(s, 'POST', `/api/tasks/${task.id}/run`);
    await settle(s);
    expect((await runsOf(s, task.id))[0]).toMatchObject({
      state: 'failed',
      summary: 'Zeitüberschreitung nach 5 s',
    });
    // notifyOnFailure off: no alert.
    expect(s.t.app.hzCore.alerts.active(taskAlertKey(task.id))).toBeNull();
  });
});

describe('tasks: runs', () => {
  it('never overlaps: a due run while the last one runs is skipped and recorded', async () => {
    const held: Received[] = [];
    const reply: Reply = (m) => {
      if (m.action !== 'container.restart') return null;
      held.push(m);
      return 'silent';
    };
    const s = await setup({ reply });
    const task = await create(s, {
      action: { kind: 'container.restart', container: 'webapp' },
      schedule: { type: 'interval', minutes: 5 },
    });
    const first = await api(s, 'POST', `/api/tasks/${task.id}/run`);
    expect(first.statusCode).toBe(202);
    await until(() => held.length === 1);
    // A second manual start is refused while it runs.
    expect((await api(s, 'POST', `/api/tasks/${task.id}/run`)).statusCode).toBe(409);
    // The schedule comes due: skipped.
    s.t.clock.advance(5 * MIN);
    await s.t.app.hzCore.scheduler.tick();
    expect(held).toHaveLength(1);
    let runs = await runsOf(s, task.id);
    expect(runs.map((r) => r.state)).toEqual(['skipped', 'running']);
    expect(runs[0]?.summary).toBe('Läuft noch (übersprungen)');
    s.agent.send(ok(held[0] as Received));
    await settle(s);
    runs = await runsOf(s, task.id);
    expect(runs.map((r) => r.state)).toEqual(['skipped', 'ok']);
  });

  it('server offline: run recorded as failed "Server offline"', async () => {
    const s = await setup();
    const task = await create(s, {
      action: { kind: 'container.restart', container: 'webapp' },
      schedule: { type: 'interval', minutes: 5 },
    });
    s.agent.ws.terminate();
    await until(() => !s.t.app.hzCore.hub.isConnected(s.serverId));
    await api(s, 'POST', `/api/tasks/${task.id}/run`);
    await settle(s);
    expect((await runsOf(s, task.id))[0]).toMatchObject({
      state: 'failed',
      summary: 'Server offline',
    });
    expect(s.t.app.hzCore.alerts.active(taskAlertKey(task.id))?.level).toBe('warn');
  });

  it(`keeps the last ${TASK_RUNS_KEEP} runs per task`, async () => {
    const s = await setup();
    const task = await create(s, {
      action: { kind: 'container.restart', container: 'webapp' },
      schedule: { type: 'interval', minutes: 5 },
    });
    for (let i = 0; i < TASK_RUNS_KEEP + 5; i++) {
      s.t.clock.advance(1000);
      await api(s, 'POST', `/api/tasks/${task.id}/run`);
      await settle(s);
    }
    const n = s.t.db.sqlite
      .prepare('SELECT count(*) AS n FROM task_runs WHERE task_id = ?')
      .get(task.id) as { n: number };
    expect(n.n).toBe(TASK_RUNS_KEEP);
    const runs = await runsOf(s, task.id);
    expect(runs).toHaveLength(TASK_RUNS_KEEP);
    expect(runs[0]?.startedAt).toBe(s.t.clock.t);
  });

  it('list, delete (runs go with it, alert resolved) and audit', async () => {
    const s = await setup({
      reply: (m) => (m.action === 'container.restart' ? rpcFail(m, 'failed') : null),
    });
    const task = await create(s, {
      action: { kind: 'container.restart', container: 'webapp' },
      schedule: { type: 'interval', minutes: 5 },
    });
    await api(s, 'POST', `/api/tasks/${task.id}/run`);
    await settle(s);
    expect(s.t.app.hzCore.alerts.active(taskAlertKey(task.id))).not.toBeNull();
    const list = tasksResponseSchema.parse((await api(s, 'GET', '/api/tasks')).json());
    expect(list.tasks.map((x) => x.id)).toEqual([task.id]);
    expect(list.tasks[0]?.serverName).toBe('heimserver');
    expect(list.commandServers).toEqual([]);

    expect((await api(s, 'DELETE', `/api/tasks/${task.id}`)).statusCode).toBe(204);
    expect((await api(s, 'GET', `/api/tasks/${task.id}/runs`)).statusCode).toBe(404);
    expect(s.t.app.hzCore.alerts.active(taskAlertKey(task.id))).toBeNull();
    const n = s.t.db.sqlite.prepare('SELECT count(*) AS n FROM task_runs').get() as { n: number };
    expect(n.n).toBe(0);
    const actions = (
      s.t.db.sqlite
        .prepare("SELECT action FROM audit_log WHERE action LIKE 'task.%' ORDER BY id")
        .all() as { action: string }[]
    ).map((r) => r.action);
    expect(actions).toEqual(['task.create', 'task.run', 'task.delete']);
  });

  it('module off: no runs, alerts closed; on again: runs resume', async () => {
    const s = await setup();
    const task = await create(s, {
      action: { kind: 'container.restart', container: 'webapp' },
      schedule: { type: 'interval', minutes: 5 },
    });
    s.t.app.hzCore.modules.set({ tasks: false });
    await advance(s, 7 * MIN);
    expect(rpcsOf(s, 'container.restart')).toHaveLength(0);
    s.t.app.hzCore.modules.set({ tasks: true });
    // The missed slot is not caught up; the next one runs.
    await advance(s, 5 * MIN);
    expect(rpcsOf(s, 'container.restart')).toHaveLength(1);
    expect(s.t.app.hzCore.features.tasks.service.get(task.id)?.lastRun?.state).toBe('ok');
  });

  it('a container that is not known on the server is refused', async () => {
    const s = await setup({ containers: [info('webapp')] });
    const res = await api(s, 'POST', '/api/tasks', {
      serverId: s.serverId,
      name: 'X',
      action: { kind: 'container.restart', container: 'gibtsnicht' },
      schedule: { type: 'interval', minutes: 5 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('tasks: nextTaskRun', () => {
  it('picks the earliest slot of all days and times in HZ_TIMEZONE (Sunday = 7)', () => {
    // Wed 2026-11-25 13:00 local (UTC+1).
    const from = Date.UTC(2026, 10, 25, 12, 0, 0);
    const s = { type: 'weekly' as const, days: [7, 3], times: ['18:30', '12:00'] };
    expect(nextTaskRun(s, from)).toBe(Date.UTC(2026, 10, 25, 17, 30));
    // After the last slot on Wednesday: Sunday 12:00 local.
    expect(nextTaskRun(s, Date.UTC(2026, 10, 25, 17, 30))).toBe(Date.UTC(2026, 10, 29, 11, 0));
  });

  it('keeps the local time across the DST change', () => {
    // Sat 2027-03-27 12:00 UTC; Sunday 2027-03-28 is the switch to UTC+2.
    const from = Date.UTC(2027, 2, 27, 12, 0);
    const s = { type: 'weekly' as const, days: [1], times: ['04:00'] };
    // Monday 2027-03-29 04:00 local = 02:00 UTC.
    expect(nextTaskRun(s, from)).toBe(Date.UTC(2027, 2, 29, 2, 0));
  });
});

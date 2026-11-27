import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { errorResponseSchema, taskSchema, TASK_LIMIT_PER_SERVER, type Task } from '@hz/shared';
import { connectAgent, until, type Received, type WsClient } from './agent-helpers.js';
import { deriveSubkey } from '../src/crypto.js';
import { COMMAND_HASH_INFO } from '../src/tasks/service.js';
import { KEY, SAME_ORIGIN, type TestApp } from './helpers.js';
import {
  api,
  dropStepUp,
  grantStepUp,
  ok,
  rpcsOf,
  settle,
  withAutomation,
  type AutoSetup,
} from './tasks-helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

/** A command nobody else would print (assembled so scanners do not see one string). */
const MARKER = ['hzcmd', 'marker', '7f3a9c'].join('-');
const COMMAND = `echo ${MARKER} && /opt/homelab/bin/job.sh`;

async function setup(opts: Parameters<typeof withAutomation>[1] = {}): Promise<AutoSetup> {
  const s = await withAutomation(clients, {
    tasks: true,
    captureLogs: true,
    reply: (m) =>
      m.action === 'task.exec'
        ? ok(m, { exitCode: 0, timedOut: false, durationMs: 5, output: 'done\n', truncated: false })
        : null,
    ...opts,
  });
  t = s.t;
  return s;
}

const commandBody = (s: AutoSetup, over: Record<string, unknown> = {}) => ({
  serverId: s.serverId,
  name: 'Befehl',
  action: { kind: 'command', command: COMMAND, timeoutSec: 60 },
  schedule: { type: 'interval', minutes: 30 },
  ...over,
});

async function commandTask(s: AutoSetup): Promise<Task> {
  grantStepUp(s.t);
  const res = await api(s, 'POST', '/api/tasks', commandBody(s));
  expect(res.statusCode, res.body).toBe(201);
  dropStepUp(s.t);
  return taskSchema.parse(res.json());
}

const ID = 'abcdefgh12345678';
const ROUTES: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string }[] = [
  { method: 'GET', url: '/api/tasks' },
  { method: 'POST', url: '/api/tasks' },
  { method: 'PUT', url: `/api/tasks/${ID}` },
  { method: 'DELETE', url: `/api/tasks/${ID}` },
  { method: 'POST', url: `/api/tasks/${ID}/run` },
  { method: 'GET', url: `/api/tasks/${ID}/runs` },
  { method: 'GET', url: `/api/tasks/${ID}/command` },
];

describe('tasks security: auth and module switch', () => {
  it('every route answers 401 without a session', async () => {
    const s = await setup();
    for (const r of ROUTES) {
      const res = await s.t.app.inject({
        method: r.method,
        url: r.url,
        headers: SAME_ORIGIN,
        payload: {},
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('every route answers 404 module_disabled when the module is off', async () => {
    const s = await setup({ modules: { tasks: false } });
    for (const r of ROUTES) {
      const res = await api(
        s,
        r.method,
        r.url,
        r.method === 'GET' || r.method === 'DELETE' ? undefined : {},
      );
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
      expect(errorResponseSchema.parse(res.json()).error).toBe('module_disabled');
    }
  });
});

describe('tasks security: command tasks need step-up', () => {
  it('create without step-up: 403, nothing stored', async () => {
    const s = await setup();
    dropStepUp(s.t);
    const res = await api(s, 'POST', '/api/tasks', commandBody(s));
    expect(res.statusCode).toBe(403);
    expect(errorResponseSchema.parse(res.json()).error).toBe('step_up_required');
    const n = s.t.db.sqlite.prepare('SELECT count(*) AS n FROM scheduled_tasks').get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });

  it('edit, manual run and reading the command need step-up; other kinds do not', async () => {
    const s = await setup();
    const task = await commandTask(s);
    for (const [method, url, body] of [
      ['PUT', `/api/tasks/${task.id}`, { enabled: false }],
      ['POST', `/api/tasks/${task.id}/run`, undefined],
      ['GET', `/api/tasks/${task.id}/command`, undefined],
    ] as const) {
      const res = await api(s, method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(errorResponseSchema.parse(res.json()).error).toBe('step_up_required');
    }
    expect(rpcsOf(s, 'task.exec')).toHaveLength(0);

    // Turning a plain task into a command task needs step-up as well.
    const plain = await api(s, 'POST', '/api/tasks', {
      serverId: s.serverId,
      name: 'Plain',
      action: { kind: 'system.cleanup' },
      schedule: { type: 'interval', minutes: 30 },
    });
    expect(plain.statusCode).toBe(201);
    const plainId = taskSchema.parse(plain.json()).id;
    const turn = await api(s, 'PUT', `/api/tasks/${plainId}`, {
      action: { kind: 'command', command: COMMAND },
    });
    expect(turn.statusCode).toBe(403);
    // A plain task is edited and run without step-up.
    expect((await api(s, 'PUT', `/api/tasks/${plainId}`, { name: 'Neu' })).statusCode).toBe(200);
    expect((await api(s, 'POST', `/api/tasks/${plainId}/run`)).statusCode).toBe(202);
    await settle(s);

    grantStepUp(s.t);
    const cmd = await api(s, 'GET', `/api/tasks/${task.id}/command`);
    expect(cmd.statusCode).toBe(200);
    expect(cmd.json()).toEqual({ command: COMMAND });
    expect((await api(s, 'POST', `/api/tasks/${task.id}/run`)).statusCode).toBe(202);
    await settle(s);
    expect(rpcsOf(s, 'task.exec')).toHaveLength(1);
    // GET command of a non-command task: 404.
    expect((await api(s, 'GET', `/api/tasks/${plainId}/command`)).statusCode).toBe(404);
  });

  it('the command is in no response, no log, no audit entry, no alert; only encrypted in the DB', async () => {
    const s = await setup({
      reply: (m) =>
        m.action === 'task.exec'
          ? ok(m, { exitCode: 3, timedOut: false, durationMs: 5, output: 'x\n', truncated: false })
          : null,
    });
    const bodies: string[] = [];
    grantStepUp(s.t);
    const created = await api(s, 'POST', '/api/tasks', commandBody(s));
    bodies.push(created.body);
    const task = taskSchema.parse(created.json());
    expect(task.action).toEqual({
      kind: 'command',
      timeoutSec: 60,
      commandHash: expect.stringMatching(/^[0-9a-f]{8}$/) as unknown as string,
    });
    const upd = await api(s, 'PUT', `/api/tasks/${task.id}`, {
      action: { kind: 'command', command: `${COMMAND} --again`, timeoutSec: 90 },
    });
    bodies.push(upd.body);
    expect(taskSchema.parse(upd.json()).action).not.toEqual(task.action);
    bodies.push((await api(s, 'POST', `/api/tasks/${task.id}/run`)).body);
    await settle(s);
    bodies.push((await api(s, 'GET', '/api/tasks')).body);
    bodies.push((await api(s, 'GET', `/api/tasks/${task.id}/runs`)).body);
    // Invalid inputs with the command inside are not echoed either.
    bodies.push(
      (
        await api(s, 'POST', '/api/tasks', {
          ...commandBody(s),
          action: { kind: 'command', command: `${COMMAND}\nrm -rf /` },
        })
      ).body,
    );
    bodies.push((await api(s, 'GET', '/api/alerts?state=all')).body);
    for (const b of bodies) expect(b).not.toContain(MARKER);

    const logs = s.t.logs.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(MARKER);
    const dump = JSON.stringify([
      s.t.db.sqlite.prepare('SELECT * FROM audit_log').all(),
      s.t.db.sqlite.prepare('SELECT * FROM alerts').all(),
      s.t.db.sqlite.prepare('SELECT * FROM task_runs').all(),
      s.t.db.sqlite.prepare('SELECT * FROM scheduled_tasks').all(),
    ]);
    expect(dump).not.toContain(MARKER);
    // The hash is keyed: not sha256(command), so a short command cannot be confirmed by guessing.
    const updated = taskSchema.parse(upd.json()).action;
    const hash = updated.kind === 'command' ? updated.commandHash : '';
    const again = `${COMMAND} --again`;
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(hash).not.toBe(createHash('sha256').update(again).digest('hex').slice(0, 8));
    expect(hash).toBe(
      createHmac('sha256', deriveSubkey(Buffer.from(KEY, 'base64'), COMMAND_HASH_INFO))
        .update(again)
        .digest('hex')
        .slice(0, 8),
    );
    const row = s.t.db.sqlite.prepare('SELECT command_enc FROM scheduled_tasks').get() as {
      command_enc: string;
    };
    expect(row.command_enc).toMatch(/^v1:/);
  });
});

describe('tasks security: capabilities.tasks', () => {
  it('a command task is refused without capabilities.tasks (409), and the list says so', async () => {
    const s = await setup({ tasks: false });
    grantStepUp(s.t);
    const res = await api(s, 'POST', '/api/tasks', commandBody(s));
    expect(res.statusCode).toBe(409);
    expect(errorResponseSchema.parse(res.json()).message).toContain('HZ_AGENT_ALLOW_TASKS');
    const list = (await api(s, 'GET', '/api/tasks')).json<{ commandServers: string[] }>();
    expect(list.commandServers).toEqual([]);
  });

  it('an agent that lost capabilities.tasks gets no task.exec; the run fails', async () => {
    const s = await setup();
    const task = await commandTask(s);
    expect(
      (await api(s, 'GET', '/api/tasks')).json<{ commandServers: string[] }>().commandServers,
    ).toEqual([s.serverId]);
    // The agent restarts without HZ_AGENT_ALLOW_TASKS.
    s.agent.ws.terminate();
    await until(() => !s.t.app.hzCore.hub.isConnected(s.serverId));
    const again = await reconnectWithoutTasks(s);
    clients.push(again);
    grantStepUp(s.t);
    expect((await api(s, 'POST', `/api/tasks/${task.id}/run`)).statusCode).toBe(202);
    await settle(s);
    const runs = (await api(s, 'GET', `/api/tasks/${task.id}/runs`)).json<{
      runs: { state: string; summary: string }[];
    }>().runs;
    expect(runs[0]).toMatchObject({ state: 'failed', summary: 'Agent erlaubt keine Befehle' });
    expect(rpcsOf(s, 'task.exec')).toHaveLength(0);
  });
});

/** Reconnects the sim agent with its permanent token, capabilities.tasks absent. */
async function reconnectWithoutTasks(s: AutoSetup): Promise<WsClient> {
  // connectAgent sends a hello without capabilities.tasks.
  const enrolled = s.agent.received.find((m) => m.type === 'enrolled') as Received | undefined;
  const agentToken = enrolled?.agentToken as string;
  const agent = await connectAgent(s.url, agentToken);
  agent.ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as Received;
    if (m.type === 'rpc') {
      s.rpcs.push(m);
      agent.send(ok(m));
    }
  });
  expect(s.t.app.hzCore.hub.capabilities(s.serverId)?.tasks).toBeUndefined();
  return agent;
}

describe('tasks security: protected containers and limits', () => {
  it('hz.role containers are refused for every container kind', async () => {
    const s = await setup();
    for (const kind of ['container.restart', 'container.start', 'container.stop']) {
      const res = await api(s, 'POST', '/api/tasks', {
        serverId: s.serverId,
        name: 'Agent',
        action: { kind, container: 'hz-agent' },
        schedule: { type: 'interval', minutes: 30 },
      });
      expect(res.statusCode, kind).toBe(403);
    }
    // Also not by editing an existing task.
    const created = await api(s, 'POST', '/api/tasks', {
      serverId: s.serverId,
      name: 'Web',
      action: { kind: 'container.restart', container: 'webapp' },
      schedule: { type: 'interval', minutes: 30 },
    });
    const id = taskSchema.parse(created.json()).id;
    const res = await api(s, 'PUT', `/api/tasks/${id}`, {
      action: { kind: 'container.stop', container: 'hz-agent' },
    });
    expect(res.statusCode).toBe(403);
  });

  it(`at most ${TASK_LIMIT_PER_SERVER} tasks per server`, async () => {
    const s = await setup();
    const insert = s.t.db.sqlite.prepare(
      `INSERT INTO scheduled_tasks (id, server_id, name, kind, action_json, schedule_json, created_at, updated_at)
       VALUES (?, ?, 'x', 'system.cleanup', '{"kind":"system.cleanup"}', '{"type":"interval","minutes":30}', 0, 0)`,
    );
    for (let i = 0; i < TASK_LIMIT_PER_SERVER; i++)
      insert.run(`task-${String(i).padStart(4, '0')}`, s.serverId);
    const res = await api(s, 'POST', '/api/tasks', {
      serverId: s.serverId,
      name: 'Zu viel',
      action: { kind: 'system.cleanup' },
      schedule: { type: 'interval', minutes: 30 },
    });
    expect(res.statusCode).toBe(409);
  });

  it('unknown server: 404; unknown task: 404', async () => {
    const s = await setup();
    const res = await api(s, 'POST', '/api/tasks', {
      serverId: 'unknownserver123',
      name: 'X',
      action: { kind: 'system.cleanup' },
      schedule: { type: 'interval', minutes: 30 },
    });
    expect(res.statusCode).toBe(404);
    expect((await api(s, 'PUT', `/api/tasks/${ID}`, { name: 'x' })).statusCode).toBe(404);
    expect((await api(s, 'DELETE', `/api/tasks/${ID}`)).statusCode).toBe(404);
  });
});

describe('tasks security: schema limits', () => {
  it('rejects invalid input with 400', async () => {
    const s = await setup();
    grantStepUp(s.t);
    const base = {
      serverId: s.serverId,
      name: 'Gut',
      action: { kind: 'system.cleanup' },
      schedule: { type: 'interval', minutes: 30 },
    };
    const bad: Record<string, unknown>[] = [
      { ...base, schedule: { type: 'interval', minutes: 4 } },
      { ...base, schedule: { type: 'interval', minutes: 7 * 24 * 60 + 1 } },
      { ...base, schedule: { type: 'weekly', days: [1, 1], times: ['04:00'] } },
      { ...base, schedule: { type: 'weekly', days: [8], times: ['04:00'] } },
      { ...base, schedule: { type: 'weekly', days: [1], times: ['24:00'] } },
      { ...base, schedule: { type: 'weekly', days: [1], times: [] } },
      { ...base, name: '' },
      { ...base, name: 'x'.repeat(61) },
      { ...base, name: 'bad<script>' },
      { ...base, extra: true },
      { ...base, action: { kind: 'command', command: 'echo a\necho b' } },
      { ...base, action: { kind: 'command', command: '   ' } },
      { ...base, action: { kind: 'command', command: 'x'.repeat(2001) } },
      { ...base, action: { kind: 'command', command: 'ls', timeoutSec: 4 } },
      { ...base, action: { kind: 'command', command: 'ls', timeoutSec: 1801 } },
      { ...base, action: { kind: 'compose.update', dir: '/etc' } },
      { ...base, action: { kind: 'compose.update', dir: '/opt/homelab/../etc' } },
      { ...base, action: { kind: 'container.restart', container: '../x' } },
      { ...base, action: { kind: 'shell', command: 'ls' } },
      { ...base, action: { kind: 'system.cleanup', command: 'ls' } },
    ];
    for (const b of bad) {
      const res = await api(s, 'POST', '/api/tasks', b);
      expect(res.statusCode, JSON.stringify(b).slice(0, 120)).toBe(400);
    }
    expect((await api(s, 'PUT', `/api/tasks/${ID}`, {})).statusCode).toBe(400);
    expect((await api(s, 'GET', '/api/tasks/bad!id/runs')).statusCode).toBe(400);
  });
});

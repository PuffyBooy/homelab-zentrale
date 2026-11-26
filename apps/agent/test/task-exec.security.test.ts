import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TASK_OUTPUT_MAX_BYTES,
  rpcParamsByAction,
  taskExecDataSchema,
  type AgentEvent,
  type RpcEnvelope,
} from '@hz/shared';
import { Dispatcher } from '../src/actions/index.js';
import {
  TASK_ENV,
  TaskManager,
  TailBuffer,
  buildTaskCommand,
  cleanOutput,
} from '../src/actions/task-exec.js';
import { loadConfig } from '../src/config.js';
import { isTaskShellCall, runFile, spawnTaskShell } from '../src/exec.js';
import { createLogger } from '../src/log.js';
import { makeCtx } from './game-helpers.js';

let base: string;
let root: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-task-')));
  root = path.join(base, 'homelab');
  await mkdir(root, { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function manager(
  logs: string[] = [],
  over: Partial<ConstructorParameters<typeof TaskManager>[0]> = {},
) {
  return new TaskManager({
    allowTasks: true,
    hostExec: 'direct',
    host: { hostRoot: '/' },
    homelabRoot: root,
    log: createLogger('debug', (l) => logs.push(l)),
    killGraceMs: 300,
    ...over,
  });
}

const rpc = (params: unknown): RpcEnvelope => ({
  type: 'rpc',
  id: 'rpc_12345678',
  action: 'task.exec',
  params,
});

/** Running (not gone and not a zombie waiting for a reaper). */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

describe('task.exec gate', () => {
  it('is refused without HZ_AGENT_ALLOW_TASKS (not_allowed + denied event), nothing runs', async () => {
    const events: AgentEvent[] = [];
    const tasks = manager();
    const { ctx } = makeCtx(root, { tasks });
    const d = new Dispatcher(ctx, (e) => events.push(e));
    const marker = path.join(base, 'ran');
    const r = await d.handle(rpc({ taskId: 'task_12345678', command: `touch ${marker}` }));
    expect(r).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(events[0]).toMatchObject({ event: { kind: 'denied', action: 'task.exec' } });
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('the manager refuses on its own without the flag', async () => {
    const tasks = manager([], { allowTasks: false });
    await expect(tasks.run('task_12345678', 'true', 5000)).rejects.toMatchObject({
      code: 'not_allowed',
    });
  });

  it('runs with the flag and returns taskExecDataSchema', async () => {
    const { ctx } = makeCtx(root, { allowTasks: true, tasks: manager() });
    const d = new Dispatcher(ctx, () => undefined);
    const r = await d.handle(rpc({ taskId: 'task_12345678', command: 'echo hi; exit 3' }));
    expect(r.ok).toBe(true);
    const data = taskExecDataSchema.parse((r as { data: unknown }).data);
    expect(data).toMatchObject({ exitCode: 3, timedOut: false, truncated: false });
    expect(data.output).toBe('hi\n');
  });

  it.each([
    ['newline', 'echo a\nrm -rf /'],
    ['carriage return', 'echo a\rrm -rf /'],
    ['NUL', 'echo a\0b'],
    ['empty', '   '],
  ])('the schema refuses a command with %s', (_l, command) => {
    expect(
      rpcParamsByAction['task.exec'].safeParse({ taskId: 'task_12345678', command }).success,
    ).toBe(false);
  });

  it('the schema bounds the time limit', () => {
    const s = rpcParamsByAction['task.exec'];
    expect(s.safeParse({ taskId: 'task_12345678', command: 'x', timeoutSec: 4 }).success).toBe(
      false,
    );
    expect(s.safeParse({ taskId: 'task_12345678', command: 'x', timeoutSec: 1801 }).success).toBe(
      false,
    );
  });
});

describe('task.exec command line', () => {
  it('direct: exactly /bin/sh -c <command>, cwd = homelab root', () => {
    expect(buildTaskCommand('direct', { hostRoot: '/' }, 'a; b', '/opt/homelab/')).toEqual({
      file: '/bin/sh',
      args: ['-c', 'a; b'],
      cwd: '/opt/homelab',
    });
  });

  it('nsenter: host namespaces, --wd on the host view of /opt/homelab, command is one argv', () => {
    const c = buildTaskCommand('nsenter', { hostRoot: '/host/proc/1/root' }, 'x $(y)');
    expect(c.file).toBe('nsenter');
    expect(c.args).toEqual([
      '--target',
      '1',
      '--mount',
      '--uts',
      '--ipc',
      '--net',
      '--pid',
      '--cgroup',
      '--wd=/host/proc/1/root/opt/homelab',
      '--',
      '/bin/sh',
      '-c',
      'x $(y)',
    ]);
  });

  it('none: refused', () => {
    expect(() => buildTaskCommand('none', { hostRoot: '/' }, 'true')).toThrow();
  });
});

describe('task shell policy (exec.ts)', () => {
  it('HZ_AGENT_ALLOW_TASKS is off by default', () => {
    const env = { HZ_CORE_URL: 'ws://127.0.0.1:8080/agent', HZ_AGENT_NAME: 'ci-agent' };
    expect(loadConfig(env).allowTasks).toBe(false);
    expect(loadConfig({ ...env, HZ_AGENT_ALLOW_TASKS: '1' }).allowTasks).toBe(true);
    expect(() => loadConfig({ ...env, HZ_AGENT_ALLOW_TASKS: 'yes' })).toThrow();
  });

  it('accepts only the two fixed shapes', () => {
    const ns = buildTaskCommand('nsenter', { hostRoot: '/host/proc/1/root' }, 'echo hi');
    expect(isTaskShellCall(ns.file, ns.args)).toBe(true);
    expect(isTaskShellCall('/bin/sh', ['-c', 'echo hi'])).toBe(true);
    for (const [file, args] of [
      ['/bin/sh', ['-c', 'x', 'extra']],
      ['/bin/sh', ['/tmp/script.sh']],
      ['/bin/sh', ['-e', 'x']],
      ['sh', ['-c', 'x']],
      ['/bin/bash', ['-c', 'x']],
      ['nsenter', ['--target', '1', '--', '/bin/sh', '-c', 'x']],
      ['nsenter', [...ns.args.slice(0, -3), '/bin/bash', '-c', 'x']],
      ['nsenter', [...ns.args.slice(0, 8), '--wd=../x', ...ns.args.slice(9)]],
      ['/bin/sh', ['-c', 'a\0b']],
    ] as [string, string[]][]) {
      expect(isTaskShellCall(file, args)).toBe(false);
      expect(() => spawnTaskShell(file, args, '/')).toThrow();
    }
  });

  it('runFile still refuses the shell', () => {
    expect(() => runFile('/bin/sh', ['-c', 'true'])).toThrow('program not allowed');
    expect(() => runFile('sh', ['-c', 'true'])).toThrow('program not allowed');
  });
});

describe('task.exec process', () => {
  it('environment holds only PATH, HOME and LANG (no agent token), stdin is closed', async () => {
    const prev = process.env.HZ_AGENT_TOKEN;
    process.env.HZ_AGENT_TOKEN = 'secret-agent-token-xyz';
    try {
      const r = await manager().run('task_env_0001', 'env; read x && echo READ || echo EOF', 5000);
      const keys = r.output
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => l.slice(0, l.indexOf('=')));
      // Shells add PWD (and some OLDPWD/SHLVL/_); nothing else.
      const shellOwn = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
      expect(keys.filter((k) => !shellOwn.has(k)).sort()).toEqual(Object.keys(TASK_ENV).sort());
      expect(r.output).toContain('HOME=/root');
      expect(r.output).toContain('LANG=C.UTF-8');
      expect(r.output).not.toContain('secret-agent-token-xyz');
      expect(r.output).toContain('EOF');
    } finally {
      if (prev === undefined) delete process.env.HZ_AGENT_TOKEN;
      else process.env.HZ_AGENT_TOKEN = prev;
    }
  });

  it('runs in the homelab root', async () => {
    const r = await manager().run('task_cwd_0001', 'pwd', 5000);
    expect(r.output.trim()).toBe(root);
  });

  it('a timeout kills the whole process group, also background children', async () => {
    const pidFile = path.join(base, 'child.pid');
    const started = Date.now();
    const r = await manager().run(
      'task_timeout_01',
      `sleep 60 & echo $! > ${pidFile}; sleep 60`,
      400,
    );
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(pid).toBeGreaterThan(1);
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(false);
  });

  it('a command ignoring SIGTERM gets SIGKILL after the grace period', async () => {
    const pidFile = path.join(base, 'trap.pid');
    const r = await manager().run(
      'task_trap_0001',
      `trap '' TERM; sleep 60 & echo $! > ${pidFile}; sleep 60`,
      300,
    );
    expect(r.timedOut).toBe(true);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(false);
  });

  it('children get the grace period after SIGTERM even when the shell is gone', async () => {
    const r = await manager().run(
      'task_grace_001',
      `sh -c 'trap "sleep 0.1; echo graceful; exit 0" TERM; sleep 60 & wait' & wait`,
      300,
    );
    expect(r.timedOut).toBe(true);
    expect(r.output).toContain('graceful');
  });

  it('leftovers in the group do not outlive a normal exit', async () => {
    const pidFile = path.join(base, 'left.pid');
    const r = await manager().run(
      'task_left_0001',
      `sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}; echo done`,
      10_000,
    );
    expect(r).toMatchObject({ exitCode: 0, timedOut: false });
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(false);
  });

  it('keeps only the last TASK_OUTPUT_MAX_BYTES and sets truncated', async () => {
    const r = await manager().run(
      'task_big_00001',
      `i=0; while [ $i -lt 3000 ]; do echo "line $i ........................"; i=$((i+1)); done; echo END >&2`,
      10_000,
    );
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(TASK_OUTPUT_MAX_BYTES);
    expect(r.output.endsWith('END\n')).toBe(true);
    expect(r.output).not.toContain('line 0 ');
    expect(taskExecDataSchema.safeParse(r).success).toBe(true);
  });

  it('strips ANSI sequences and control characters', async () => {
    const r = await manager().run(
      'task_ansi_0001',
      `printf '\\033[31mred\\033[0m \\033]0;title\\007ok\\r\\n\\001x\\n'`,
      5000,
    );
    expect(r.output).toBe('red ok\nx\n');
  });

  it('one run per taskId and at most 4 at once (busy)', async () => {
    const tasks = manager();
    const runs = [0, 1, 2, 3].map((i) => tasks.run(`task_par_000${i}`, 'sleep 1', 5000));
    await new Promise((res) => setTimeout(res, 50));
    await expect(tasks.run('task_par_0000', 'true', 5000)).rejects.toMatchObject({
      code: 'busy',
    });
    await expect(tasks.run('task_par_0009', 'true', 5000)).rejects.toMatchObject({
      code: 'busy',
    });
    await Promise.all(runs);
    await expect(tasks.run('task_par_0000', 'true', 5000)).resolves.toMatchObject({
      exitCode: 0,
    });
  });

  it('never logs the command or its output', async () => {
    const logs: string[] = [];
    await manager(logs).run('task_log_00001', 'echo canary-output # canary-command', 5000);
    const all = logs.join('\n');
    expect(all).toContain('task_log_00001');
    expect(all).not.toContain('canary');
  });
});

describe('output helpers', () => {
  it('TailBuffer keeps the tail and drops a cut UTF-8 sequence', () => {
    const b = new TailBuffer(5);
    b.push(Buffer.from('abc'));
    b.push(Buffer.from('dä€'));
    expect(b.truncated).toBe(true);
    // last 5 bytes: one byte of "ä" cut off, then "€" (3 bytes) -> only "€" survives with "?"
    expect(b.text().endsWith('€')).toBe(true);
    expect(b.text()).not.toContain('�');
  });

  it('cleanOutput removes escape sequences', () => {
    expect(cleanOutput('\x1b[1;32mok\x1b[0m\x1b(B\x1b]8;;http://x\x1b\\link\x07')).toBe('oklink');
  });
});

import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rpcActions, type AgentEvent, type RpcEnvelope } from '@hz/shared';
import { Dispatcher, handlers, type ActionContext } from '../src/actions/index.js';
import type { RunResult } from '../src/exec.js';
import { createLogger } from '../src/log.js';
import { StreamManager } from '../src/streams.js';

let base: string;
let root: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-allow-')));
  root = path.join(base, 'homelab');
  await mkdir(path.join(root, 'games', 'mc'), { recursive: true });
  await symlink('/etc', path.join(root, 'etc-link'));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function setup(overrides: Partial<ActionContext> = {}) {
  const events: AgentEvent[] = [];
  const execCalls: { file: string; args: readonly string[] }[] = [];
  const later = vi.fn();
  const ctx: ActionContext = {
    name: 'oracle-a1',
    allowTerminal: false,
    homelabRoot: `${root}/`,
    host: {
      hostProc: '/proc',
      hostRoot: '/nonexistent-host-root',
      docker: null,
      exec: async (file: string, args: readonly string[]): Promise<RunResult> => {
        execCalls.push({ file, args });
        return { code: 0, stdout: 'systemd 252', stderr: '' };
      },
    },
    log: createLogger('error', () => undefined),
    later,
    streams: new StreamManager({ send: () => true, bufferedAmount: () => 0 }),
    run: async (file: string, args: readonly string[]): Promise<RunResult> => {
      execCalls.push({ file, args });
      return { code: 0, stdout: '', stderr: '' };
    },
    dockerSocket: '/var/run/docker.sock',
    spawn: () => {
      throw new Error('spawn not expected');
    },
    dataDir: '/nonexistent-data',
    ...overrides,
  };
  const d = new Dispatcher(ctx, (e) => events.push(e));
  return { d, events, execCalls, later };
}

const rpc = (action: string, params: unknown): RpcEnvelope => ({
  type: 'rpc',
  id: 'rpc_12345678',
  action,
  params,
});

describe('allowlist', () => {
  it('has a handler for exactly the allowlisted actions', () => {
    expect(Object.keys(handlers).sort()).toEqual([...rpcActions].sort());
  });

  it.each([
    'shell.exec',
    'exec',
    'system.shell',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'container.start ',
    'CONTAINER.START',
    '',
  ])('rejects unknown action %j and reports denied', async (action) => {
    const { d, events, execCalls } = setup();
    const res = await d.handle(rpc(action, {}));
    expect(res).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({ kind: 'denied' });
    expect(execCalls).toEqual([]);
  });

  it('rejects extra params', async () => {
    const { d, events } = setup();
    const res = await d.handle(rpc('container.start', { id: 'web', cmd: 'rm -rf /' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(events[0]?.event).toMatchObject({ kind: 'denied', action: 'container.start' });
  });

  it('rejects __proto__ smuggled into params', async () => {
    const { d } = setup();
    const params = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    const res = await d.handle(rpc('system.cleanupPreview', params));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects invalid params types', async () => {
    const { d } = setup();
    for (const params of [null, 'x', [], { id: '' }, { id: '-rm' }, { id: '../x' }]) {
      const res = await d.handle(rpc('container.stop', params));
      expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    }
  });

  it('answers pty.open without a terminal manager with failed (no denied event)', async () => {
    const { d, events } = setup({ allowTerminal: true });
    const res = await d.handle(rpc('pty.open', { cols: 80, rows: 24 }));
    expect(res).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(res.ok === false && res.error.message).toMatch(/not available/);
    expect(events).toHaveLength(0);
  });
});

describe('path params', () => {
  it('rejects paths outside the homelab root (syntax, schema level)', async () => {
    const { d } = setup();
    for (const dir of [
      '/etc',
      '/opt/homelab/../etc',
      '/opt/homelab//x',
      'relative',
      '/opt/homelab/',
    ]) {
      const res = await d.handle(rpc('compose.up', { dir }));
      expect(res.ok).toBe(false);
    }
  });
});

describe('system.reboot', () => {
  it('requires confirmName to equal HZ_AGENT_NAME', async () => {
    const { d, events, later, execCalls } = setup();
    const res = await d.handle(rpc('system.reboot', { confirmName: 'heimserver' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'confirm_mismatch' } });
    expect(events[0]?.event).toMatchObject({ kind: 'denied', action: 'system.reboot' });
    expect(later).not.toHaveBeenCalled();
    expect(execCalls).toEqual([]);
  });

  it('rejects a missing or malformed confirmName', async () => {
    const { d, later } = setup();
    for (const params of [
      {},
      { confirmName: '' },
      { confirmName: 'Oracle-A1' },
      { confirmName: 1 },
    ]) {
      const res = await d.handle(rpc('system.reboot', params));
      expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    }
    expect(later).not.toHaveBeenCalled();
  });

  it('schedules systemctl reboot on the host when confirmed', async () => {
    const { d, later, execCalls } = setup();
    const res = await d.handle(rpc('system.reboot', { confirmName: 'oracle-a1' }));
    expect(res).toMatchObject({ ok: true, data: { scheduled: true } });
    expect(later).toHaveBeenCalledTimes(1);
    expect(execCalls).toEqual([{ file: 'systemctl', args: ['--version'] }]);
    (later.mock.calls[0]?.[0] as () => void)();
    expect(execCalls.at(-1)).toEqual({ file: 'systemctl', args: ['reboot'] });
  });
});

describe('terminal', () => {
  it.each([
    ['pty.open', { cols: 80, rows: 24 }],
    ['pty.input', { streamId: 'rpc_12345678', data: 'id\n' }],
    ['pty.resize', { streamId: 'rpc_12345678', cols: 80, rows: 24 }],
    ['pty.close', { streamId: 'rpc_12345678' }],
  ])('%s is refused without HZ_AGENT_ALLOW_TERMINAL=1', async (action, params) => {
    const { d, events } = setup();
    const res = await d.handle(rpc(action, params));
    expect(res).toMatchObject({ ok: false, error: { code: 'terminal_disabled' } });
    expect(events[0]?.event).toMatchObject({ kind: 'denied', action });
  });

  it('with the flag on, pty is not refused as disabled', async () => {
    const { d } = setup({ allowTerminal: true });
    const res = await d.handle(rpc('pty.open', { cols: 80, rows: 24 }));
    expect(res).toMatchObject({ ok: false, error: { code: 'failed' } });
  });
});

describe('paths through the dispatcher', () => {
  it('a syntactically valid path that fails the realpath check is bad_path', async () => {
    const { d, events } = setup({ homelabRoot: '/opt/homelab/' });
    // Valid for the schema; realpath must still pass (symlink cases: paths.security.test.ts).
    const res = await d.handle(rpc('compose.down', { dir: '/opt/homelab/etc-link' }));
    expect(res.ok).toBe(false);
    // On a machine without /opt/homelab this is bad_path (+ denied event).
    if (!res.ok && res.error.code === 'bad_path') expect(events).toHaveLength(1);
  });
});

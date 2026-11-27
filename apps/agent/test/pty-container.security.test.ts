import { describe, expect, it } from 'vitest';
import type { RpcResult } from '@hz/shared';
import {
  CONTAINER_SHELL_SCRIPT,
  PTY_ENV,
  PtyManager,
  buildContainerPtyCommand,
  type PtyProcess,
  type PtySpawnRequest,
} from '../src/actions/pty.js';
import { PROGRAMS } from '../src/exec.js';
import { createLogger } from '../src/log.js';
import { StreamManager } from '../src/streams.js';
import { rpc } from './admin-helpers.js';
import { AGENT_ID, APP_ID, newState, setupDocker, at } from './docker-fakes.js';

class FakePty implements PtyProcess {
  static next = 950_000;
  readonly pid = FakePty.next++;
  written: string[] = [];
  onData(): void {}
  onExit(): void {}
  write(d: string): void {
    this.written.push(d);
  }
  resize(): void {}
  pause(): void {}
  resume(): void {}
}

const DOCKER_SOCKET = '/run/hz/docker.sock';

function setup(opts: { allowTerminal?: boolean; hostShell?: boolean } = {}) {
  const allow = opts.allowTerminal ?? true;
  const st = newState();
  at(st.containers, 1).State = 'running';
  const logs: string[] = [];
  const log = createLogger('debug', (l) => logs.push(l));
  const spawned: PtySpawnRequest[] = [];
  const streams = new StreamManager({ send: () => true, bufferedAmount: () => 0 });
  const pty = new PtyManager({
    allowTerminal: allow,
    hostExec: 'nsenter',
    host: { hostRoot: '/nonexistent' },
    streams,
    log,
    dockerSocket: DOCKER_SOCKET,
    command: async () => ({ file: 'nsenter', args: ['--target', '1'], shell: '/bin/bash' }),
    spawner: (req) => {
      spawned.push(req);
      return new FakePty();
    },
    killSession: async () => undefined,
  });
  const s = setupDocker(st, undefined, { allowTerminal: allow, pty, streams, log });
  let n = 0;
  const open = async (params: unknown): Promise<RpcResult> => {
    const env = { ...rpc('pty.open', params), id: `rpc_ptyc${String(++n).padStart(8, '0')}` };
    const r = await s.d.handle(env);
    s.d.resultSent(r, true);
    return r;
  };
  return { ...s, st, spawned, logs, pty, open };
}

describe('pty.open with a container', () => {
  it('spawns docker exec with a fixed argv and the full id from inspect', async () => {
    const s = setup();
    const r = await s.open({ cols: 80, rows: 24, container: 'web' });
    expect(r.ok).toBe(true);
    expect(s.spawned).toHaveLength(1);
    const req = at(s.spawned, 0);
    expect(req.file).toBe('docker');
    expect(PROGRAMS.has(req.file)).toBe(true);
    expect(req.args).toEqual([
      'exec',
      '-i',
      '-t',
      '-e',
      'TERM=xterm-256color',
      '-e',
      'LANG=C.UTF-8',
      APP_ID,
      '/bin/sh',
      '-c',
      CONTAINER_SHELL_SCRIPT,
    ]);
    expect(req.args).not.toContain('web');
    expect(req.env).toEqual({ ...PTY_ENV, DOCKER_HOST: `unix://${DOCKER_SOCKET}` });
    expect(Object.keys(req.env).some((k) => /TOKEN|HZ_/.test(k))).toBe(false);
    const opened = s.logs.find((l) => l.includes('terminal opened')) ?? '';
    expect(opened).toContain(APP_ID.slice(0, 12));
    expect(opened).toContain('web');
  });

  it('without container the host shell is unchanged', async () => {
    const s = setup();
    expect((await s.open({ cols: 80, rows: 24 })).ok).toBe(true);
    expect(s.spawned[0]).toMatchObject({ file: 'nsenter', env: PTY_ENV });
    expect(s.st.calls).toEqual([]);
  });

  it('a container ref cannot inject arguments (schema) and docker is not asked', async () => {
    const s = setup();
    for (const container of ['--privileged', '-u', 'web --user root', 'web;sh', '../x', '']) {
      const r = await s.open({ cols: 80, rows: 24, container });
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    }
    expect(s.spawned).toEqual([]);
    expect(s.st.calls).toEqual([]);
  });

  it('refuses the agent (not_allowed), a missing (not_found) and a stopped container (busy)', async () => {
    const s = setup();
    expect(await s.open({ cols: 80, rows: 24, container: AGENT_ID })).toMatchObject({
      ok: false,
      error: { code: 'not_allowed' },
    });
    expect(await s.open({ cols: 80, rows: 24, container: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    for (const state of ['exited', 'paused', 'restarting']) {
      at(s.st.containers, 1).State = state;
      expect(await s.open({ cols: 80, rows: 24, container: 'web' })).toMatchObject({
        ok: false,
        error: { code: 'busy' },
      });
    }
    expect(s.spawned).toEqual([]);
  });

  it('is refused with terminal_disabled before docker is asked', async () => {
    const s = setup({ allowTerminal: false });
    const r = await s.open({ cols: 80, rows: 24, container: 'web' });
    expect(r).toMatchObject({ ok: false, error: { code: 'terminal_disabled' } });
    expect(s.st.calls).toEqual([]);
    expect(s.spawned).toEqual([]);
  });

  it('shares the MAX_PTYS limit with host shells', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++)
      expect((await s.open({ cols: 80, rows: 24, container: 'web' })).ok).toBe(true);
    expect(await s.open({ cols: 80, rows: 24 })).toMatchObject({
      ok: false,
      error: { code: 'busy' },
    });
    s.pty.closeAll();
  });

  it('input is never logged', async () => {
    const s = setup();
    const r = await s.open({ cols: 80, rows: 24, container: 'web' });
    if (!r.ok) throw new Error('open failed');
    const streamId = (r.data as { streamId: string }).streamId;
    await s.d.handle(rpc('pty.input', { streamId, data: 'echo hunter2\n' }));
    expect(s.logs.join('\n')).not.toContain('hunter2');
    s.pty.closeAll();
  });

  it('buildContainerPtyCommand only takes a full id', () => {
    expect(() => buildContainerPtyCommand('web')).toThrow();
    expect(() => buildContainerPtyCommand(`${APP_ID} --privileged`)).toThrow();
    expect(buildContainerPtyCommand(APP_ID).args[7]).toBe(APP_ID);
  });
});

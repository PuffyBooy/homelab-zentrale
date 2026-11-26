import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MAX_CHUNK_CHARS,
  terminalActions,
  type AgentEvent,
  type RpcEnvelope,
  type RpcResult,
  type StreamData,
  type StreamEnd,
} from '@hz/shared';
import { Dispatcher, type ActionContext } from '../src/actions/index.js';
import {
  COALESCE_MS,
  IDLE_MS,
  KILL_GRACE_MS,
  MAX_PTYS,
  MAX_SESSION_MS,
  PTY_ENV,
  PtyManager,
  buildPtyCommand,
  type PtyProcess,
  type PtySpawnRequest,
  type SessionKiller,
} from '../src/actions/pty.js';
import { createLogger } from '../src/log.js';
import { StreamManager } from '../src/streams.js';

// ---------------------------------------------------------------------------
// helpers

class FakePty implements PtyProcess {
  static nextPid = 900_000;
  readonly pid = FakePty.nextPid++;
  written: string[] = [];
  sizes: [number, number][] = [];
  paused = false;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = cb;
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(c: number, r: number): void {
    this.sizes.push([c, r]);
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  emit(d: string): void {
    this.dataCb?.(d);
  }
  exit(code: number, signal?: number): void {
    this.exitCb?.(signal === undefined ? { exitCode: code } : { exitCode: code, signal });
  }
}

type Msg = StreamData | StreamEnd;

interface Setup {
  d: Dispatcher;
  ctx: ActionContext;
  pty: PtyManager | undefined;
  streams: StreamManager;
  sent: Msg[];
  events: AgentEvent[];
  logs: string[];
  spawned: PtySpawnRequest[];
  fakes: FakePty[];
  kills: { sid: number; signal: NodeJS.Signals }[];
  buffered: { bytes: number };
  /** rpc + resultSent, like the connection does. */
  call(action: string, params: unknown, id?: string): Promise<RpcResult>;
}

let seq = 0;
const newId = () => `rpc_pty${String(++seq).padStart(8, '0')}`;

function setup(
  opts: {
    allowTerminal?: boolean;
    real?: boolean;
    killSession?: SessionKiller;
    managerFlag?: boolean;
  } = {},
): Setup {
  const allow = opts.allowTerminal ?? true;
  const sent: Msg[] = [];
  const events: AgentEvent[] = [];
  const logs: string[] = [];
  const spawned: PtySpawnRequest[] = [];
  const fakes: FakePty[] = [];
  const kills: { sid: number; signal: NodeJS.Signals }[] = [];
  const buffered = { bytes: 0 };
  const log = createLogger('debug', (l) => logs.push(l));
  const streams = new StreamManager({
    send: (m) => {
      sent.push(m);
      return true;
    },
    bufferedAmount: () => buffered.bytes,
  });
  const pty =
    allow || opts.managerFlag !== undefined
      ? new PtyManager({
          allowTerminal: opts.managerFlag ?? allow,
          hostExec: 'nsenter',
          host: { hostRoot: '/nonexistent' },
          streams,
          log,
          // Test seam: a plain /bin/sh in a pty instead of nsenter into host PID 1.
          command: async () => ({ file: '/bin/sh', args: [], shell: '/bin/sh' }),
          ...(opts.real
            ? {}
            : {
                spawner: (req: PtySpawnRequest) => {
                  spawned.push(req);
                  const f = new FakePty();
                  fakes.push(f);
                  return f;
                },
              }),
          killSession:
            opts.killSession ??
            (async (sid, signal) => {
              kills.push({ sid, signal });
            }),
        })
      : undefined;
  const ctx: ActionContext = {
    name: 'heimserver',
    allowTerminal: allow,
    homelabRoot: '/opt/homelab/',
    host: {
      hostProc: '/proc',
      hostRoot: '/nonexistent',
      docker: null,
      exec: () => Promise.reject(new Error('exec not expected')),
    },
    log,
    later: () => undefined,
    streams,
    run: () => Promise.reject(new Error('run not expected')),
    dockerSocket: '/var/run/docker.sock',
    spawn: () => {
      throw new Error('spawn not expected');
    },
    dataDir: '/nonexistent',
    ...(pty ? { pty } : {}),
  };
  const d = new Dispatcher(ctx, (e) => events.push(e));
  const call = async (action: string, params: unknown, id = newId()) => {
    const env: RpcEnvelope = { type: 'rpc', id, action, params };
    const r = await d.handle(env);
    d.resultSent(r, true);
    return r;
  };
  return { d, ctx, pty, streams, sent, events, logs, spawned, fakes, kills, buffered, call };
}

const errCode = (r: RpcResult) => (r.ok ? null : r.error.code);
const output = (s: Setup, id: string) =>
  s.sent
    .filter((m): m is StreamData => m.type === 'stream.data' && m.streamId === id)
    .map((m) => m.chunk)
    .join('');
const endOf = (s: Setup, id: string) =>
  s.sent.find((m): m is StreamEnd => m.type === 'stream.end' && m.streamId === id);

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sid = 'rpc_pty_stream01';

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('pty: disabled by default', () => {
  it.each(terminalActions)('%s is refused with terminal_disabled and audited', async (action) => {
    const s = setup({ allowTerminal: false });
    const params =
      action === 'pty.open'
        ? { cols: 80, rows: 24 }
        : action === 'pty.input'
          ? { streamId: sid, data: 'id\n' }
          : action === 'pty.resize'
            ? { streamId: sid, cols: 80, rows: 24 }
            : { streamId: sid };
    const r = await s.call(action, params);
    expect(errCode(r)).toBe('terminal_disabled');
    expect(s.events).toHaveLength(1);
    expect(s.events[0]?.event).toMatchObject({ kind: 'denied', action });
    expect(s.spawned).toHaveLength(0);
    expect(s.streams.size).toBe(0);
  });

  it('the config flag defaults to off', async () => {
    const { loadConfig } = await import('../src/config.js');
    const c = loadConfig({ HZ_CORE_URL: 'ws://127.0.0.1:8080/agent', HZ_AGENT_NAME: 'pi' });
    expect(c.allowTerminal).toBe(false);
    expect(
      loadConfig({
        HZ_CORE_URL: 'ws://127.0.0.1:8080/agent',
        HZ_AGENT_NAME: 'pi',
        HZ_AGENT_ALLOW_TERMINAL: '1',
      }).allowTerminal,
    ).toBe(true);
  });

  it('the manager refuses on its own too (second lock)', async () => {
    const s = setup({ allowTerminal: false, managerFlag: false });
    await expect(s.pty?.open('rpc_direct0001', 80, 24)).rejects.toMatchObject({
      code: 'terminal_disabled',
    });
    expect(() => s.pty?.input(sid, 'x')).toThrow(/disabled/);
    expect(s.spawned).toHaveLength(0);
  });

  it('a context without a manager does not spawn anything', async () => {
    const s = setup({ allowTerminal: true });
    delete s.ctx.pty;
    const r = await s.call('pty.open', { cols: 80, rows: 24 });
    expect(errCode(r)).toBe('failed');
  });
});

describe('pty: real shell (test seam /bin/sh)', () => {
  it('open, echo, resize, exit code', async () => {
    const s = setup({ real: true });
    const id = newId();
    const r = await s.call('pty.open', { cols: 80, rows: 24 }, id);
    expect(r).toEqual({ type: 'rpc.result', id, ok: true, data: { streamId: id } });

    expect(errCode(await s.call('pty.input', { streamId: id, data: 'echo hz-$((40+2))\n' }))).toBe(
      null,
    );
    await waitFor(() => output(s, id).includes('hz-42'));

    expect(errCode(await s.call('pty.resize', { streamId: id, cols: 120, rows: 40 }))).toBe(null);
    await s.call('pty.input', { streamId: id, data: 'stty size\n' });
    await waitFor(() => output(s, id).includes('40 120'));

    await s.call('pty.input', { streamId: id, data: 'exit 7\n' });
    await waitFor(() => endOf(s, id) !== undefined);
    expect(endOf(s, id)).toEqual({ type: 'stream.end', streamId: id, code: 7 });
    expect(s.pty?.size).toBe(0);
    // The stream ends after the result; data is utf-8 text.
    expect(s.sent.at(-1)?.type).toBe('stream.end');
  });

  it('the shell gets the fixed minimal environment, never the agent token', async () => {
    process.env.HZ_AGENT_TOKEN = 'hzat_secret_value_must_not_leak_123456';
    try {
      const s = setup({ real: true });
      const id = newId();
      await s.call('pty.open', { cols: 80, rows: 24 }, id);
      await s.call('pty.input', { streamId: id, data: 'env; echo END-OF-ENV\n' });
      await waitFor(() => output(s, id).includes('END-OF-ENV\r\n'));
      const out = output(s, id);
      expect(out).not.toContain('hzat_secret');
      expect(out).not.toContain('HZ_AGENT');
      expect(out).toContain('TERM=xterm-256color');
      expect(out).toContain('LANG=C.UTF-8');
      await s.call('pty.close', { streamId: id });
      await waitFor(() => endOf(s, id) !== undefined);
    } finally {
      delete process.env.HZ_AGENT_TOKEN;
    }
  });

  it('pty.close hangs up the shell and its background jobs', async () => {
    const s = setup({
      real: true,
      killSession: (await import('../src/actions/pty.js')).makeSessionKiller(),
    });
    const id = newId();
    await s.call('pty.open', { cols: 80, rows: 24 }, id);
    // A job in its own process group (job control) must die with the session too.
    await s.call('pty.input', { streamId: id, data: 'set -m; sleep 300 & echo BG=$!\n' });
    await waitFor(() => /BG=(\d+)/.test(output(s, id)));
    const bg = Number(/BG=(\d+)/.exec(output(s, id))?.[1]);
    expect(bg).toBeGreaterThan(1);
    expect(errCode(await s.call('pty.close', { streamId: id }))).toBe(null);
    await waitFor(() => endOf(s, id) !== undefined);
    await waitFor(() => {
      try {
        process.kill(bg, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it('a lost core connection kills the shell and its jobs', async () => {
    const s = setup({
      real: true,
      killSession: (await import('../src/actions/pty.js')).makeSessionKiller(),
    });
    const id = newId();
    await s.call('pty.open', { cols: 80, rows: 24 }, id);
    await s.call('pty.input', { streamId: id, data: 'set -m; sleep 300 & echo BG=$!\n' });
    await waitFor(() => /BG=(\d+)/.test(output(s, id)));
    const bg = Number(/BG=(\d+)/.exec(output(s, id))?.[1]);
    const sentBefore = s.sent.length;
    s.streams.cancelAll(); // what index.ts does on onDisconnect
    await waitFor(() => s.pty?.size === 0);
    await waitFor(() => {
      try {
        process.kill(bg, 0);
        return false;
      } catch {
        return true;
      }
    });
    // Nothing more goes out for a cancelled stream.
    expect(s.sent.length).toBe(sentBefore);
  });
});

describe('pty: limits and errors', () => {
  it(`allows at most ${MAX_PTYS} terminals at once`, async () => {
    const s = setup();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PTYS; i++) {
      const id = newId();
      ids.push(id);
      expect((await s.call('pty.open', { cols: 80, rows: 24 }, id)).ok).toBe(true);
    }
    expect(errCode(await s.call('pty.open', { cols: 80, rows: 24 }))).toBe('busy');
    expect(s.spawned).toHaveLength(MAX_PTYS);
    // Parallel opens cannot race past the limit either.
    s.fakes[0]?.exit(0);
    const results = await Promise.all([
      s.call('pty.open', { cols: 80, rows: 24 }),
      s.call('pty.open', { cols: 80, rows: 24 }),
    ]);
    expect(results.map(errCode).sort()).toEqual(['busy', null].sort());
    expect(s.pty?.size).toBe(MAX_PTYS);
  });

  it('rejects input above 16 KiB (protocol and manager)', async () => {
    const s = setup();
    const id = newId();
    await s.call('pty.open', { cols: 80, rows: 24 }, id);
    const big = 'a'.repeat(16 * 1024 + 1);
    expect(errCode(await s.call('pty.input', { streamId: id, data: big }))).toBe('invalid_params');
    expect(() => s.pty?.input(id, big)).toThrow(/too large/);
    expect(errCode(await s.call('pty.input', { streamId: id, data: 'a'.repeat(16 * 1024) }))).toBe(
      null,
    );
    expect(s.fakes[0]?.written).toEqual(['a'.repeat(16 * 1024)]);
  });

  it('rejects bad sizes and extra fields', async () => {
    const s = setup();
    expect(errCode(await s.call('pty.open', { cols: 5, rows: 24 }))).toBe('invalid_params');
    expect(errCode(await s.call('pty.open', { cols: 80, rows: 1000 }))).toBe('invalid_params');
    expect(errCode(await s.call('pty.open', { cols: 80, rows: 24, cmd: '/bin/sh' }))).toBe(
      'invalid_params',
    );
    expect(s.spawned).toHaveLength(0);
  });

  it.each(['pty.input', 'pty.resize', 'pty.close'] as const)(
    '%s with an unknown stream id answers not_found',
    async (action) => {
      const s = setup();
      const params =
        action === 'pty.input'
          ? { streamId: sid, data: 'x' }
          : action === 'pty.resize'
            ? { streamId: sid, cols: 80, rows: 24 }
            : { streamId: sid };
      expect(errCode(await s.call(action, params))).toBe('not_found');
    },
  );

  it('a stream id of another stream kind is not a terminal', async () => {
    const s = setup();
    s.streams.open('rpc_logs_stream1');
    expect(errCode(await s.call('pty.input', { streamId: 'rpc_logs_stream1', data: 'x' }))).toBe(
      'not_found',
    );
  });

  it('a failing spawn answers failed and leaves no stream', async () => {
    const logs: string[] = [];
    const streams = new StreamManager({ send: () => true, bufferedAmount: () => 0 });
    const pty = new PtyManager({
      allowTerminal: true,
      hostExec: 'nsenter',
      host: { hostRoot: '/nonexistent' },
      streams,
      log: createLogger('debug', (l) => logs.push(l)),
      command: async () => ({ file: '/bin/sh', args: [], shell: '/bin/sh' }),
      spawner: () => {
        throw new Error('forkpty(3) failed');
      },
    });
    await expect(pty.open('rpc_failspawn1', 80, 24)).rejects.toMatchObject({ code: 'failed' });
    expect(pty.size).toBe(0);
  });
});

describe('pty: idle and max duration (fake timers)', () => {
  it('closes after 15 min without input', async () => {
    vi.useFakeTimers();
    const s = setup();
    const id = newId();
    await s.call('pty.open', { cols: 80, rows: 24 }, id);
    const pid = s.fakes[0]?.pid ?? 0;

    vi.advanceTimersByTime(IDLE_MS - 60_000);
    await s.call('pty.input', { streamId: id, data: 'ls\n' }); // resets the idle timer
    vi.advanceTimersByTime(IDLE_MS - 60_000);
    expect(endOf(s, id)).toBeUndefined();
    expect(s.kills).toHaveLength(0);

    vi.advanceTimersByTime(60_000);
    expect(s.kills).toEqual([{ sid: pid, signal: 'SIGHUP' }]);
    // The shell ignores SIGHUP: SIGKILL after the grace period.
    vi.advanceTimersByTime(KILL_GRACE_MS);
    expect(s.kills.at(-1)).toEqual({ sid: pid, signal: 'SIGKILL' });
    expect(endOf(s, id)).toEqual({
      type: 'stream.end',
      streamId: id,
      code: 137,
      error: 'idle_timeout',
    });
    expect(s.pty?.size).toBe(0);
    expect(errCode(await s.call('pty.input', { streamId: id, data: 'x' }))).toBe('not_found');
  });

  it('closes after 60 min in total even with steady input', async () => {
    vi.useFakeTimers();
    const s = setup();
    const id = newId();
    await s.call('pty.open', { cols: 80, rows: 24 }, id);
    for (let t = 0; t < MAX_SESSION_MS - 10 * 60_000; t += 10 * 60_000) {
      vi.advanceTimersByTime(10 * 60_000);
      await s.call('pty.input', { streamId: id, data: 'date\n' });
    }
    expect(endOf(s, id)).toBeUndefined();
    vi.advanceTimersByTime(10 * 60_000);
    expect(s.kills.map((k) => k.signal)).toEqual(['SIGHUP']);
    // The shell exits on SIGHUP: its exit code ends the stream.
    s.fakes[0]?.exit(0, 1);
    expect(endOf(s, id)).toEqual({
      type: 'stream.end',
      streamId: id,
      code: 129,
      error: 'max_duration',
    });
    vi.advanceTimersByTime(KILL_GRACE_MS);
    expect(s.kills.map((k) => k.signal)).toEqual(['SIGHUP']);
  });

  it('coalesces output for ~33 ms and caps chunks at 64 KiB', async () => {
    vi.useFakeTimers();
    const s = setup();
    const id = newId();
    await s.call('pty.open', { cols: 80, rows: 24 }, id);
    const f = s.fakes[0] as FakePty;
    f.emit('a');
    f.emit('b');
    f.emit('c');
    expect(output(s, id)).toBe('');
    vi.advanceTimersByTime(COALESCE_MS);
    const data = s.sent.filter((m) => m.type === 'stream.data');
    expect(data).toHaveLength(1);
    expect(output(s, id)).toBe('abc');

    f.emit('x'.repeat(MAX_CHUNK_CHARS * 2 + 5));
    vi.advanceTimersByTime(COALESCE_MS);
    const chunks = s.sent.filter((m): m is StreamData => m.type === 'stream.data');
    expect(chunks.every((c) => c.chunk.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(output(s, id).length).toBe(3 + MAX_CHUNK_CHARS * 2 + 5);
  });

  it('pauses the pty while the socket is congested', async () => {
    vi.useFakeTimers();
    const s = setup();
    const id = newId();
    await s.call('pty.open', { cols: 80, rows: 24 }, id);
    const f = s.fakes[0] as FakePty;
    s.buffered.bytes = 64 * 1024 * 1024;
    f.emit('lots of output');
    vi.advanceTimersByTime(COALESCE_MS);
    expect(f.paused).toBe(true);
    vi.advanceTimersByTime(500);
    expect(f.paused).toBe(true);
    s.buffered.bytes = 0;
    vi.advanceTimersByTime(100);
    expect(f.paused).toBe(false);
  });

  it('stream.cancel from the core hangs up the session', async () => {
    vi.useFakeTimers();
    const s = setup();
    const id = newId();
    await s.call('pty.open', { cols: 80, rows: 24 }, id);
    s.streams.cancel(id);
    expect(s.kills.map((k) => k.signal)).toEqual(['SIGHUP']);
    vi.advanceTimersByTime(KILL_GRACE_MS);
    expect(s.kills.map((k) => k.signal)).toEqual(['SIGHUP', 'SIGKILL']);
    expect(s.pty?.size).toBe(0);
    expect(endOf(s, id)).toBeUndefined();
  });

  it('an undelivered rpc.result kills the fresh terminal', async () => {
    const s = setup();
    const id = newId();
    const r = await s.d.handle({
      type: 'rpc',
      id,
      action: 'pty.open',
      params: { cols: 80, rows: 24 },
    });
    s.d.resultSent(r, false);
    expect(s.kills.map((k) => k.signal)).toEqual(['SIGHUP']);
  });
});

describe('pty: logging', () => {
  it('logs open/close with id, duration and bytes, never input or output', async () => {
    const s = setup({ real: true });
    const id = newId();
    await s.call('pty.open', { cols: 80, rows: 24 }, id);
    await s.call('pty.input', {
      streamId: id,
      data: 'echo INPUT-MARKER-$((6*7))-OUTPUT\n',
    });
    await waitFor(() => output(s, id).includes('INPUT-MARKER-42-OUTPUT'));
    await s.call('pty.input', { streamId: id, data: 'exit\n' });
    await waitFor(() => endOf(s, id) !== undefined);

    const all = s.logs.join('\n');
    expect(all).not.toContain('MARKER');
    expect(all).not.toContain('echo');
    const opened = s.logs.map((l) => JSON.parse(l)).find((l) => l.msg === 'terminal opened');
    const closed = s.logs.map((l) => JSON.parse(l)).find((l) => l.msg === 'terminal closed');
    expect(opened).toMatchObject({ streamId: id, cols: 80, rows: 24 });
    expect(closed).toMatchObject({ streamId: id, reason: 'exit', code: 0 });
    expect(closed.bytesIn).toBeGreaterThan(30);
    expect(closed.bytesOut).toBeGreaterThan(20);
    expect(typeof closed.durationMs).toBe('number');
  });
});

describe('pty: host command', () => {
  let base: string;
  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-pty-')));
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function hostRoot(name: string, files: { bash?: boolean; sh?: boolean; home?: boolean }) {
    const root = path.join(base, name);
    await mkdir(path.join(root, 'bin'), { recursive: true });
    for (const [f, on] of [
      ['bash', files.bash],
      ['sh', files.sh],
    ] as const) {
      if (!on) continue;
      await writeFile(path.join(root, 'bin', f), '');
      await chmod(path.join(root, 'bin', f), 0o755);
    }
    if (files.home) await mkdir(path.join(root, 'root'));
    return root;
  }

  it('nsenter into host PID 1 with a login bash, fixed arguments', async () => {
    const root = await hostRoot('full', { bash: true, sh: true, home: true });
    const cmd = await buildPtyCommand('nsenter', { hostRoot: root });
    expect(cmd).toEqual({
      file: 'nsenter',
      args: [
        '--target',
        '1',
        '--mount',
        '--uts',
        '--ipc',
        '--net',
        '--pid',
        '--cgroup',
        `--wd=${root}/root`,
        '--',
        '/bin/bash',
        '-l',
      ],
      shell: '/bin/bash',
    });
    expect(cmd.args).not.toContain('-c');
  });

  it('falls back to /bin/sh and to / without /root', async () => {
    const root = await hostRoot('minimal', { sh: true });
    const cmd = await buildPtyCommand('nsenter', { hostRoot: root });
    expect(cmd.args.slice(-3)).toEqual(['--', '/bin/sh', '-l']);
    expect(cmd.args.some((a) => a.startsWith('--wd'))).toBe(false);
  });

  it('refuses without a shell or with host exec disabled', async () => {
    const root = await hostRoot('empty', {});
    await expect(buildPtyCommand('nsenter', { hostRoot: root })).rejects.toMatchObject({
      code: 'failed',
    });
    await expect(buildPtyCommand('none', { hostRoot: '/' })).rejects.toMatchObject({
      code: 'failed',
    });
  });

  it('the spawn request carries only the fixed environment', async () => {
    const s = setup();
    await s.call('pty.open', { cols: 100, rows: 30 });
    expect(s.spawned[0]).toEqual({
      file: '/bin/sh',
      args: [],
      cols: 100,
      rows: 30,
      cwd: '/',
      env: PTY_ENV,
    });
    expect(Object.keys(PTY_ENV).sort()).toEqual(
      ['COLORTERM', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'TERM', 'USER'].sort(),
    );
  });
});

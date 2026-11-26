import { access, readdir, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as NodePty from '@homebridge/node-pty-prebuilt-multiarch';
import { MAX_CHUNK_CHARS, type RpcParams } from '@hz/shared';
import { CHILD_ENV } from '../exec.js';
import { hostPath, type HostContext } from '../host.js';
import type { Logger } from '../log.js';
import type { StreamManager, StreamSink } from '../streams.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * Web console: a login shell on the HOST behind a pseudo terminal (SPEC 11).
 *
 * Gate: the dispatcher refuses every pty.* with `terminal_disabled` unless
 * HZ_AGENT_ALLOW_TERMINAL=1 (read once at start, reported as capabilities.terminal);
 * the core additionally requires a step-up session. The PtyManager checks the flag
 * again (defense in depth) and node-pty is only loaded once a terminal is opened.
 *
 * - pty.open (stream, rpc id = stream id): `nsenter --target 1 ... -- /bin/bash -l`
 *   (fallback /bin/sh -l), i.e. the host's shell in the namespaces of host PID 1, not
 *   a shell in the agent image. A fixed argument array, never a command string.
 *   Minimal environment (TERM, LANG, HOME, PATH ...); the agent token never reaches it.
 * - Output goes out as stream.data (utf-8 text), coalesced for COALESCE_MS, at most
 *   MAX_CHUNK_CHARS per chunk. While the WebSocket buffer is congested the pty is
 *   paused (the kernel then blocks the writer in the shell).
 * - stream.end {code} when the shell exits; `error` is `idle_timeout` / `max_duration`
 *   when the agent's own limits closed the session.
 * - Limits: MAX_PTYS at once, IDLE_MS without input, MAX_SESSION_MS in total.
 * - pty.close, stream.cancel and a lost core connection hang up the session: SIGHUP
 *   to every process of the pty's session, SIGKILL after KILL_GRACE_MS.
 * - Logged: open/close with stream id, reason, duration and byte counts. Never the
 *   input or the output.
 */

export const MAX_PTYS = 3;
export const IDLE_MS = 15 * 60_000;
export const MAX_SESSION_MS = 60 * 60_000;
export const COALESCE_MS = 33;
/** Max chars of one pty.input (the protocol schema enforces the same). */
export const MAX_INPUT_CHARS = 16 * 1024;
export const KILL_GRACE_MS = 2000;
/** How often a paused pty checks whether the socket drained. */
export const BACKPRESSURE_POLL_MS = 50;

/** The parts of node-pty's IPty the agent uses (injectable for tests). */
export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
}

export interface PtySpawnRequest {
  file: string;
  args: readonly string[];
  cols: number;
  rows: number;
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export type PtySpawner = (req: PtySpawnRequest) => PtyProcess;

/** Sends a signal to every process of the pty's session (injectable for tests). */
export type SessionKiller = (sessionId: number, signal: NodeJS.Signals) => Promise<void>;

/** Environment of the shell. Fixed values only, nothing from the agent's own env. */
export const PTY_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: CHILD_ENV.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'C.UTF-8',
  HOME: '/root',
  USER: 'root',
  LOGNAME: 'root',
});

export interface PtyCommand {
  file: string;
  args: string[];
  shell: string;
}

const HOST_SHELLS = ['/bin/bash', '/bin/sh'] as const;

async function exists(p: string, mode = fsConstants.F_OK): Promise<boolean> {
  try {
    await access(p, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * The fixed command line of the console. `nsenter` (container) enters the namespaces
 * of host PID 1 like every other host command (exec.ts makeHostExec); `--wd` is opened
 * by nsenter before the namespace switch, so it is given as the host path seen from
 * the agent (`<hostRoot>/root`), which after setns is the host's /root.
 */
export async function buildPtyCommand(
  mode: 'nsenter' | 'direct' | 'none',
  host: Pick<HostContext, 'hostRoot'>,
): Promise<PtyCommand> {
  if (mode === 'none') throw new ActionError('failed', 'host commands are disabled', false);
  let shell: string | undefined;
  for (const s of HOST_SHELLS) {
    if (await exists(hostPath(host, s), fsConstants.X_OK)) {
      shell = s;
      break;
    }
  }
  if (shell === undefined) throw new ActionError('failed', 'no shell on the host', false);
  if (mode === 'direct') return { file: shell, args: ['-l'], shell };
  const home = hostPath(host, '/root');
  const wd = (await exists(home)) ? [`--wd=${home}`] : [];
  return {
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
      ...wd,
      '--',
      shell,
      '-l',
    ],
    shell,
  };
}

/** node-pty, loaded lazily so the native module is only touched when a console opens. */
export const nodePtySpawner: PtySpawner = (req) => {
  const require = createRequire(import.meta.url);
  const pty = require('@homebridge/node-pty-prebuilt-multiarch') as typeof NodePty;
  // node-pty forks and execs `file` with the argument array (no shell, setsid: the
  // child leads a new session, so its pid is the session id).
  return pty.spawn(req.file, [...req.args], {
    name: req.env.TERM ?? 'xterm-256color',
    cols: req.cols,
    rows: req.rows,
    cwd: req.cwd,
    env: { ...req.env },
    encoding: 'utf8',
  });
};

/** Session ids of all processes, read from /proc/<pid>/stat. */
async function sessionMembers(procDir: string, sessionId: number): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(procDir);
  } catch {
    return [];
  }
  const out: number[] = [];
  await Promise.all(
    entries
      .filter((e) => /^\d+$/.test(e))
      .map(async (e) => {
        try {
          const stat = await readFile(path.join(procDir, e, 'stat'), 'utf8');
          // pid (comm) state ppid pgrp session ...; comm may contain spaces and ')'.
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          if (Number(fields[3]) === sessionId) out.push(Number(e));
        } catch {
          // process gone
        }
      }),
  );
  return out;
}

/**
 * Signals the pty's process group and every other process of its session (bash puts
 * each job in its own group). Processes that left the session on purpose (setsid)
 * are not touched.
 */
export function makeSessionKiller(procDir = '/proc'): SessionKiller {
  return async (sessionId, signal) => {
    if (!Number.isInteger(sessionId) || sessionId <= 1) return;
    try {
      process.kill(-sessionId, signal);
    } catch {
      // group already gone
    }
    for (const pid of await sessionMembers(procDir, sessionId)) {
      if (pid <= 1 || pid === process.pid) continue;
      try {
        process.kill(pid, signal);
      } catch {
        // gone or not ours
      }
    }
  };
}

type EndReason = 'exit' | 'closed' | 'cancelled' | 'idle_timeout' | 'max_duration';

interface Session {
  id: string;
  proc: PtyProcess;
  sink: StreamSink;
  startedAt: number;
  bytesIn: number;
  bytesOut: number;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  hardTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  paused: boolean;
  /** Set once the session is being torn down. */
  reason: EndReason | null;
  finished: boolean;
}

export interface PtyManagerOptions {
  allowTerminal: boolean;
  hostExec: 'nsenter' | 'direct' | 'none';
  host: Pick<HostContext, 'hostRoot'>;
  streams: StreamManager;
  log: Logger;
  spawner?: PtySpawner;
  killSession?: SessionKiller;
  /** Test seam: replaces buildPtyCommand. */
  command?: () => Promise<PtyCommand>;
  maxPtys?: number;
  idleMs?: number;
  maxSessionMs?: number;
  now?: () => number;
}

export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  /** Opens that passed the limit check but have not spawned yet. */
  private reserved = 0;
  private readonly spawner: PtySpawner;
  private readonly killSession: SessionKiller;
  private readonly now: () => number;

  constructor(private readonly o: PtyManagerOptions) {
    this.spawner = o.spawner ?? nodePtySpawner;
    this.killSession = o.killSession ?? makeSessionKiller();
    this.now = o.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  private gate(): void {
    // The dispatcher already refuses; this is the second lock.
    if (!this.o.allowTerminal) {
      throw new ActionError('terminal_disabled', 'terminal is disabled on this server');
    }
  }

  private get(streamId: string): Session {
    const s = this.sessions.get(streamId);
    if (!s || s.reason !== null) throw new ActionError('not_found', 'no such terminal', false);
    return s;
  }

  async open(id: string, cols: number, rows: number): Promise<{ streamId: string }> {
    this.gate();
    const max = this.o.maxPtys ?? MAX_PTYS;
    if (this.sessions.size + this.reserved >= max) {
      throw new ActionError('busy', `at most ${max} terminals at once`, false);
    }
    this.reserved += 1;
    let cmd: PtyCommand;
    let sink: StreamSink;
    try {
      cmd = await (this.o.command ?? (() => buildPtyCommand(this.o.hostExec, this.o.host)))();
      sink = this.o.streams.open(id);
    } finally {
      this.reserved -= 1;
    }
    let proc: PtyProcess;
    try {
      proc = this.spawner({ file: cmd.file, args: cmd.args, cols, rows, cwd: '/', env: PTY_ENV });
    } catch (err) {
      this.o.log.warn('terminal could not start', {
        streamId: id,
        error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
      // The dispatcher discards the sink of a failed streaming action.
      throw new ActionError('failed', 'could not start terminal', false);
    }
    const s: Session = {
      id,
      proc,
      sink,
      startedAt: this.now(),
      bytesIn: 0,
      bytesOut: 0,
      pending: '',
      flushTimer: null,
      idleTimer: null,
      hardTimer: null,
      pollTimer: null,
      killTimer: null,
      paused: false,
      reason: null,
      finished: false,
    };
    this.sessions.set(id, s);
    proc.onData((data) => this.onData(s, data));
    proc.onExit((e) => {
      const code = e.signal ? 128 + e.signal : e.exitCode;
      this.finish(s, Number.isInteger(code) ? code : 1);
    });
    // stream.cancel from the core, a lost connection, or the result not delivered.
    sink.onCancel(() => this.terminate(s, 'cancelled'));
    this.touch(s);
    s.hardTimer = setTimeout(
      () => this.terminate(s, 'max_duration'),
      this.o.maxSessionMs ?? MAX_SESSION_MS,
    );
    this.o.log.info('terminal opened', { streamId: id, shell: cmd.shell, cols, rows });
    return { streamId: id };
  }

  input(streamId: string, data: string): void {
    this.gate();
    if (data.length > MAX_INPUT_CHARS) throw new ActionError('invalid_params', 'input too large');
    const s = this.get(streamId);
    this.touch(s);
    if (data.length === 0) return;
    s.bytesIn += Buffer.byteLength(data, 'utf8');
    s.proc.write(data);
  }

  resize(streamId: string, cols: number, rows: number): void {
    this.gate();
    const s = this.get(streamId);
    this.touch(s);
    s.proc.resize(cols, rows);
  }

  close(streamId: string): void {
    this.gate();
    this.terminate(this.get(streamId), 'closed');
  }

  /** Agent shutdown: hang up every terminal. */
  closeAll(): void {
    for (const s of [...this.sessions.values()]) this.terminate(s, 'cancelled');
  }

  private touch(s: Session): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => this.terminate(s, 'idle_timeout'), this.o.idleMs ?? IDLE_MS);
  }

  private onData(s: Session, data: string): void {
    if (s.finished || data.length === 0) return;
    s.bytesOut += Buffer.byteLength(data, 'utf8');
    s.pending += data;
    if (s.pending.length >= MAX_CHUNK_CHARS) this.flush(s);
    else s.flushTimer ??= setTimeout(() => this.flush(s), COALESCE_MS);
  }

  private flush(s: Session): void {
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    if (s.pending.length === 0) return;
    const text = s.pending;
    s.pending = '';
    // The sink splits into chunks of at most MAX_CHUNK_CHARS (surrogate safe).
    s.sink.data('stdout', text);
    if (!s.paused && !s.finished && s.sink.congested()) this.pause(s);
  }

  private pause(s: Session): void {
    s.paused = true;
    s.proc.pause();
    s.pollTimer = setInterval(() => {
      if (s.finished || s.reason !== null || !s.sink.congested()) {
        if (s.pollTimer) clearInterval(s.pollTimer);
        s.pollTimer = null;
        s.paused = false;
        if (!s.finished) s.proc.resume();
      }
    }, BACKPRESSURE_POLL_MS);
  }

  /** Hangs up the session: SIGHUP now, SIGKILL after the grace period. */
  private terminate(s: Session, reason: EndReason): void {
    if (s.finished || s.reason !== null) return;
    s.reason = reason;
    this.clearTimers(s);
    this.flush(s);
    if (s.paused) s.proc.resume();
    void this.killSession(s.proc.pid, 'SIGHUP');
    s.killTimer = setTimeout(() => {
      void this.killSession(s.proc.pid, 'SIGKILL');
      this.finish(s, 137);
    }, KILL_GRACE_MS);
  }

  private clearTimers(s: Session): void {
    for (const t of [s.flushTimer, s.idleTimer, s.hardTimer]) if (t) clearTimeout(t);
    if (s.pollTimer) clearInterval(s.pollTimer);
    s.flushTimer = s.idleTimer = s.hardTimer = s.pollTimer = null;
  }

  private finish(s: Session, code: number): void {
    if (s.finished) return;
    this.clearTimers(s);
    this.flush(s);
    s.finished = true;
    if (s.killTimer) clearTimeout(s.killTimer);
    s.killTimer = null;
    const reason = s.reason ?? 'exit';
    if (reason === 'exit') {
      // The shell is gone; make sure nothing it left in its session lingers.
      void this.killSession(s.proc.pid, 'SIGHUP');
    }
    this.sessions.delete(s.id);
    const error = reason === 'idle_timeout' || reason === 'max_duration' ? reason : undefined;
    s.sink.end(code, error);
    this.o.log.info('terminal closed', {
      streamId: s.id,
      reason,
      code,
      durationMs: this.now() - s.startedAt,
      bytesIn: s.bytesIn,
      bytesOut: s.bytesOut,
    });
  }
}

function manager(ctx: ActionContext): PtyManager {
  if (!ctx.allowTerminal) {
    throw new ActionError('terminal_disabled', 'terminal is disabled on this server');
  }
  if (!ctx.pty) throw new ActionError('failed', 'terminal not available', false);
  return ctx.pty;
}

export async function ptyOpen(
  p: RpcParams<'pty.open'>,
  ctx: ActionContext,
  rpcId: string,
): Promise<{ streamId: string }> {
  return manager(ctx).open(rpcId, p.cols, p.rows);
}

export async function ptyInput(p: RpcParams<'pty.input'>, ctx: ActionContext): Promise<null> {
  manager(ctx).input(p.streamId, p.data);
  return null;
}

export async function ptyResize(p: RpcParams<'pty.resize'>, ctx: ActionContext): Promise<null> {
  manager(ctx).resize(p.streamId, p.cols, p.rows);
  return null;
}

export async function ptyClose(p: RpcParams<'pty.close'>, ctx: ActionContext): Promise<null> {
  manager(ctx).close(p.streamId);
  return null;
}

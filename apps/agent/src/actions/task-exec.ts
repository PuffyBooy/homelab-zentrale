import path from 'node:path';
import { HOMELAB_ROOT, TASK_OUTPUT_MAX_BYTES, type RpcParams, type TaskExecData } from '@hz/shared';
import {
  spawnTaskShell,
  TASK_ENV,
  TASK_NSENTER_ARGS,
  TASK_SHELL,
  type TaskChild,
} from '../exec.js';
import { hostPath, type HostContext } from '../host.js';
import type { Logger } from '../log.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * task.exec (M20): one scheduled shell command on the HOST, without a TTY.
 *
 * Gate: only with HZ_AGENT_ALLOW_TASKS=1 (read once at start, reported as
 * capabilities.tasks); otherwise `not_allowed`. The TaskManager checks the flag
 * again (defense in depth) and is only constructed with the flag.
 *
 * - The host is reached like the web console (actions/pty.ts): `nsenter --target 1
 *   --mount --uts --ipc --net --pid --cgroup --wd=<host>/opt/homelab -- /bin/sh -c
 *   <command>`. The command is exactly one argv entry after `-c`; the agent never
 *   builds or interpolates a command string itself.
 * - stdin is closed, the working directory is /opt/homelab, the environment is
 *   TASK_ENV only (PATH, HOME, LANG): the agent token and the rest of the agent's
 *   environment never reach the command.
 * - Own process group (detached). After the time limit: SIGTERM to the group, KILL_GRACE_MS
 *   later SIGKILL. When the shell exits, whatever it left in its group is killed
 *   too, so a task never outlives its run (use systemd-run for daemons).
 * - Output: stdout and stderr interleaved in arrival order, only the last
 *   TASK_OUTPUT_MAX_BYTES are kept (ring buffer), ANSI sequences and control
 *   characters are stripped, `truncated` tells whether bytes were dropped.
 * - At most one run per taskId and MAX_TASKS at once (`busy`).
 * - Logged: taskId, exit code, timeout flag, duration. Never the command or its output.
 */

export const MAX_TASKS = 4;
export const KILL_GRACE_MS = 5000;
/** How long the pipes may stay open after the shell exited. */
const PIPE_DRAIN_MS = 2000;

export { TASK_ENV, TASK_SHELL };

export interface TaskCommand {
  file: string;
  args: string[];
  /** Working directory of the spawned process (the agent's view). */
  cwd: string;
}

/**
 * The fixed command line of a task. `nsenter` opens `--wd` before the namespace
 * switch, so it gets the host path seen from the agent (`<hostRoot>/opt/homelab`),
 * which after setns is the host's /opt/homelab.
 */
export function buildTaskCommand(
  mode: 'nsenter' | 'direct' | 'none',
  host: Pick<HostContext, 'hostRoot'>,
  command: string,
  homelabRoot: string = HOMELAB_ROOT,
): TaskCommand {
  if (mode === 'none') throw new ActionError('failed', 'host commands are disabled', false);
  const root = path.resolve(homelabRoot);
  if (mode === 'direct') return { file: TASK_SHELL, args: ['-c', command], cwd: root };
  return {
    file: 'nsenter',
    args: [...TASK_NSENTER_ARGS, `--wd=${hostPath(host, root)}`, '--', TASK_SHELL, '-c', command],
    cwd: '/',
  };
}

const ANSI =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_X][^\x1b]*(?:\x1b\\)?|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_]|\x1b/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g;

/** Removes ANSI escape sequences and control characters (keeps \n and \t, \r becomes \n). */
export function cleanOutput(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(CONTROL, '');
}

/** Keeps the last `max` bytes of everything pushed. */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private kept = 0;
  total = 0;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;
    const c = chunk.length > this.max ? chunk.subarray(chunk.length - this.max) : chunk;
    this.chunks.push(c);
    this.kept += c.length;
    while (this.chunks.length > 1 && this.kept - (this.chunks[0]?.length ?? 0) >= this.max) {
      this.kept -= this.chunks.shift()?.length ?? 0;
    }
  }

  get truncated(): boolean {
    return this.total > this.max;
  }

  /** The tail as text; a UTF-8 sequence cut at the start is dropped. */
  text(): string {
    let buf = Buffer.concat(this.chunks);
    if (buf.length > this.max) buf = buf.subarray(buf.length - this.max);
    let start = 0;
    if (this.truncated) {
      while (start < buf.length && start < 3 && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
    }
    return buf.subarray(start).toString('utf8');
  }
}

/** Signals a whole process group; a gone group is fine. */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // group gone
  }
}

export interface TaskManagerOptions {
  allowTasks: boolean;
  hostExec: 'nsenter' | 'direct' | 'none';
  host: Pick<HostContext, 'hostRoot'>;
  homelabRoot: string;
  log: Logger;
  maxTasks?: number;
  /** Test seam: shorter grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  now?: () => number;
}

interface Running {
  child: TaskChild;
  timer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  timedOut: boolean;
  exited: boolean;
}

export class TaskManager {
  private readonly running = new Map<string, Running>();
  private readonly now: () => number;

  constructor(private readonly o: TaskManagerOptions) {
    this.now = o.now ?? Date.now;
  }

  get size(): number {
    return this.running.size;
  }

  /** Runs one command. Resolves with the result (also for non-zero exits and timeouts). */
  async run(taskId: string, command: string, timeoutMs: number): Promise<TaskExecData> {
    // The handler already refuses; this is the second lock.
    if (!this.o.allowTasks) {
      throw new ActionError('not_allowed', 'scheduled commands are disabled on this server');
    }
    if (this.running.has(taskId)) {
      throw new ActionError('busy', 'this task is already running', false);
    }
    const max = this.o.maxTasks ?? MAX_TASKS;
    if (this.running.size >= max) {
      throw new ActionError('busy', `at most ${max} commands at once`, false);
    }
    const cmd = buildTaskCommand(this.o.hostExec, this.o.host, command, this.o.homelabRoot);
    const started = this.now();
    const out = new TailBuffer(TASK_OUTPUT_MAX_BYTES);
    let child: TaskChild;
    try {
      child = spawnTaskShell(cmd.file, cmd.args, cmd.cwd);
    } catch {
      throw new ActionError('failed', 'could not start the command', false);
    }
    const run: Running = { child, timer: null, killTimer: null, timedOut: false, exited: false };
    const graceMs = this.o.killGraceMs ?? KILL_GRACE_MS;
    this.running.set(taskId, run);
    this.o.log.info('task started', { taskId });

    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => out.push(c));

    run.timer = setTimeout(() => {
      if (run.exited) return;
      run.timedOut = true;
      killGroup(child.pid, 'SIGTERM');
      // Always fires, also when the shell is already gone: its children get the full
      // grace period after SIGTERM, then SIGKILL.
      run.killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), graceMs);
      run.killTimer.unref();
    }, timeoutMs);

    const result = await new Promise<
      { ok: true; code: number | null } | { ok: false; reason: 'not_found' | 'spawn_failed' }
    >((resolve) => {
      let exitCode: number | null = null;
      child.on('error', (err: NodeJS.ErrnoException) => {
        resolve({ ok: false, reason: err.code === 'ENOENT' ? 'not_found' : 'spawn_failed' });
      });
      child.on('exit', (code) => {
        run.exited = true;
        exitCode = typeof code === 'number' ? code : null;
        // Nothing the command left in its group outlives the run. After a timeout the
        // pending SIGKILL (grace period) does that.
        if (!run.timedOut) killGroup(child.pid, 'SIGKILL');
        setTimeout(
          () => {
            child.stdout.destroy();
            child.stderr.destroy();
            resolve({ ok: true, code: exitCode });
          },
          PIPE_DRAIN_MS + (run.timedOut ? graceMs : 0),
        ).unref();
      });
      child.on('close', (code) => {
        if (!run.exited) exitCode = typeof code === 'number' ? code : null;
        resolve({ ok: true, code: exitCode });
      });
    });

    if (run.timer) clearTimeout(run.timer);
    this.running.delete(taskId);
    const durationMs = Math.max(0, Math.round(this.now() - started));
    if (!result.ok) {
      this.o.log.warn('task could not start', { taskId, reason: result.reason, durationMs });
      throw new ActionError('failed', 'could not start the command', false);
    }
    const exitCode = run.timedOut ? null : result.code;
    this.o.log.info('task finished', {
      taskId,
      exitCode,
      timedOut: run.timedOut,
      durationMs,
    });
    return {
      exitCode,
      timedOut: run.timedOut,
      durationMs,
      output: cleanOutput(out.text()),
      truncated: out.truncated,
    };
  }

  /** Agent shutdown: kill every running command. */
  killAll(): void {
    for (const r of this.running.values()) {
      if (r.timer) clearTimeout(r.timer);
      killGroup(r.child.pid, 'SIGKILL');
    }
  }
}

export async function taskExec(
  p: RpcParams<'task.exec'>,
  ctx: ActionContext,
): Promise<TaskExecData> {
  if (!ctx.allowTasks) {
    throw new ActionError(
      'not_allowed',
      'scheduled commands are disabled on this server (HZ_AGENT_ALLOW_TASKS)',
    );
  }
  if (!ctx.tasks) throw new ActionError('failed', 'tasks not available', false);
  return ctx.tasks.run(p.taskId, p.command, p.timeoutSec * 1000);
}

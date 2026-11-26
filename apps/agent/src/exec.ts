import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

/**
 * The only place in the agent that starts programs.
 *
 * - Always `execFile` with an argument array, never through a shell, never a
 *   command string. Arguments reach the program literally (`; rm -rf /` stays
 *   one argument).
 * - Only programs from PROGRAMS may be started.
 * - Every call has a timeout and an output limit.
 * - Children get a minimal environment, so the agent token in our own env
 *   never reaches a child process.
 */

/** Programs the agent may start (directly or on the host via nsenter). */
export const PROGRAMS = new Set([
  'nsenter',
  'apt',
  'apt-get',
  'dpkg-query',
  'journalctl',
  'fail2ban-client',
  'ss',
  'ping',
  'systemctl',
  // Docker CLI in the agent image, only for `docker compose` (actions/compose.ts).
  'docker',
  // git in the agent image, only for deploy.run (actions/deploy.ts, fixed argument builders).
  'git',
]);

export const CHILD_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  DEBIAN_FRONTEND: 'noninteractive',
});

/** The only variables a caller may add to CHILD_ENV (never the agent token). */
export const EXTRA_ENV_KEYS = [
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  // deploy.run (actions/deploy.ts): git without prompts, system/global config or upward
  // repository discovery, ssh with the deploy key; DEPLOY_SHA/HOME for deploy.sh.
  'GIT_TERMINAL_PROMPT',
  'GIT_ASKPASS',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_CEILING_DIRECTORIES',
  'HOME',
  'DEPLOY_SHA',
] as const;
export type ExtraEnv = Partial<Record<(typeof EXTRA_ENV_KEYS)[number], string>>;

export interface RunOptions {
  /** Default 30 s. */
  timeoutMs?: number;
  /** Default 16 MiB per stream. */
  maxBuffer?: number;
  /** Additional environment, restricted to EXTRA_ENV_KEYS. */
  env?: ExtraEnv;
}

function childEnv(extra: ExtraEnv | undefined): Record<string, string> {
  const env: Record<string, string> = { ...CHILD_ENV };
  if (!extra) return env;
  for (const [k, v] of Object.entries(extra)) {
    if (!(EXTRA_ENV_KEYS as readonly string[]).includes(k)) {
      throw new ExecPolicyError(`env not allowed: ${k.slice(0, 40)}`);
    }
    if (typeof v !== 'string' || v.includes('\0')) throw new ExecPolicyError('invalid env value');
    env[k] = v;
  }
  return env;
}

export interface RunResult {
  /** Exit code, null if killed by a signal or not started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not run to completion. */
  error?: 'not_found' | 'timeout' | 'output_too_large' | 'spawn_failed';
}

export class ExecPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecPolicyError';
  }
}

/**
 * deploy.run's script method: `/bin/sh <dir>/deploy.sh`. The shell is NOT in PROGRAMS
 * (runFile('sh', ...) stays refused); the streaming spawner only allows it with exactly
 * one argument, an absolute normalized path whose file name is deploy.sh (never `-c`).
 * actions/deploy.ts checks before that the file is a regular file inside the project dir.
 */
export const SCRIPT_SHELL = '/bin/sh';
export const DEPLOY_SCRIPT_NAME = 'deploy.sh';

export function isDeployScriptCall(file: string, args: readonly string[]): boolean {
  if (file !== SCRIPT_SHELL || args.length !== 1) return false;
  const script = args[0];
  return (
    typeof script === 'string' &&
    !script.includes('\0') &&
    path.isAbsolute(script) &&
    path.normalize(script) === script &&
    path.basename(script) === DEPLOY_SCRIPT_NAME
  );
}

function checkArgs(
  file: string,
  args: readonly string[],
  programs: ReadonlySet<string> = PROGRAMS,
): void {
  if (!programs.has(file)) throw new ExecPolicyError(`program not allowed: ${file.slice(0, 40)}`);
  for (const a of args) {
    if (typeof a !== 'string') throw new ExecPolicyError('arguments must be strings');
    if (a.includes('\0')) throw new ExecPolicyError('NUL in argument');
  }
}

/** Runs `file` with `args`. Never throws for exit codes; throws ExecPolicyError for disallowed calls. */
export function runFile(
  file: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return runChecked(PROGRAMS, file, args, opts);
}

/**
 * A runner with its own program allowlist. Only tests use this (e.g. with
 * `printf` to prove that arguments stay literal); production code always goes
 * through runFile and PROGRAMS.
 */
export function makeRunner(programs: ReadonlySet<string>) {
  const frozen = new Set(programs);
  return (file: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> =>
    runChecked(frozen, file, args, opts);
}

function runChecked(
  programs: ReadonlySet<string>,
  file: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<RunResult> {
  checkArgs(file, args, programs);
  const env = childEnv(opts.env);
  const timeout = opts.timeoutMs ?? 30_000;
  const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
  return new Promise((resolve) => {
    // The single execFile wrapper: allowlisted program, argument array, no shell.
    // nosemgrep
    execFile(
      file,
      [...args],
      {
        shell: false,
        timeout,
        maxBuffer,
        killSignal: 'SIGKILL',
        windowsHide: true,
        env,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const e = err as NodeJS.ErrnoException & {
          code?: string | number;
          killed?: boolean;
          signal?: string | null;
        };
        const out = { stdout: stdout ?? '', stderr: stderr ?? '' };
        if (e.code === 'ENOENT') resolve({ code: null, ...out, error: 'not_found' });
        else if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
          resolve({ code: null, ...out, error: 'output_too_large' });
        else if (e.killed && e.signal === 'SIGKILL')
          resolve({ code: null, ...out, error: 'timeout' });
        else if (typeof e.code === 'number') resolve({ code: e.code, ...out });
        else resolve({ code: null, ...out, error: 'spawn_failed' });
      },
    );
  });
}

export type HostExecMode = 'nsenter' | 'direct' | 'none';

/**
 * Runs a program on the host.
 * - `nsenter`: agent in a container with `pid: host`. Enters the namespaces of
 *   host PID 1 and runs the host's own binary (apt, journalctl, systemctl ...).
 * - `direct`: agent runs directly on the host (development).
 * - `none`: host commands are disabled; returns not_found.
 */
export function makeHostExec(mode: HostExecMode) {
  return function hostExec(
    file: string,
    args: readonly string[],
    opts: RunOptions = {},
  ): Promise<RunResult> {
    if (file === 'nsenter') throw new ExecPolicyError('nested nsenter');
    checkArgs(file, args);
    if (mode === 'none')
      return Promise.resolve({ code: null, stdout: '', stderr: '', error: 'not_found' });
    if (mode === 'direct') return runFile(file, args, opts);
    return runFile(
      'nsenter',
      [
        '--target',
        '1',
        '--mount',
        '--uts',
        '--ipc',
        '--net',
        '--pid',
        '--cgroup',
        '--',
        file,
        ...args,
      ],
      opts,
    );
  };
}
export type HostExec = ReturnType<typeof makeHostExec>;

/** nsenter reports a missing host binary with exit code 127 (util-linux EX_EXEC_ENOENT). */
export function isMissingProgram(r: RunResult): boolean {
  return r.error === 'not_found' || r.code === 127;
}

// ---------------------------------------------------------------------------
// Streaming variant (deploy.run): output arrives in pieces while the program runs.

export interface SpawnOptions {
  /** Default 30 s. The child is killed with SIGKILL afterwards. */
  timeoutMs?: number;
  /** Max bytes of stdout + stderr together (default 64 MiB); the child is killed above. */
  maxOutputBytes?: number;
  /** Additional environment, restricted to EXTRA_ENV_KEYS. */
  env?: ExtraEnv;
  /** Working directory (absolute). */
  cwd?: string;
}

export interface SpawnCallbacks {
  onStdout(chunk: Buffer): void;
  onStderr(chunk: Buffer): void;
}

export interface SpawnResult {
  code: number | null;
  error?: 'not_found' | 'timeout' | 'output_too_large' | 'spawn_failed' | 'killed';
}

export interface SpawnHandle {
  readonly done: Promise<SpawnResult>;
  /** Kills the child (SIGKILL). The result then has error 'killed'. */
  kill(): void;
  /** Backpressure: stop / continue reading the child's output. */
  pause(): void;
  resume(): void;
}

export type Spawner = (
  file: string,
  args: readonly string[],
  cb: SpawnCallbacks,
  opts?: SpawnOptions,
) => SpawnHandle;

/** How long the pipes may stay open after the child exited. */
const PIPE_DRAIN_MS = 2000;

function spawnChecked(
  programs: ReadonlySet<string>,
  file: string,
  args: readonly string[],
  cb: SpawnCallbacks,
  opts: SpawnOptions,
): SpawnHandle {
  // The deploy script is the only call outside the program allowlist (fixed shape).
  if (!isDeployScriptCall(file, args)) checkArgs(file, args, programs);
  if (opts.cwd !== undefined && (!path.isAbsolute(opts.cwd) || opts.cwd.includes('\0'))) {
    throw new ExecPolicyError('cwd must be absolute');
  }
  const env = childEnv(opts.env);
  const timeout = opts.timeoutMs ?? 30_000;
  const maxOutput = opts.maxOutputBytes ?? 64 * 1024 * 1024;
  // The streaming wrapper: allowlisted program, argument array, no shell.
  // nosemgrep
  const child = spawn(file, [...args], {
    shell: false,
    cwd: opts.cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so a timeout or cancel also kills grandchildren
    // (deploy.sh -> sleep/compose, git -> ssh/git-remote-https).
    detached: true,
  });
  let reason: SpawnResult['error'];
  let total = 0;
  const kill = (why: NonNullable<SpawnResult['error']>) => {
    reason ??= why;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  // A grandchild that survives may keep stdout/stderr open; 'close' would then never
  // come and the dir lock would stay. After the child exited, give the pipes a short
  // moment to drain, then close them.
  child.on('exit', () => {
    setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, PIPE_DRAIN_MS).unref();
  });
  const timer = setTimeout(() => kill('timeout'), timeout);
  const count = (chunk: Buffer) => {
    total += chunk.length;
    if (total > maxOutput) kill('output_too_large');
  };
  child.stdout.on('data', (chunk: Buffer) => {
    count(chunk);
    if (reason === undefined) cb.onStdout(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    count(chunk);
    if (reason === undefined) cb.onStderr(chunk);
  });
  const done = new Promise<SpawnResult>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, error: err.code === 'ENOENT' ? 'not_found' : 'spawn_failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (reason !== undefined) resolve({ code: null, error: reason });
      else if (typeof code === 'number') resolve({ code });
      else resolve({ code: null, error: 'killed' });
    });
  });
  return {
    done,
    kill: () => kill('killed'),
    pause: () => {
      child.stdout.pause();
      child.stderr.pause();
    },
    resume: () => {
      child.stdout.resume();
      child.stderr.resume();
    },
  };
}

/** Starts an allowlisted program (or the deploy script, see isDeployScriptCall) and streams its output. */
export const spawnFile: Spawner = (file, args, cb, opts = {}) =>
  spawnChecked(PROGRAMS, file, args, cb, opts);

/** Test-only streaming runner with its own program allowlist (like makeRunner). */
export function makeSpawner(programs: ReadonlySet<string>): Spawner {
  const frozen = new Set(programs);
  return (file, args, cb, opts = {}) => spawnChecked(frozen, file, args, cb, opts);
}

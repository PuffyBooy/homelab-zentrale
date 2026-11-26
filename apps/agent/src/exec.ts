import { execFile } from 'node:child_process';

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
  // Only used by tests to prove that arguments stay literal.
  'printf',
]);

export const CHILD_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  DEBIAN_FRONTEND: 'noninteractive',
});

export interface RunOptions {
  /** Default 30 s. */
  timeoutMs?: number;
  /** Default 16 MiB per stream. */
  maxBuffer?: number;
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

function checkArgs(file: string, args: readonly string[]): void {
  if (!PROGRAMS.has(file)) throw new ExecPolicyError(`program not allowed: ${file.slice(0, 40)}`);
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
  checkArgs(file, args);
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
        env: { ...CHILD_ENV },
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

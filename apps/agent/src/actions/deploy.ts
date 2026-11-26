import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoUrlSchema, shaSchema, type RpcParams } from '@hz/shared';
import {
  DEPLOY_SCRIPT_NAME,
  SCRIPT_SHELL,
  type ExtraEnv,
  type SpawnHandle,
  type SpawnOptions,
} from '../exec.js';
import { resolveHomelabPath } from '../paths.js';
import type { StreamSink } from '../streams.js';
import { composeArgs, composeEnv, COMPOSE_TIMEOUTS, composeTarget, tail } from './compose.js';
import { existingKeyPath, SAFE_PATH } from './deploy-key.js';
import { acquireDirLock } from './dir-lock.js';
import { LineBuffer, LogChunker, type LogChannel } from './logs.js';
import { assertProjectNotProtected, type ProtectDocker } from './protected.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * deploy.run as a stream (rpc id = stream id).
 *
 * Before the rpc.result (refusals come back as rpc errors, nothing runs):
 *   - dir was resolved by the dispatcher (realpath below /opt/homelab/, no `.git` segment);
 *     it is created if missing (checked again before and after mkdir),
 *   - repoUrl and sha are validated by the schema and again here,
 *   - git@github.com URLs need keyName, the key must exist in the agent's data dir,
 *   - a project with the agent or core container is refused,
 *   - the per-dir lock (shared with compose.*) is taken; it is held until the stream ends,
 *   - existing repo: `.git` must be a real directory and `origin` must equal repoUrl;
 *     no repo yet: the dir must be empty (only `.env*` files are allowed).
 *
 * Then, streamed with a `$ …` progress line per command:
 *   [git init --quiet; git remote add origin <repoUrl>]   (new repo only)
 *   git fetch --prune origin
 *   git -c advice.detachedHead=false checkout --force --detach <sha> --
 *   compose: docker compose … up -d --build --remove-orphans   (same target as compose.up)
 *   script:  /bin/sh <dir>/deploy.sh   (cwd = dir, env PATH/HOME/DEPLOY_SHA/DOCKER_HOST, 20 min)
 * and stream.end with 0 or the failing exit code.
 *
 * `init` + `remote add` instead of `git clone`: works in an existing directory that
 * already holds a `.env`. There is deliberately no `git clean`: untracked runtime data
 * (.env, volumes, uploads) in the project directory must survive a deploy. Tracked files
 * are reset to <sha> by `checkout --force`.
 *
 * git runs hardened: no system/global config, no hooks, no fsmonitor, no credential
 * helper, no prompts, only https and ssh transports, no upward repository discovery.
 * A token is never used: public repos over https, private repos over ssh with a deploy
 * key and GitHub's bundled host keys (StrictHostKeyChecking=yes).
 */

export const KNOWN_HOSTS_FILE = fileURLToPath(
  new URL('../../assets/github_known_hosts', import.meta.url),
);

export const GIT_TIMEOUTS = { local: 60_000, fetch: 10 * 60_000, checkout: 5 * 60_000 } as const;
export const SCRIPT_TIMEOUT_MS = 20 * 60_000;
/** Same limit as compose up --build in COMPOSE_TIMEOUTS.deploy. */
export const COMPOSE_DEPLOY_TIMEOUT_MS = COMPOSE_TIMEOUTS.deploy;

export type GitProtocol = 'https' | 'ssh' | 'file';

/** `-c` options in front of every git command (git reads them with the highest priority). */
export function gitSafetyArgs(protocols: readonly GitProtocol[]): string[] {
  return [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'credential.helper=',
    '-c',
    'submodule.recurse=false',
    '-c',
    'protocol.allow=never',
    ...protocols.flatMap((p) => ['-c', `protocol.${p}.allow=always`]),
  ];
}

/** git -C <dir> <safety> <sub...>. dir is absolute (cannot be read as an option). */
export function gitArgs(
  dir: string,
  protocols: readonly GitProtocol[],
  sub: readonly string[],
): string[] {
  if (!path.isAbsolute(dir)) throw new ActionError('bad_path', 'dir must be absolute');
  return ['-C', dir, ...gitSafetyArgs(protocols), ...sub];
}

/** Subcommands. Values from the request only appear after fixed options or after `--`. */
export const GIT = {
  init: () => ['init', '--quiet'],
  remoteAdd: (url: string) => ['remote', 'add', 'origin', '--', url],
  getUrl: () => ['remote', 'get-url', 'origin'],
  fetch: () => ['fetch', '--prune', '--no-recurse-submodules', 'origin'],
  checkout: (sha: string) => {
    if (!shaSchema.safeParse(sha).success) throw new ActionError('invalid_params', 'invalid sha');
    return ['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', sha, '--'];
  },
} as const;

/** GIT_SSH_COMMAND for a deploy key. git runs it through a shell, so every path must be SAFE_PATH. */
export function sshCommand(keyFile: string, knownHosts = KNOWN_HOSTS_FILE): string {
  if (!SAFE_PATH.test(keyFile) || !SAFE_PATH.test(knownHosts)) {
    throw new ActionError('failed', 'unsupported key path');
  }
  return [
    'ssh',
    '-F',
    '/dev/null',
    '-i',
    keyFile,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'IdentityAgent=none',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
  ].join(' ');
}

export function gitEnv(dir: string, keyFile?: string, knownHosts?: string): ExtraEnv {
  const env: ExtraEnv = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CEILING_DIRECTORIES: path.dirname(dir),
    HOME: '/tmp',
  };
  if (keyFile) env.GIT_SSH_COMMAND = sshCommand(keyFile, knownHosts);
  return env;
}

/** Extra checks on top of the schema: no dot segments in owner/repo. */
export function checkRepoUrl(url: string): void {
  if (!repoUrlSchema.safeParse(url).success)
    throw new ActionError('invalid_params', 'invalid repoUrl');
  const rest = url.startsWith('git@')
    ? url.slice('git@github.com:'.length)
    : url.slice('https://github.com/'.length);
  const segs = rest.split('/');
  if (
    segs.length !== 2 ||
    segs.some((s) => s === '.' || s === '..' || s.startsWith('-') || s === '.git')
  ) {
    throw new ActionError('invalid_params', 'invalid repoUrl');
  }
}

/** Display form of a command for the progress line (no env, no -C/-c noise). */
function display(file: string, args: readonly string[]): string {
  return `$ ${[file === SCRIPT_SHELL ? 'sh' : file, ...args].join(' ')}`;
}

/** Short name of a step for error messages: `git fetch`, `docker compose`, `deploy.sh`. */
function stepName(file: string, shown: readonly string[]): string {
  if (file === SCRIPT_SHELL) return DEPLOY_SCRIPT_NAME;
  const words = shown.filter((a, i) => !a.startsWith('-') && shown[i - 1] !== '-c');
  return `${file} ${words[0] ?? ''}`.trim();
}

/** Lines -> chunks -> sink, like container.logs. */
class OutputPipe {
  private readonly chunker: LogChunker;
  private readonly lines: Record<LogChannel, LineBuffer>;

  constructor(private readonly sink: StreamSink) {
    this.chunker = new LogChunker((ch, chunk) => sink.data(ch, chunk));
    this.lines = {
      stdout: new LineBuffer((l) => this.chunker.add('stdout', l)),
      stderr: new LineBuffer((l) => this.chunker.add('stderr', l)),
    };
  }

  push(ch: LogChannel, b: Buffer): void {
    this.lines[ch].push(b);
  }

  flush(): void {
    this.lines.stdout.flush();
    this.lines.stderr.flush();
    this.chunker.flush();
  }

  progress(text: string): void {
    this.flush();
    this.sink.data('progress', `${text}\n`);
  }

  dispose(): void {
    this.chunker.dispose();
  }
}

class StepFailed extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

class Cancelled extends Error {}

export interface DeployJob {
  dir: string;
  repoUrl: string;
  sha: string;
  method: 'compose' | 'script';
  /** Whether `git init` + `remote add` is needed. */
  init: boolean;
  /** Absolute path of the deploy key (ssh), if any. */
  keyFile?: string;
  /** Transports git may use. Production: https + ssh. Tests: file. */
  protocols: readonly GitProtocol[];
  knownHosts?: string;
}

/** Runs the git, compose or script steps into the sink and ends it. Never throws. */
export async function runDeploy(
  job: DeployJob,
  ctx: ActionContext,
  sink: StreamSink,
): Promise<void> {
  const out = new OutputPipe(sink);
  let current: SpawnHandle | null = null;
  let cancelled = false;
  sink.onCancel(() => {
    cancelled = true;
    current?.kill();
    out.dispose();
  });

  let poll: NodeJS.Timeout | null = null;
  const step = async (
    file: string,
    args: readonly string[],
    shown: readonly string[],
    opts: SpawnOptions,
  ) => {
    if (cancelled) throw new Cancelled();
    out.progress(display(file, shown));
    const handle = ctx.spawn(
      file,
      args,
      {
        onStdout: (b) => {
          out.push('stdout', b);
          backpressure();
        },
        onStderr: (b) => {
          out.push('stderr', b);
          backpressure();
        },
      },
      opts,
    );
    current = handle;
    const backpressure = () => {
      if (poll || !sink.congested()) return;
      handle.pause();
      poll = setInterval(() => {
        if (cancelled || !sink.congested()) {
          if (poll) clearInterval(poll);
          poll = null;
          handle.resume();
        }
      }, 200);
    };
    const r = await handle.done;
    current = null;
    if (poll) clearInterval(poll);
    poll = null;
    if (cancelled) throw new Cancelled();
    out.flush();
    const name = stepName(file, shown);
    if (r.error === 'not_found') throw new StepFailed(127, `${file} not available`);
    if (r.error === 'timeout') throw new StepFailed(124, `${name} timed out`);
    if (r.error) throw new StepFailed(1, `${name} failed (${r.error})`);
    if (r.code !== 0) throw new StepFailed(r.code ?? 1, `${name} failed (exit ${r.code ?? '?'})`);
  };

  const env = gitEnv(job.dir, job.keyFile, job.knownHosts);
  const git = (sub: readonly string[], timeoutMs: number) =>
    step('git', gitArgs(job.dir, job.protocols, sub), sub, { env, timeoutMs });

  try {
    if (job.init) {
      await git(GIT.init(), GIT_TIMEOUTS.local);
      await git(GIT.remoteAdd(job.repoUrl), GIT_TIMEOUTS.local);
    }
    await git(GIT.fetch(), GIT_TIMEOUTS.fetch);
    await git(GIT.checkout(job.sha), GIT_TIMEOUTS.checkout);

    if (job.method === 'compose') {
      const docker = ctx.host.docker as unknown as ProtectDocker | null;
      const target = await composeTarget(job.dir, ctx.homelabRoot, docker);
      if (docker) await assertProjectNotProtected(docker, job.dir);
      const args = composeArgs('deploy', job.dir, target.files, target.project);
      await step('docker', args, args, {
        env: composeEnv(ctx.dockerSocket),
        timeoutMs: COMPOSE_DEPLOY_TIMEOUT_MS,
      });
    } else {
      const script = await findDeployScript(job.dir, ctx.homelabRoot);
      await step(SCRIPT_SHELL, [script], [DEPLOY_SCRIPT_NAME], {
        cwd: job.dir,
        timeoutMs: SCRIPT_TIMEOUT_MS,
        env: { HOME: '/tmp', DEPLOY_SHA: job.sha, ...composeEnv(ctx.dockerSocket) },
      });
    }
    out.progress(`deployed ${job.sha.slice(0, 7)}`);
    sink.end(0);
  } catch (err) {
    if (err instanceof Cancelled || cancelled) return;
    const code = err instanceof StepFailed ? err.code : 1;
    const message =
      err instanceof StepFailed || err instanceof ActionError ? err.message : 'deploy failed';
    if (!(err instanceof StepFailed || err instanceof ActionError)) {
      ctx.log.error('deploy failed', { error: err });
    }
    out.progress(`error: ${message}`);
    sink.end(code === 0 ? 1 : code, message);
  } finally {
    if (poll) clearInterval(poll);
    out.dispose();
  }
}

/** <dir>/deploy.sh: a regular file (no symlink) directly in the project dir. Returns its path. */
export async function findDeployScript(dir: string, root: string): Promise<string> {
  const candidate = path.join(dir, DEPLOY_SCRIPT_NAME);
  const st = await lstat(candidate).catch(() => null);
  if (!st) throw new ActionError('not_found', 'deploy.sh not found in the repository');
  if (!st.isFile()) throw new ActionError('bad_path', 'deploy.sh is not a regular file');
  const check = await resolveHomelabPath(candidate, root);
  if (!check.ok) throw new ActionError('bad_path', `deploy.sh: ${check.reason}`);
  if (check.path !== candidate || path.dirname(check.path) !== dir) {
    throw new ActionError('bad_path', 'deploy.sh must be inside the project directory');
  }
  return check.path;
}

const ALLOWED_IN_NEW_DIR = /^\.env(\..+)?$/;

/**
 * Creates `dir` if needed and tells whether a repository must be initialised.
 * `dir` is the dispatcher's resolved path; it is checked again before and after mkdir.
 */
export async function prepareDir(dir: string, root: string): Promise<{ init: boolean }> {
  if (dir.split('/').some((seg) => seg.toLowerCase() === '.git')) {
    throw new ActionError('bad_path', 'dir is inside a .git directory');
  }
  const before = await resolveHomelabPath(dir, root);
  if (!before.ok || before.path !== dir) {
    throw new ActionError('bad_path', before.ok ? 'dir is not canonical' : before.reason);
  }
  try {
    await mkdir(dir, { recursive: true, mode: 0o750 });
  } catch {
    throw new ActionError('failed', 'creating the directory failed');
  }
  const after = await resolveHomelabPath(dir, root);
  if (!after.ok || after.path !== dir) throw new ActionError('bad_path', 'dir changed meanwhile');
  const st = await lstat(dir);
  if (!st.isDirectory()) throw new ActionError('bad_path', 'dir is not a directory');

  const gitDir = await lstat(path.join(dir, '.git')).catch(() => null);
  if (gitDir) {
    // A `.git` file (gitdir: …) or symlink would point git somewhere else.
    if (!gitDir.isDirectory()) throw new ActionError('bad_path', '.git is not a directory');
    return { init: false };
  }
  const entries = await readdir(dir);
  if (entries.some((e) => !ALLOWED_IN_NEW_DIR.test(e))) {
    throw new ActionError('not_allowed', 'dir is not empty and not a git repository');
  }
  return { init: true };
}

/** Checks that `origin` of the existing repository is exactly repoUrl. */
export async function checkOrigin(
  dir: string,
  repoUrl: string,
  ctx: Pick<ActionContext, 'run'>,
  protocols: readonly GitProtocol[] = ['https', 'ssh'],
): Promise<void> {
  const r = await ctx.run('git', gitArgs(dir, protocols, GIT.getUrl()), {
    env: gitEnv(dir),
    timeoutMs: GIT_TIMEOUTS.local,
  });
  if (r.error === 'not_found') throw new ActionError('failed', 'git not available');
  if (r.code !== 0) {
    throw new ActionError(
      'failed',
      `reading origin failed${r.stderr ? `: ${tail(r.stderr, 200)}` : ''}`,
    );
  }
  if (r.stdout.trim() !== repoUrl) {
    throw new ActionError(
      'not_allowed',
      'origin of the existing repository does not match repoUrl',
    );
  }
}

export async function deployRun(
  params: RpcParams<'deploy.run'>,
  ctx: ActionContext,
  rpcId: string,
): Promise<{ streamId: string }> {
  checkRepoUrl(params.repoUrl);
  if (!shaSchema.safeParse(params.sha).success)
    throw new ActionError('invalid_params', 'invalid sha');
  const ssh = params.repoUrl.startsWith('git@');
  if (ssh && !params.keyName) {
    throw new ActionError('invalid_params', 'git@github.com URLs need keyName');
  }
  if (!ssh && params.keyName) {
    throw new ActionError('invalid_params', 'keyName needs a git@github.com URL');
  }
  const keyFile = params.keyName ? await existingKeyPath(ctx.dataDir, params.keyName) : undefined;

  const docker = ctx.host.docker as unknown as ProtectDocker | null;
  if (docker) await assertProjectNotProtected(docker, params.dir);

  const release = acquireDirLock(params.dir);
  let started = false;
  try {
    const { init } = await prepareDir(params.dir, ctx.homelabRoot);
    if (!init) await checkOrigin(params.dir, params.repoUrl, ctx);
    const sink = ctx.streams.open(rpcId);
    const job: DeployJob = {
      dir: params.dir,
      repoUrl: params.repoUrl,
      sha: params.sha,
      method: params.method,
      init,
      protocols: ['https', 'ssh'],
      ...(keyFile ? { keyFile } : {}),
    };
    started = true;
    void runDeploy(job, ctx, sink).finally(release);
    return { streamId: rpcId };
  } finally {
    if (!started) release();
  }
}

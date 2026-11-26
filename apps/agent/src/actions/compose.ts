import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { assertProjectNotProtected, type ProtectDocker } from './protected.js';
import path from 'node:path';
import { fileNameSchema, type RpcParams } from '@hz/shared';
import type { RunResult } from '../exec.js';
import { resolveHomelabPath } from '../paths.js';
import { withDirLock } from './dir-lock.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * compose.pull / compose.up / compose.down / compose.write.
 *
 * `dir` was already checked by the dispatcher (realpath below /opt/homelab/).
 * The compose file inside is checked again (it may be a symlink), and docker is
 * started through the exec wrapper with a fixed argument list:
 *
 *   DOCKER_HOST=unix://<socket> docker compose --ansi never --project-directory <dir> [-p <project>] -f <file>... <sub ...>
 *
 * Project name and files come from the labels of existing containers (so `-p` and
 * extra `-f` files used at creation are kept), else the default file and its override.
 *
 * The agent mounts /opt/homelab at the same path as on the host, so relative bind
 * mounts in the compose file point to the same place for the Docker daemon.
 */

export const COMPOSE_FILE_NAMES = [
  'compose.yml',
  'compose.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
] as const;

/** `deploy` is `up` with `--build`, only used by deploy.run. */
export type ComposeOp = 'pull' | 'up' | 'down' | 'deploy';

const SUBCOMMANDS: Record<ComposeOp, readonly string[]> = {
  pull: ['pull', '--quiet'],
  up: ['up', '-d', '--remove-orphans'],
  down: ['down', '--remove-orphans'],
  deploy: ['up', '-d', '--build', '--remove-orphans'],
};

export const COMPOSE_TIMEOUTS: Record<ComposeOp, number> = {
  pull: 15 * 60_000,
  up: 10 * 60_000,
  down: 5 * 60_000,
  deploy: 20 * 60_000,
};

/** The fixed argument list for one compose operation. */
export function composeArgs(
  op: ComposeOp,
  dir: string,
  files: string | readonly string[],
  project?: string,
): string[] {
  const list = typeof files === 'string' ? [files] : files;
  return [
    'compose',
    '--ansi',
    'never',
    '--project-directory',
    dir,
    ...(project ? ['-p', project] : []),
    ...list.flatMap((f) => ['-f', f]),
    ...SUBCOMMANDS[op],
  ];
}

const OVERRIDE_NAMES: Record<string, string> = {
  'compose.yml': 'compose.override.yml',
  'compose.yaml': 'compose.override.yaml',
  'docker-compose.yml': 'docker-compose.override.yml',
  'docker-compose.yaml': 'docker-compose.override.yaml',
};
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const LABEL_DIR = 'com.docker.compose.project.working_dir';
const LABEL_PROJECT = 'com.docker.compose.project';
const LABEL_FILES = 'com.docker.compose.project.config_files';

/** Checks one compose file path: below the root, a regular file. Returns the real path. */
async function checkComposeFile(file: string, root: string): Promise<string> {
  const check = await resolveHomelabPath(file, root);
  if (!check.ok) throw new ActionError('bad_path', `${path.basename(file)}: ${check.reason}`);
  const real = await lstat(check.path).catch(() => null);
  if (!real?.isFile()) {
    throw new ActionError('bad_path', `${path.basename(file)} is not a regular file`);
  }
  return check.path;
}

export interface ComposeTarget {
  files: string[];
  project?: string;
}

interface ListDocker {
  listContainers(opts: { all: boolean; filters: string }): Promise<unknown[]>;
}

/**
 * The compose files and project name to use for `dir`. If containers of the project
 * exist, their labels win (project name from `-p`, every `-f` file incl. overrides);
 * otherwise the default file plus its override file. Every file is checked again.
 */
export async function composeTarget(
  dir: string,
  root: string,
  docker: ListDocker | null,
): Promise<ComposeTarget> {
  const main = await findComposeFile(dir, root);
  if (docker) {
    const list = (await docker
      .listContainers({ all: true, filters: JSON.stringify({ label: [`${LABEL_DIR}=${dir}`] }) })
      .catch(() => [])) as { Labels?: Record<string, string> | null }[];
    const labels = list.find((c) => c.Labels?.[LABEL_PROJECT])?.Labels;
    const project = labels?.[LABEL_PROJECT];
    if (labels && project && PROJECT_NAME.test(project)) {
      const raw = (labels[LABEL_FILES] ?? '').split(',').filter((f) => f.length > 0);
      if (raw.length > 8) throw new ActionError('bad_path', 'too many compose files');
      const files =
        raw.length > 0 ? await Promise.all(raw.map((f) => checkComposeFile(f, root))) : [main];
      return { files, project };
    }
  }
  const files = [main];
  const override = OVERRIDE_NAMES[path.basename(main)];
  if (override) {
    const candidate = path.join(dir, override);
    if (await lstat(candidate).catch(() => null))
      files.push(await checkComposeFile(candidate, root));
  }
  return { files };
}

/**
 * Finds the compose file in `dir` (already resolved). Each candidate is resolved
 * with realpath again and must be a regular file below the homelab root.
 */
export async function findComposeFile(dir: string, root: string): Promise<string> {
  let st;
  try {
    st = await lstat(dir);
  } catch {
    throw new ActionError('not_found', 'project directory not found');
  }
  if (!st.isDirectory()) throw new ActionError('bad_path', 'dir is not a directory');
  for (const name of COMPOSE_FILE_NAMES) {
    const candidate = path.join(dir, name);
    try {
      await lstat(candidate);
    } catch {
      continue;
    }
    const check = await resolveHomelabPath(candidate, root);
    if (!check.ok) throw new ActionError('bad_path', `${name}: ${check.reason}`);
    const real = await lstat(check.path).catch(() => null);
    if (!real?.isFile()) throw new ActionError('bad_path', `${name} is not a regular file`);
    return check.path;
  }
  throw new ActionError('not_found', 'no compose.yml in the directory');
}

/** Environment for the docker CLI (the image root is read-only, so its config lives in /tmp). */
export function composeEnv(dockerSocket: string): { DOCKER_HOST: string; DOCKER_CONFIG: string } {
  return { DOCKER_HOST: `unix://${dockerSocket}`, DOCKER_CONFIG: '/tmp/.docker' };
}

/** Last lines of the output, for the result and error messages. */
export function tail(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(t.length - max);
}

async function composeOp(
  op: Exclude<ComposeOp, 'deploy'>,
  params: RpcParams<'compose.up'>,
  ctx: ActionContext,
): Promise<{ output: string }> {
  return withDirLock(params.dir, async () => {
    const docker = ctx.host.docker as unknown as (ProtectDocker & ListDocker) | null;
    const target = await composeTarget(params.dir, ctx.homelabRoot, docker);
    if (docker) await assertProjectNotProtected(docker, params.dir);
    const args = composeArgs(op, params.dir, target.files, target.project);
    const r: RunResult = await ctx.run('docker', args, {
      timeoutMs: COMPOSE_TIMEOUTS[op],
      env: composeEnv(ctx.dockerSocket),
    });
    if (r.error === 'not_found') throw new ActionError('failed', 'docker cli not available');
    if (r.error === 'timeout') throw new ActionError('timeout', `compose ${op} timed out`);
    const output = tail(`${r.stdout}\n${r.stderr}`, 4000);
    if (r.code !== 0) {
      const last = tail(r.stderr || r.stdout, 300);
      throw new ActionError('failed', `compose ${op} failed${last ? `: ${last}` : ''}`);
    }
    return { output };
  });
}

export const composePull = (p: RpcParams<'compose.pull'>, ctx: ActionContext) =>
  composeOp('pull', p, ctx);
export const composeUp = (p: RpcParams<'compose.up'>, ctx: ActionContext) =>
  composeOp('up', p, ctx);
export const composeDown = (p: RpcParams<'compose.down'>, ctx: ActionContext) =>
  composeOp('down', p, ctx);

/** Writes one file atomically: exclusive temp file (never follows a symlink), fsync, rename. */
export async function writeFileAtomic(dir: string, name: string, text: string): Promise<void> {
  const target = path.join(dir, name);
  const existing = await lstat(target).catch(() => null);
  if (existing?.isDirectory()) throw new ActionError('bad_path', `${name} is a directory`);
  const tmp = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  // 'wx' = O_CREAT | O_EXCL: fails if anything (also a symlink) exists at tmp.
  const fh = await open(tmp, 'wx', 0o640);
  try {
    try {
      await fh.writeFile(text, 'utf8');
      await fh.chmod(0o640);
      await fh.sync();
    } finally {
      await fh.close();
    }
    // rename replaces a symlink at `target` itself, it never writes through it.
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function composeWrite(
  params: RpcParams<'compose.write'>,
  ctx: ActionContext,
): Promise<{ dir: string; files: string[] }> {
  const names = Object.keys(params.files);
  for (const name of names) {
    if (!fileNameSchema.safeParse(name).success) {
      throw new ActionError('invalid_params', 'invalid file name');
    }
  }
  return withDirLock(params.dir, async () => {
    // The dispatcher passes the resolved path; check again before creating anything.
    const before = await resolveHomelabPath(params.dir, ctx.homelabRoot);
    if (!before.ok || before.path !== params.dir) {
      throw new ActionError('bad_path', before.ok ? 'dir is not canonical' : before.reason);
    }
    try {
      await mkdir(params.dir, { recursive: true, mode: 0o750 });
    } catch {
      throw new ActionError('failed', 'creating the directory failed');
    }
    // Check again after mkdir: nothing may have been swapped in meanwhile.
    const check = await resolveHomelabPath(params.dir, ctx.homelabRoot);
    if (!check.ok || check.path !== params.dir) {
      throw new ActionError('bad_path', 'dir changed while writing');
    }
    const st = await lstat(params.dir);
    if (!st.isDirectory()) throw new ActionError('bad_path', 'dir is not a directory');
    for (const name of names) {
      try {
        await writeFileAtomic(params.dir, name, params.files[name] ?? '');
      } catch (err) {
        if (err instanceof ActionError) throw err;
        throw new ActionError('failed', `writing ${name} failed`);
      }
    }
    return { dir: params.dir, files: names };
  });
}

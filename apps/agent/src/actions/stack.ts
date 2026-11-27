import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { stackOpDataSchema, type RpcParams, type StackOp, type StackOpData } from '@hz/shared';
import { isMissingProgram, type RunResult } from '../exec.js';
import { hostPath } from '../host.js';
import { resolveHomelabPath } from '../paths.js';
import { assertNoPlantedSymlinks, isStackFolder } from './compose-guard.js';
import {
  composeArgs,
  composeEnv,
  composeTarget,
  COMPOSE_TIMEOUTS,
  type ComposeOp,
} from './compose.js';
import { withDirLock } from './dir-lock.js';
import {
  COMPOSE_FILES_LABEL,
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKDIR_LABEL,
  containerName,
  dockerOf,
  isProtectedListed,
  statusOf,
  type ListedContainer,
} from './docker-common.js';
import { assertProjectNotProtected, type ProtectDocker } from './protected.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * stack.op: one operation on a compose project the Zentrale may not have created.
 *
 * The core sends only the project name. The agent lists the project's containers
 * (label com.docker.compose.project=<project>); none -> not_found, any protected
 * container -> not_allowed.
 *
 * - start/stop/restart ('api'): Docker API per container (stop/restart t=30, 304 =
 *   already in that state).
 * - pull/up/down: working dir and config files come from the labels of the
 *   containers themselves; all containers must agree (else failed).
 *   - working dir below the homelab root ('inside'): the agent's own compose
 *     (compose.ts: same guards, file checks and dir lock as compose.*).
 *   - elsewhere ('host'): the host's docker compose through the host exec (nsenter)
 *     with a fixed argument list. Dir and files are validated (absolute, normalized,
 *     not '/', not below /proc /sys /dev /run, no control characters), every file
 *     must be a regular file on the host.
 * - down never removes volumes (no --volumes).
 */

interface StackDocker extends ProtectDocker {
  getContainer(id: string): {
    inspect(): Promise<unknown>;
    start(): Promise<unknown>;
    stop(opts: { t: number }): Promise<unknown>;
    restart(opts: { t: number }): Promise<unknown>;
  };
}

const MAX_FILES = 8;
const FORBIDDEN_ROOTS = ['/proc', '/sys', '/dev', '/run'] as const;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Checks a host path from a compose label. Returns a reason or null when fine. */
export function hostPathProblem(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return 'invalid path';
  if (CONTROL.test(p)) return 'control character in path';
  if (p.startsWith('-')) return 'path must not start with -';
  if (!p.startsWith('/')) return 'path must be absolute';
  if (p === '/') return 'path must not be /';
  if (p.endsWith('/') || p.includes('//')) return 'path is not normalized';
  if (p.split('/').some((seg) => seg === '.' || seg === '..')) return 'path is not normalized';
  if (path.posix.normalize(p) !== p) return 'path is not normalized';
  for (const root of FORBIDDEN_ROOTS) {
    if (p === root || p.startsWith(`${root}/`)) return `path below ${root} is not allowed`;
  }
  return null;
}

async function listProject(docker: StackDocker, project: string): Promise<ListedContainer[]> {
  try {
    const list = (await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${COMPOSE_PROJECT_LABEL}=${project}`] }),
    })) as ListedContainer[];
    // Docker filters already; check again so a fake or odd daemon cannot widen the set.
    return list.filter(
      (c) => typeof c?.Id === 'string' && c.Labels?.[COMPOSE_PROJECT_LABEL] === project,
    );
  } catch {
    throw new ActionError('failed', 'listing containers failed', false);
  }
}

/** working_dir and config_files that every container of the project carries. */
export function projectLocation(containers: ListedContainer[]): { dir: string; files: string[] } {
  const dirs = new Set(containers.map((c) => c.Labels?.[COMPOSE_WORKDIR_LABEL] ?? ''));
  const files = new Set(containers.map((c) => c.Labels?.[COMPOSE_FILES_LABEL] ?? ''));
  if (dirs.size !== 1 || files.size !== 1) {
    throw new ActionError(
      'failed',
      'the containers of the project disagree on their compose files',
      false,
    );
  }
  const dir = [...dirs][0] ?? '';
  const list = ([...files][0] ?? '').split(',').filter((f) => f.length > 0);
  if (dir === '' || list.length === 0) {
    throw new ActionError('failed', 'the project has no compose working dir or files', false);
  }
  if (list.length > MAX_FILES) throw new ActionError('failed', 'too many compose files', false);
  return { dir, files: list };
}

function isBelow(p: string, root: string): boolean {
  const r = path.resolve(root);
  const n = path.resolve(p);
  return n === r || n.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/** Below the homelab root as written or as its real path (/opt/homelab may be a symlink). */
async function isInside(dir: string, root: string): Promise<boolean> {
  if (isBelow(dir, root)) return true;
  const real = await realpath(root).catch(() => null);
  return real !== null && isBelow(dir, real);
}

async function apiOp(
  op: 'start' | 'stop' | 'restart',
  docker: StackDocker,
  containers: ListedContainer[],
  ctx: ActionContext,
): Promise<StackOpData> {
  const sorted = [...containers].sort((a, b) => containerName(a).localeCompare(containerName(b)));
  let touched = 0;
  for (const c of sorted) {
    const handle = docker.getContainer(c.Id);
    try {
      if (op === 'start') await handle.start();
      else if (op === 'stop') await handle.stop({ t: 30 });
      else await handle.restart({ t: 30 });
      touched += 1;
    } catch (err) {
      const status = statusOf(err);
      if (status === 304) {
        touched += 1;
        continue;
      }
      if (status === 404) continue; // gone meanwhile
      ctx.log.warn('stack op failed', { op, container: containerName(c) });
      throw new ActionError('failed', `stack ${op} failed at ${containerName(c)}`, false);
    }
  }
  return { containers: touched, via: 'api' };
}

function checkRun(r: RunResult, op: ComposeOp): void {
  if (r.error === 'timeout') throw new ActionError('timeout', `compose ${op} timed out`, false);
  if (r.code !== 0) throw new ActionError('failed', `compose ${op} failed`, false);
}

async function insideOp(
  op: 'pull' | 'up' | 'down',
  project: string,
  dir: string,
  count: number,
  docker: StackDocker,
  ctx: ActionContext,
): Promise<StackOpData> {
  if (dir.split('/').some((seg) => seg.toLowerCase() === '.git')) {
    throw new ActionError('bad_path', 'working dir inside a .git directory');
  }
  const check = await resolveHomelabPath(dir, ctx.homelabRoot);
  if (!check.ok) throw new ActionError('bad_path', `working dir: ${check.reason}`);
  // The labels must name the real directory: composeTarget finds the project by it.
  if (check.path !== dir) throw new ActionError('bad_path', 'working dir is not canonical');
  return withDirLock(check.path, async () => {
    await assertProjectNotProtected(docker, check.path);
    const target = await composeTarget(check.path, ctx.homelabRoot, docker);
    if (target.project !== project) {
      throw new ActionError('failed', 'the working dir belongs to another compose project', false);
    }
    if (op === 'up' && (await isStackFolder(check.path, ctx.homelabRoot))) {
      await assertNoPlantedSymlinks(check.path, target.files);
    }
    const r = await ctx.run('docker', composeArgs(op, check.path, target.files, project), {
      timeoutMs: COMPOSE_TIMEOUTS[op],
      env: composeEnv(ctx.dockerSocket),
    });
    if (r.error === 'not_found') throw new ActionError('failed', 'docker cli not available', false);
    checkRun(r, op);
    return { containers: count, via: 'inside' };
  });
}

const NOT_A_COMMAND = /is not a docker command|unknown command|unknown shorthand flag/i;

async function hostOp(
  op: 'pull' | 'up' | 'down',
  project: string,
  dir: string,
  files: string[],
  count: number,
  ctx: ActionContext,
): Promise<StackOpData> {
  if (ctx.hostExec === 'none') throw new ActionError('failed', 'host commands are disabled', false);
  for (const p of [dir, ...files]) {
    const problem = hostPathProblem(p);
    if (problem) throw new ActionError('bad_path', `compose label: ${problem}`);
  }
  const dirSt = await lstat(hostPath(ctx.host, dir)).catch(() => null);
  if (!dirSt?.isDirectory())
    throw new ActionError('not_found', 'project directory not found on the host', false);
  for (const f of files) {
    const st = await lstat(hostPath(ctx.host, f)).catch(() => null);
    if (!st?.isFile()) {
      throw new ActionError(
        'bad_path',
        `${path.basename(f).slice(0, 80)} is not a regular file on the host`,
      );
    }
  }
  return withDirLock(`host:${dir}`, async () => {
    const r = await ctx.host.exec('docker', composeArgs(op, dir, files, project), {
      timeoutMs: COMPOSE_TIMEOUTS[op],
    });
    if (isMissingProgram(r) || (r.code !== 0 && NOT_A_COMMAND.test(r.stderr))) {
      throw new ActionError('failed', 'docker compose not available on the host', false);
    }
    checkRun(r, op);
    return { containers: count, via: 'host' };
  });
}

export async function stackOp(
  params: RpcParams<'stack.op'>,
  ctx: ActionContext,
): Promise<StackOpData> {
  const docker = dockerOf<StackDocker>(ctx);
  const op: StackOp = params.op;
  const containers = await listProject(docker, params.project);
  if (containers.length === 0)
    throw new ActionError('not_found', 'compose project not found', false);
  if (containers.some(isProtectedListed)) {
    throw new ActionError(
      'not_allowed',
      'the project contains the agent or the core and is never touched',
    );
  }
  let result: StackOpData;
  if (op === 'start' || op === 'stop' || op === 'restart') {
    result = await withDirLock(`stack:${params.project}`, () => apiOp(op, docker, containers, ctx));
  } else {
    const { dir, files } = projectLocation(containers);
    const inside = await isInside(dir, ctx.homelabRoot);
    result = await withDirLock(`stack:${params.project}`, () =>
      inside
        ? insideOp(op, params.project, dir, containers.length, docker, ctx)
        : hostOp(op, params.project, dir, files, containers.length, ctx),
    );
  }
  ctx.log.info('stack op', { project: params.project, op, via: result.via });
  return stackOpDataSchema.parse(result);
}

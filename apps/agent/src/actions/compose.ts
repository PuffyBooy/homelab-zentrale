import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileNameSchema, type RpcParams } from '@hz/shared';
import type { RunResult } from '../exec.js';
import { resolveHomelabPath } from '../paths.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * compose.pull / compose.up / compose.down / compose.write.
 *
 * `dir` was already checked by the dispatcher (realpath below /opt/homelab/).
 * The compose file inside is checked again (it may be a symlink), and docker is
 * started through the exec wrapper with a fixed argument list:
 *
 *   DOCKER_HOST=unix://<socket> docker compose --ansi never --project-directory <dir> -f <file> <sub ...>
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

export type ComposeOp = 'pull' | 'up' | 'down';

const SUBCOMMANDS: Record<ComposeOp, readonly string[]> = {
  pull: ['pull', '--quiet'],
  up: ['up', '-d', '--remove-orphans'],
  down: ['down', '--remove-orphans'],
};

const TIMEOUTS: Record<ComposeOp, number> = {
  pull: 15 * 60_000,
  up: 10 * 60_000,
  down: 5 * 60_000,
};

/** The fixed argument list for one compose operation. */
export function composeArgs(op: ComposeOp, dir: string, file: string): string[] {
  return ['compose', '--ansi', 'never', '--project-directory', dir, '-f', file, ...SUBCOMMANDS[op]];
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

/** Last lines of the output, for the result and error messages. */
export function tail(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(t.length - max);
}

const locks = new Set<string>();

async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  if (locks.has(dir))
    throw new ActionError('busy', 'another compose action runs in this directory');
  locks.add(dir);
  try {
    return await fn();
  } finally {
    locks.delete(dir);
  }
}

async function composeOp(
  op: ComposeOp,
  params: RpcParams<'compose.up'>,
  ctx: ActionContext,
): Promise<{ output: string }> {
  return withDirLock(params.dir, async () => {
    const file = await findComposeFile(params.dir, ctx.homelabRoot);
    const r: RunResult = await ctx.run('docker', composeArgs(op, params.dir, file), {
      timeoutMs: TIMEOUTS[op],
      env: { DOCKER_HOST: `unix://${ctx.dockerSocket}`, DOCKER_CONFIG: '/tmp/.docker' },
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

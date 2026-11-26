import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from './game-common.js';
import { isProtectedContainer } from './protected.js';
import { ActionError } from './types.js';

/**
 * Guards for compose.* actions (M21 review):
 *
 * 1. Project name collisions. Compose derives the project name (COMPOSE_PROJECT_NAME in
 *    .env > top-level `name:` > folder name) and `up --remove-orphans` / `down` act on
 *    every container with that project label, wherever it was started. A new stack
 *    whose derived name equals an existing project (e.g. folder `homelab-agent`, or
 *    apps/jellyfin next to an old /opt/homelab/jellyfin) would remove or adopt foreign
 *    containers. So: if no container of this working_dir exists yet, the derived name
 *    must not be used by any container -> not_allowed. A project with an hz.role
 *    container is always refused. Existing projects keep their name from the labels.
 *
 * 2. Planted symlinks. A container can create a symlink below its bind-mounted
 *    ./data (e.g. ./data/x -> /etc/homelab-agent/agent.env); Docker (bind sources) and
 *    the compose CLI (env_file, configs/secrets `file:`) follow it on the next `up`.
 *    Before compose.up in an app or game folder every relative path in the compose
 *    files is walked component by component with lstat: no symlink, never outside the
 *    folder -> otherwise bad_path. Symlinks INSIDE a mounted folder are harmless (they
 *    resolve inside the container) and are not looked at.
 */

export const LABEL_DIR = 'com.docker.compose.project.working_dir';
export const LABEL_PROJECT = 'com.docker.compose.project';
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MAX_FILE_BYTES = 256 * 1024;

interface ListDocker {
  listContainers(opts: { all: boolean; filters: string }): Promise<unknown[]>;
}
interface Listed {
  Id?: string;
  Labels?: Record<string, string> | null;
}

async function readSmall(file: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    if (st.size > MAX_FILE_BYTES) throw new ActionError('bad_path', 'compose file too large');
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

/** Same normalization as compose for names derived from the folder. */
export function normalizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^-_a-z0-9]/g, '')
    .replace(/^[-_]+/, '');
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0])) return t.slice(1, -1);
  return t;
}

/**
 * The project name compose would use for `dir` (without -p): COMPOSE_PROJECT_NAME from
 * dir/.env, else the top-level `name:` of the main compose file, else the folder name.
 * A name built from variables or an invalid name -> bad_path (the agent must know it).
 */
export async function derivedProjectName(dir: string, mainFile: string): Promise<string> {
  const envText = await readSmall(path.join(dir, '.env'));
  const fromEnv = envText === null ? undefined : parseEnv(envText).get('COMPOSE_PROJECT_NAME');
  let name: string | undefined = fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined;
  if (name === undefined) {
    const text = (await readSmall(mainFile)) ?? '';
    const m = /^name:[ \t]*([^#\r\n]*)/m.exec(text);
    const v = m ? unquote(m[1] ?? '') : '';
    if (v !== '') name = v;
  }
  if (name !== undefined) {
    if (name.includes('$')) {
      throw new ActionError('bad_path', 'compose project name from variables is not supported');
    }
    if (!PROJECT_NAME.test(name)) throw new ActionError('bad_path', 'invalid compose project name');
    return name;
  }
  const derived = normalizeProjectName(path.basename(dir));
  if (!PROJECT_NAME.test(derived)) {
    throw new ActionError('bad_path', 'folder name gives no valid compose project name');
  }
  return derived;
}

async function list(docker: ListDocker, label: string): Promise<Listed[]> {
  try {
    return (await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [label] }),
    })) as Listed[];
  } catch {
    throw new ActionError('failed', 'docker not reachable');
  }
}

/** Containers started from `dir` (working_dir label). */
export function containersOfDir(docker: ListDocker, dir: string): Promise<Listed[]> {
  return list(docker, `${LABEL_DIR}=${dir}`);
}

/**
 * Refuses a project that contains an hz.role container and, with `isNew` (no container
 * of this working_dir yet), a project name that any container already carries.
 */
export async function assertProjectNameFree(
  docker: ListDocker,
  project: string,
  dir: string,
  isNew: boolean,
): Promise<void> {
  const members = await list(docker, `${LABEL_PROJECT}=${project}`);
  if (members.some((c) => isProtectedContainer({ id: c.Id ?? '', labels: c.Labels }))) {
    throw new ActionError(
      'not_allowed',
      `compose project "${project}" contains the agent or the core and is never touched`,
    );
  }
  if (isNew && members.some((c) => c.Labels?.[LABEL_DIR] !== dir)) {
    throw new ActionError(
      'not_allowed',
      `compose project name "${project}" is already used by another stack; rename the folder`,
    );
  }
}

/** Relative paths ("./x", "../x") in a compose file, comments removed. */
export function relativePaths(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '');
    for (const m of line.matchAll(
      /(?:^|[\s'"=:,[{-])(\.\.?\/[^\s'":,\]}]*|\.\.?)(?=$|[\s'":,\]}])/g,
    )) {
      out.add(m[1] as string);
    }
  }
  return [...out];
}

/** Is `dir` exactly <root>/apps/<name> or <root>/games/<name> (real paths)? */
export async function isStackFolder(dir: string, homelabRoot: string): Promise<boolean> {
  let root: string;
  try {
    root = await realpath(homelabRoot);
  } catch {
    return false;
  }
  const parent = path.dirname(dir);
  return parent === path.join(root, 'apps') || parent === path.join(root, 'games');
}

/**
 * Every relative path in the compose files must stay inside `dir` and no existing
 * component from `dir` down to it may be a symlink.
 */
export async function assertNoPlantedSymlinks(
  dir: string,
  composeFiles: readonly string[],
): Promise<void> {
  for (const file of composeFiles) {
    const text = await readSmall(file);
    if (text === null) continue;
    for (const rel of relativePaths(text)) {
      const abs = path.resolve(dir, rel);
      if (abs !== dir && !abs.startsWith(`${dir}/`)) {
        throw new ActionError('bad_path', `path ${rel.slice(0, 80)} leaves the stack folder`);
      }
      const parts = path
        .relative(dir, abs)
        .split('/')
        .filter((p) => p !== '');
      let cur = dir;
      for (const part of parts) {
        cur = path.join(cur, part);
        let st;
        try {
          st = await lstat(cur);
        } catch {
          break; // missing: Docker creates a plain directory
        }
        if (st.isSymbolicLink()) {
          throw new ActionError(
            'bad_path',
            `${path.relative(dir, cur).slice(0, 80)} is a symlink (bind and file sources must be real)`,
          );
        }
        if (!st.isDirectory()) break;
      }
    }
  }
}

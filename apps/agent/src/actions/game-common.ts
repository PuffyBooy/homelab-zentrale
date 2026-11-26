import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { resolveHomelabPath } from '../paths.js';
import { ActionError } from './types.js';

/**
 * Shared checks of the game.* actions.
 *
 * A game folder is exactly /opt/homelab/games/<name>/ (one level, after realpath).
 * Its `.env` (written by compose.write with mode 0600) holds RCON_PASSWORD and
 * PORT_RCON; the agent reads them itself, they never travel over the wire and
 * never appear in a result, a stream or a log line.
 */

/** Same rule as gameNameSchema in packages/shared (without trimming). */
export const GAME_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/;
export const ENV_FILE = '.env';
export const MAX_ENV_BYTES = 64 * 1024;
/** Max chars of RCON output in a result (rconDataSchema). */
export const MAX_RCON_OUTPUT = 64 * 1024;

export interface GameDir {
  /** Real path of the game folder. */
  dir: string;
  name: string;
  /** Real path of the homelab root (no trailing slash). */
  root: string;
}

/**
 * Checks that `gameDir` is a real directory /opt/homelab/games/<name> (exactly one
 * level below games/, after resolving symlinks; games/ itself must not be a symlink
 * out of place). Returns the real path and the name.
 */
export async function resolveGameDir(gameDir: string, homelabRoot: string): Promise<GameDir> {
  const check = await resolveHomelabPath(gameDir, homelabRoot);
  if (!check.ok) throw new ActionError('bad_path', `gameDir: ${check.reason}`);
  let root: string;
  try {
    root = await realpath(homelabRoot);
  } catch {
    throw new ActionError('bad_path', 'homelab root missing');
  }
  const gamesRoot = path.join(root, 'games');
  if (path.dirname(check.path) !== gamesRoot) {
    throw new ActionError('bad_path', 'gameDir must be /opt/homelab/games/<name>');
  }
  const name = path.basename(check.path);
  if (!GAME_NAME.test(name)) throw new ActionError('bad_path', 'invalid game name');
  const st = await lstat(check.path).catch(() => null);
  if (!st) throw new ActionError('not_found', 'game folder not found', false);
  if (!st.isDirectory()) throw new ActionError('bad_path', 'gameDir is not a directory');
  return { dir: check.path, name, root };
}

/**
 * Parses KEY=VALUE lines without any shell semantics: no expansion, no command
 * substitution, no escapes. Blank lines and `#` comments are skipped. A value wrapped
 * in matching single or double quotes loses the quotes. Invalid lines are ignored.
 */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]{0,127})=(.*)$/.exec(trimmed);
    if (!m) continue;
    let value = (m[2] ?? '').trimEnd();
    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === "'") && value.endsWith(q)) value = value.slice(1, -1);
    }
    out.set(m[1] as string, value);
  }
  return out;
}

/**
 * Reads <dir>/.env: never through a symlink (O_NOFOLLOW), only a regular file, at
 * most 64 KB. Returns null if there is no .env.
 */
export async function readGameEnv(dir: string): Promise<Map<string, string> | null> {
  const file = path.join(dir, ENV_FILE);
  let fh;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new ActionError('bad_path', '.env must not be a symlink');
    }
    throw new ActionError('failed', 'reading .env failed', false);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ActionError('bad_path', '.env is not a regular file');
    if (st.size > MAX_ENV_BYTES) throw new ActionError('failed', '.env is too large', false);
    const buf = Buffer.alloc(MAX_ENV_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_ENV_BYTES) throw new ActionError('failed', '.env is too large', false);
    return parseEnv(buf.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await fh.close();
  }
}

export interface RconConfig {
  port: number;
  password: string;
}

/** RCON port and password from the parsed .env, or null if RCON is not configured. */
export function rconFromEnv(env: Map<string, string> | null): RconConfig | null {
  if (!env) return null;
  const password = env.get('RCON_PASSWORD') ?? '';
  const portText = env.get('PORT_RCON') ?? '';
  if (!/^\d{1,5}$/.test(portText) || password.length === 0) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  return { port, password };
}

/** Minecraft § color/format codes, ANSI escapes and control chars (except \n and \t). */
export function stripColors(text: string): string {
  return (
    text
      .replace(/§[0-9A-Za-z]?/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
}

/** Replaces every occurrence of the secret (if any) in `text`. */
export function maskSecret(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

/** RCON output for a result: no colors, no secret, at most MAX_RCON_OUTPUT chars. */
export function cleanOutput(text: string, secret?: string): string {
  const cleaned = maskSecret(stripColors(text), secret);
  return cleaned.length > MAX_RCON_OUTPUT ? cleaned.slice(0, MAX_RCON_OUTPUT) : cleaned;
}

/** A display name: no colors or control chars, at most 40 chars (gameStatusDataSchema). */
export function cleanName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = stripColors(name)
    .replace(/[\n\t]/g, ' ')
    .trim();
  return n.length === 0 ? null : n.slice(0, 40);
}

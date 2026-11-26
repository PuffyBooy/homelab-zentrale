import net from 'node:net';
import { GameDig, type QueryOptions } from 'gamedig';
import { status as javaStatus, statusBedrock } from 'minecraft-server-util';
import type { GameStatusData, RpcParams } from '@hz/shared';
import {
  cleanName,
  cleanOutput,
  readGameEnv,
  resolveGameDir,
  rconFromEnv,
  stripColors,
  type RconConfig,
} from './game-common.js';
import { rconRun } from './rcon.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * game.status and game.rcon.
 *
 * Queries only go to 127.0.0.1 (the agent runs with network_mode: host, game ports
 * are published on the host). RCON port and password come from the game folder's
 * .env; the password is registered with the logger (masked everywhere) and masked
 * in every output. Query failures are not errors: the game is reported offline.
 */

export const QUERY_HOST = '127.0.0.1';
export const RCON_TIMEOUT_MS = 10_000;
const MAX_NAMES = 200;

/**
 * GameDig types the agent queries. Anything else is refused (gamedig knows hundreds
 * of protocols; we only need the ones of our templates). `password`: the query needs
 * the admin password (Palworld REST API, user `admin`), taken from RCON_PASSWORD.
 */
export const GAMEDIG_TYPES: ReadonlyMap<string, { password: boolean }> = new Map([
  ['valheim', { password: false }],
  ['counterstrike2', { password: false }],
  ['palworld', { password: true }],
]);

/** Parses Paper's `tps` answer ("TPS from last 1m, 5m, 15m: *20.0, 19.9, 19.8"): the 1m value. */
export function parseTps(output: string): number | null {
  const text = stripColors(output);
  const after = text.includes(':') ? text.slice(text.indexOf(':') + 1) : text;
  const m = /(\d+(?:[.,]\d+)?)/.exec(after);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(100, Math.round(n * 100) / 100);
}

function names(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const p of list) {
    if (out.length >= MAX_NAMES) break;
    const n = cleanName(typeof p === 'string' ? p : (p as { name?: unknown } | null)?.name);
    if (n) out.push(n);
  }
  return out;
}

const int = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
const version = (v: unknown): string | null => {
  const s = typeof v === 'string' ? stripColors(v).trim() : '';
  return s.length > 0 ? s.slice(0, 80) : null;
};

const OFFLINE: GameStatusData = { online: false, players: null, version: null, tps: null };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | null = null;
  const deadline = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error('timeout')), ms);
  });
  p.catch(() => undefined);
  return Promise.race([p, deadline]).finally(() => {
    if (t) clearTimeout(t);
  });
}

/** `none`: the game has no query protocol; a TCP connect tells whether the port is open. */
function tcpProbe(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: QUERY_HOST, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

type Query = Omit<GameStatusData, 'tps'>;

async function query(params: RpcParams<'game.status'>, rcon: RconConfig | null): Promise<Query> {
  const timeout = params.timeoutMs;
  switch (params.method) {
    case 'minecraft': {
      const r = await javaStatus(QUERY_HOST, params.port, { timeout, enableSRV: false });
      return {
        online: true,
        players: {
          online: int(r.players.online),
          max: int(r.players.max),
          names: names(r.players.sample ?? []),
        },
        version: version(r.version.name),
      };
    }
    case 'minecraft-bedrock': {
      const r = await statusBedrock(QUERY_HOST, params.port, { timeout, enableSRV: false });
      return {
        online: true,
        players: { online: int(r.players.online), max: int(r.players.max), names: [] },
        version: version(r.version.name),
      };
    }
    case 'gamedig': {
      const type = params.gamedigType as string;
      const spec = GAMEDIG_TYPES.get(type);
      const opts: QueryOptions = {
        type,
        host: QUERY_HOST,
        port: params.port,
        maxRetries: 1,
        socketTimeout: Math.min(timeout, 2000),
        attemptTimeout: timeout,
        portCache: false,
        requestRules: false,
      };
      if (spec?.password) {
        if (!rcon) return OFFLINE;
        opts.username = 'admin';
        opts.password = rcon.password;
      }
      const r = await GameDig.query(opts);
      return {
        online: true,
        players: {
          online: int(r.numplayers ?? r.players.length),
          max: int(r.maxplayers),
          names: names(r.players),
        },
        version: version(r.version),
      };
    }
    case 'none':
      return { online: await tcpProbe(params.port, timeout), players: null, version: null };
  }
}

/** Throws invalid_params unless the gamedig type is on the allowlist (and only used with gamedig). */
export function checkGamedigType(params: RpcParams<'game.status'>): void {
  if (params.method === 'gamedig') {
    if (!params.gamedigType || !GAMEDIG_TYPES.has(params.gamedigType)) {
      throw new ActionError('invalid_params', 'gamedigType not allowed');
    }
  } else if (params.gamedigType !== undefined) {
    throw new ActionError('invalid_params', 'gamedigType only with method gamedig');
  }
}

async function rconConfig(dir: string, ctx: ActionContext): Promise<RconConfig | null> {
  const rc = rconFromEnv(await readGameEnv(dir));
  if (rc) ctx.log.addSecret(rc.password);
  return rc;
}

export async function gameStatus(
  params: RpcParams<'game.status'>,
  ctx: ActionContext,
): Promise<GameStatusData> {
  checkGamedigType(params);
  const game = await resolveGameDir(params.gameDir, ctx.homelabRoot);
  const needsRcon =
    params.tpsCommand !== undefined ||
    (params.method === 'gamedig' && GAMEDIG_TYPES.get(params.gamedigType ?? '')?.password);
  const rcon = needsRcon ? await rconConfig(game.dir, ctx) : null;

  let result: Query;
  try {
    result = await withTimeout(query(params, rcon), params.timeoutMs + 500);
  } catch {
    return OFFLINE;
  }
  let tps: number | null = null;
  if (result.online && params.tpsCommand && rcon) {
    try {
      const [out] = await rconRun(
        { port: rcon.port, password: rcon.password, timeoutMs: params.timeoutMs },
        [params.tpsCommand],
      );
      tps = parseTps(out ?? '');
    } catch {
      tps = null;
    }
  }
  return { ...result, tps };
}

export async function gameRcon(
  params: RpcParams<'game.rcon'>,
  ctx: ActionContext,
): Promise<{ output: string }> {
  if (params.command.length === 0 || /[\r\n\0]/.test(params.command)) {
    throw new ActionError('invalid_params', 'single line only');
  }
  const game = await resolveGameDir(params.gameDir, ctx.homelabRoot);
  const rcon = await rconConfig(game.dir, ctx);
  if (!rcon) throw new ActionError('not_found', 'rcon is not configured for this game', false);
  const [out] = await rconRun(
    { port: rcon.port, password: rcon.password, timeoutMs: RCON_TIMEOUT_MS },
    [params.command],
  );
  return { output: cleanOutput(out ?? '', rcon.password) };
}

import { eq, like } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  isAllowedWolBroadcast,
  serverIdSchema,
  WOL_DEFAULTS,
  wolConfigSchema,
  wolMacSchema,
  type WolConfig,
} from '@hz/shared';
import type { AgentHub } from '../agents/hub.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import { HttpError } from '../http/errors.js';
import { rpcHttpError } from '../servers/routes.js';
import { WindowLimiter } from '../share/limits.js';
import { dgramSender, magicPacket, type UdpSender } from './packet.js';

/** Wake requests per minute and server (SPEC 16). */
export const WAKES_PER_MIN = 6;
const WOL_RPC_TIMEOUT_MS = 10_000;
const KEY_PREFIX = 'wol.';

export const wolKey = (serverId: string): string => `${KEY_PREFIX}${serverId}`;

/** What is stored; parsed strictly again on every read (a broken entry counts as not set up). */
const storedWolSchema = z.strictObject({
  mac: wolMacSchema,
  broadcast: z.string().max(15).refine(isAllowedWolBroadcast),
  port: z.union([z.literal(7), z.literal(9)]),
  via: z.union([z.literal('core'), serverIdSchema]),
});
type StoredWol = z.infer<typeof storedWolSchema>;

function readStored(db: Db, serverId: string): StoredWol | null {
  const parsed = storedWolSchema.safeParse(readSetting(db, wolKey(serverId)));
  return parsed.success ? parsed.data : null;
}

/**
 * Called when a server is deleted: forgets its Wake-on-LAN entry, and entries
 * of other servers that used it as sender fall back to the core.
 */
export function removeWolConfig(db: Db, serverId: string, now: number = Date.now()): void {
  db.delete(settings)
    .where(eq(settings.key, wolKey(serverId)))
    .run();
  const rows = db
    .select()
    .from(settings)
    .where(like(settings.key, `${KEY_PREFIX}%`))
    .all();
  for (const row of rows) {
    const other = row.key.slice(KEY_PREFIX.length);
    const s = readStored(db, other);
    if (s?.via === serverId) writeSetting(db, row.key, { ...s, via: 'core' }, now);
  }
}

export interface WolServers {
  row(id: string): { id: string; name: string } | undefined;
}

export interface WolServiceDeps {
  db: Db;
  now: Clock;
  servers: WolServers;
  hub: Pick<AgentHub, 'call' | 'isConnected'>;
  log: FastifyBaseLogger;
  /** UDP for via 'core' (tests: a recorder). Default node:dgram. */
  udp?: UdpSender;
}

export type WolRequest = {
  mac: string | null;
  broadcast: string;
  port: 7 | 9;
  via: string;
};

const NOT_SET_UP = 'Keine MAC-Adresse eingetragen';

/**
 * Wake-on-LAN per server (SPEC 16). The magic packet goes out from the core
 * (host network) or from the agent of another server in the same LAN
 * (`wol.send`, which checks MAC, broadcast and port again).
 */
export class WolService {
  private readonly udp: UdpSender;
  private readonly limiter: WindowLimiter;

  constructor(private readonly deps: WolServiceDeps) {
    this.udp = deps.udp ?? dgramSender;
    this.limiter = new WindowLimiter(WAKES_PER_MIN, 60_000, deps.now);
  }

  private requireServer(id: string): { id: string; name: string } {
    const row = this.deps.servers.row(id);
    if (!row) throw new HttpError(404, 'not_found');
    return row;
  }

  get(serverId: string): WolConfig {
    this.requireServer(serverId);
    const s = readStored(this.deps.db, serverId);
    return wolConfigSchema.parse(s ?? { mac: null, ...WOL_DEFAULTS });
  }

  /** Body already parsed with wolConfigRequestSchema. */
  set(serverId: string, body: WolRequest): WolConfig {
    this.requireServer(serverId);
    if (body.mac === null) {
      this.deps.db
        .delete(settings)
        .where(eq(settings.key, wolKey(serverId)))
        .run();
      return this.get(serverId);
    }
    if (body.via !== 'core') {
      if (body.via === serverId) {
        throw new HttpError(
          400,
          'invalid_input',
          undefined,
          'Ein Server kann sich nicht selbst aufwecken',
        );
      }
      if (!this.deps.servers.row(body.via)) {
        throw new HttpError(400, 'invalid_input', undefined, 'Sender-Server nicht gefunden');
      }
    }
    const stored = storedWolSchema.parse({
      mac: body.mac,
      broadcast: body.broadcast,
      port: body.port,
      via: body.via,
    });
    writeSetting(this.deps.db, wolKey(serverId), stored, this.deps.now());
    return this.get(serverId);
  }

  /** Sends one magic packet. 404 not set up, 429 rate limit, 409 sender agent offline. */
  async wake(serverId: string): Promise<{ via: string }> {
    this.requireServer(serverId);
    const s = readStored(this.deps.db, serverId);
    if (!s) throw new HttpError(404, 'not_found', undefined, NOT_SET_UP);
    const wait = this.limiter.hit(serverId);
    if (wait !== null) throw new HttpError(429, 'rate_limited', wait);
    if (s.via === 'core') {
      try {
        await this.udp.send(magicPacket(s.mac), s.port, s.broadcast);
      } catch {
        this.deps.log.warn({ serverId }, 'wake-on-lan send failed');
        throw new HttpError(500, 'internal', undefined, 'Paket konnte nicht gesendet werden');
      }
      return { via: 'core' };
    }
    if (s.via === serverId || !this.deps.servers.row(s.via)) {
      throw new HttpError(409, 'conflict', undefined, 'Sender-Server nicht gefunden');
    }
    if (!this.deps.hub.isConnected(s.via)) throw new HttpError(409, 'agent_offline');
    try {
      await this.deps.hub.call(
        s.via,
        'wol.send',
        { mac: s.mac, broadcast: s.broadcast, port: s.port },
        { timeoutMs: WOL_RPC_TIMEOUT_MS },
      );
    } catch (err) {
      throw rpcHttpError(err);
    }
    return { via: s.via };
  }
}

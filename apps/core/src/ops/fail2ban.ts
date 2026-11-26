import { fail2banStatusDataSchema, type Fail2banServer } from '@hz/shared';
import { RpcError, type AgentHub } from '../agents/hub.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { rpcHttpError } from '../servers/routes.js';
import { rpcState, serverRefs, type ServerRef } from './common.js';

export const FAIL2BAN_TIMEOUT_MS = 15_000;
export const FAIL2BAN_CACHE_MS = 30_000;

/**
 * fail2ban jails and banned IPs per server, live from the agents (cached 30 s
 * per server), and unban of one IP in one jail.
 */
export class Fail2banService {
  private readonly cache = new Map<string, { at: number; value: Fail2banServer }>();
  private readonly inflight = new Map<string, Promise<Fail2banServer>>();
  /**
   * Bumped per server on every unban (and forget). A status request only stores
   * its result and clears its in-flight entry while the generation it started in
   * is still current, so a request that predates an unban never writes stale
   * jails into the cache nor drops the newer request.
   */
  private readonly generation = new Map<string, number>();

  constructor(private readonly deps: { db: Db; now: Clock; hub: AgentHub }) {}

  async list(): Promise<Fail2banServer[]> {
    return Promise.all(serverRefs(this.deps.db).map((s) => this.status(s)));
  }

  async unban(serverId: string, jail: string, ip: string): Promise<Fail2banServer> {
    const server = serverRefs(this.deps.db).find((s) => s.id === serverId);
    if (!server) throw new HttpError(404, 'not_found');
    if (!this.deps.hub.isConnected(serverId)) throw new HttpError(409, 'agent_offline');
    try {
      await this.deps.hub.call(
        serverId,
        'fail2ban.unban',
        { jail, ip },
        { timeoutMs: FAIL2BAN_TIMEOUT_MS },
      );
    } catch (err) {
      // Older agents answer invalid_params for an unknown jail, newer not_found.
      if (err instanceof RpcError && (err.code === 'not_found' || err.code === 'invalid_params')) {
        throw new HttpError(404, 'not_found', undefined, 'Jail nicht gefunden');
      }
      if (err instanceof RpcError && err.code === 'not_allowed') {
        throw new HttpError(409, 'conflict', undefined, 'Agent kann Fail2ban nicht steuern');
      }
      throw rpcHttpError(err);
    } finally {
      // The next status is fresh (an older in-flight request may predate the unban).
      this.invalidate(serverId);
    }
    return this.status(server);
  }

  forget(serverId: string): void {
    this.invalidate(serverId);
  }

  private gen(serverId: string): number {
    return this.generation.get(serverId) ?? 0;
  }

  private invalidate(serverId: string): void {
    this.generation.set(serverId, this.gen(serverId) + 1);
    this.cache.delete(serverId);
    this.inflight.delete(serverId);
  }

  clear(): void {
    this.cache.clear();
  }

  private async status(s: ServerRef): Promise<Fail2banServer> {
    const now = this.deps.now();
    if (!this.deps.hub.isConnected(s.id)) {
      this.cache.delete(s.id);
      return this.entry(s, 'offline', []);
    }
    const hit = this.cache.get(s.id);
    if (hit && now - hit.at < FAIL2BAN_CACHE_MS) return hit.value;
    const running = this.inflight.get(s.id);
    if (running) return running;
    const g = this.gen(s.id);
    const p = this.fetch(s, g).finally(() => {
      if (this.gen(s.id) === g) this.inflight.delete(s.id);
    });
    this.inflight.set(s.id, p);
    return p;
  }

  private async fetch(s: ServerRef, g: number): Promise<Fail2banServer> {
    let value: Fail2banServer;
    try {
      const raw = await this.deps.hub.call(
        s.id,
        'fail2ban.status',
        {},
        {
          timeoutMs: FAIL2BAN_TIMEOUT_MS,
        },
      );
      const data = fail2banStatusDataSchema.safeParse(raw);
      if (!data.success) value = this.entry(s, 'failed', []);
      else if (!data.data.installed) value = this.entry(s, 'not_installed', []);
      else value = this.entry(s, 'ok', data.data.jails);
    } catch (err) {
      const state = rpcState(err);
      // Offline is never cached: the next request after a reconnect asks again.
      if (state === 'offline') return this.entry(s, 'offline', []);
      value = this.entry(s, state, []);
    }
    // Stale (an unban happened meanwhile): answer the caller, but do not cache.
    if (this.gen(s.id) === g) this.cache.set(s.id, { at: this.deps.now(), value });
    return value;
  }

  private entry(
    s: ServerRef,
    state: Fail2banServer['state'],
    jails: Fail2banServer['jails'],
  ): Fail2banServer {
    return {
      serverId: s.id,
      name: s.name,
      state,
      jails,
      fetchedAt: new Date(this.deps.now()).toISOString(),
    };
  }
}

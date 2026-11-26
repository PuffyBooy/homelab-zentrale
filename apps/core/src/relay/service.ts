import { and, asc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  publicIpv4Schema,
  RELAY_MAX_ROUTES,
  relaySetDataSchema,
  tailnetIpSchema,
  type GameRelay,
  type Ingress,
  type RelayRoute,
  type dnsSettingsRequestSchema,
  type dnsSettingsSchema,
  type gameRelayRequestSchema,
  type ingressUpdateRequestSchema,
} from '@hz/shared';
import { RpcError, type AgentHub } from '../agents/hub.js';
import type { FetchLike } from '../checks/rdap.js';
import type { Clock } from '../clock.js';
import type { SecretBox } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import {
  gameRelays,
  gameServers,
  serverIngress,
  servers,
  type GameRelayRow,
  type GameServerRow,
  type ServerIngressRow,
  type ServerRow,
} from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import { HttpError } from '../http/errors.js';
import { emptyUsed, isFree, markUsed, protosOf, type UsedPorts } from '../games/ports.js';
import type { HostPort } from '../games/render.js';
import type { GameRelayHooks, GameService } from '../games/service.js';
import { deleteARecord, DnsError, nameAllowed, setARecord, type DnsConfig } from './dns.js';

/**
 * M15 game relay (packages/shared/src/api/relay.ts, SPEC 6.6).
 *
 * Per ingress the core computes the routes of all games assigned to it (every
 * public port of the game, same number on the ingress, tcp+udp = two routes) with
 * the current host's Tailscale address as target and sends the whole list with
 * relay.set. It sends again whenever the list changes (assignment, ports, a move,
 * a deleted game, a new Tailscale address) and on every hello of the ingress agent.
 * The per-game result is stored in game_relays.state / error.
 *
 * Optional DNS: the A record of a game's name points to the ingress IPv4
 * (dns.ts). The provider token is stored encrypted (AAD DNS_AAD) and never
 * leaves this file except towards the provider.
 */

export const DNS_SETTING = 'relay.dns';
const DNS_AAD = 'settings.relay.dns.token';
export const RELAY_TIMEOUT_MS = 15_000;
/** relayRouteSchema allows up to 10 consecutive ports per route. */
const MAX_COUNT = 10;
const DEFAULT_RANGE = { from: 25565, to: 25600 } as const;

const PROTO_LABEL = { tcp: 'TCP', udp: 'UDP', 'tcp+udp': 'TCP+UDP' } as const;
const portRange = (port: number, count: number): string =>
  count > 1 ? `${port}–${port + count - 1}` : String(port);

export const RELAY_TEXT = {
  noTailnet: 'Server hat keine Tailscale-Adresse',
  noPorts: 'Keine öffentlichen Ports',
  tooMany: 'Zu viele Ports am Eingang',
  notAllowed: 'Relay am Eingang nicht erlaubt (HZ_AGENT_ALLOW_RELAY=1 fehlt)',
  timeout: 'Eingang antwortet nicht',
  failed: 'Relay konnte nicht gesetzt werden',
  noAnswer: 'Keine Antwort des Eingangs für diesen Port',
  disabled: 'Eingang ist ausgeschaltet',
} as const;

type DnsSettings = z.infer<typeof dnsSettingsSchema>;
type DnsSettingsRequest = z.output<typeof dnsSettingsRequestSchema>;
type IngressUpdate = z.output<typeof ingressUpdateRequestSchema>;
type GameRelayRequest = z.output<typeof gameRelayRequestSchema>;

const storedDnsSchema = z.object({
  provider: z.enum(['none', 'cloudflare', 'duckdns']).catch('none'),
  tokenEnc: z.string().nullable().catch(null),
  zoneId: z.string().nullable().catch(null),
  lastError: z.string().nullable().catch(null),
  lastUpdateAt: z.number().nullable().catch(null),
});
type StoredDns = z.infer<typeof storedDnsSchema>;
const EMPTY_DNS: StoredDns = {
  provider: 'none',
  tokenEnc: null,
  zoneId: null,
  lastError: null,
  lastUpdateAt: null,
};

export interface RelayDeps {
  db: Db;
  box: SecretBox;
  now: Clock;
  hub: Pick<AgentHub, 'call' | 'isConnected'>;
  servers: { isConnected(id: string): boolean; isVirtual(id: string): boolean };
  games: GameService;
  log: FastifyBaseLogger;
  /** HTTP for the DNS providers (tests: a fake). */
  fetch?: FetchLike;
}

const listenPortsSchema = z
  .array(z.object({ name: z.string(), port: z.number().int().min(1024).max(65535) }))
  .max(20);

/** A public port of a game: where the ingress listens and where the host publishes it. */
interface PortPair {
  listen: HostPort;
  host: HostPort;
}

interface PlanEntry {
  routeIds: string[];
  /** Fixed reason the game gets no routes. */
  error: string | null;
  /** Runs on the ingress itself: reachable directly, no routes. */
  direct: boolean;
}

interface Plan {
  routes: RelayRoute[];
  games: Map<string, PlanEntry>;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export class RelayService implements GameRelayHooks {
  /** JSON of the routes the ingress agent accepted last (cleared on hello / offline). */
  private readonly lastSent = new Map<string, string>();
  private readonly chains = new Map<string, Promise<void>>();
  private dnsChain: Promise<void> = Promise.resolve();
  private readonly background = new Set<Promise<unknown>>();
  private queued = false;
  private stopped = false;

  constructor(private readonly deps: RelayDeps) {}

  /** Core shutdown: no new reconciles (the database closes next). */
  stop(): void {
    this.stopped = true;
  }

  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.catch((err: unknown) =>
      this.deps.log.error(
        { err: err instanceof Error ? { name: err.name, stack: err.stack } : 'error' },
        'relay task failed',
      ),
    );
    this.background.add(tracked);
    void tracked.finally(() => this.background.delete(tracked));
  }

  // ---- reads ------------------------------------------------------------------------

  private serverRow(id: string): ServerRow | undefined {
    return this.deps.db.select().from(servers).where(eq(servers.id, id)).get();
  }

  private ingressRow(id: string): ServerIngressRow | undefined {
    return this.deps.db.select().from(serverIngress).where(eq(serverIngress.serverId, id)).get();
  }

  private relayRow(gameId: string): GameRelayRow | undefined {
    return this.deps.db.select().from(gameRelays).where(eq(gameRelays.gameId, gameId)).get();
  }

  /** Relays of an ingress, oldest assignment first (it keeps its ports on a conflict). */
  private relaysOf(ingressId: string): GameRelayRow[] {
    return this.deps.db
      .select()
      .from(gameRelays)
      .where(eq(gameRelays.ingressServerId, ingressId))
      .orderBy(asc(gameRelays.updatedAt), asc(gameRelays.gameId))
      .all();
  }

  /**
   * Public ports of a relayed game: the listen port on the ingress is the one stored
   * at assignment (friends keep it), the host port the current one. A port name
   * without a stored port (template changed) listens on its host port.
   */
  private pairsOf(r: Pick<GameRelayRow, 'listenPortsJson'>, game: GameServerRow): PortPair[] {
    let stored = new Map<string, number>();
    try {
      const parsed = listenPortsSchema.safeParse(JSON.parse(r.listenPortsJson));
      if (parsed.success) stored = new Map(parsed.data.map((p) => [p.name, p.port]));
    } catch {
      // Unreadable: fall back to the host ports.
    }
    return this.deps.games.publicPortsOf(game).map((host) => ({
      host,
      listen: { ...host, port: stored.get(host.name) ?? host.port },
    }));
  }

  private listenOf(r: Pick<GameRelayRow, 'listenPortsJson'>, game: GameServerRow): HostPort[] {
    return this.pairsOf(r, game).map((p) => p.listen);
  }

  private gamesOn(serverId: string): GameServerRow[] {
    return this.deps.db.select().from(gameServers).where(eq(gameServers.serverId, serverId)).all();
  }

  private capable(server: ServerRow | undefined): boolean {
    if (!server?.capabilitiesJson) return false;
    try {
      const caps = JSON.parse(server.capabilitiesJson) as { relay?: unknown };
      return caps.relay === true;
    } catch {
      return false;
    }
  }

  /** The IPv4 friends connect to: the admin's value, else a public IP from the inventory. */
  private publicIpOf(ing: ServerIngressRow | undefined, server: ServerRow | undefined) {
    if (ing?.publicIp) return ing.publicIp;
    const inv = server?.publicIp ?? null;
    return inv !== null && publicIpv4Schema.safeParse(inv).success ? inv : null;
  }

  private firewallHint(from: number, to: number): string {
    return `Firewall des Anbieters: ${from === to ? from : `${from}–${to}`} TCP und UDP öffnen`;
  }

  private toIngress(server: ServerRow, ing: ServerIngressRow | undefined): Ingress {
    const from = ing?.portFrom ?? DEFAULT_RANGE.from;
    const to = ing?.portTo ?? DEFAULT_RANGE.to;
    const games = this.relaysOf(server.id)
      .map((r) => this.deps.games.row(r.gameId))
      .filter((g): g is GameServerRow => g !== undefined)
      .map((g) => ({ id: g.id, name: g.name }));
    return {
      serverId: server.id,
      serverName: server.name,
      enabled: ing?.enabled ?? false,
      publicIp: this.publicIpOf(ing, server),
      portFrom: from,
      portTo: to,
      capable: this.capable(server),
      connected: this.deps.servers.isConnected(server.id),
      games,
      firewallHint: this.firewallHint(from, to),
    };
  }

  /** Every server with its ingress state, by name. */
  ingresses(): Ingress[] {
    const ings = new Map(
      this.deps.db
        .select()
        .from(serverIngress)
        .all()
        .map((i) => [i.serverId, i]),
    );
    return this.deps.db
      .select()
      .from(servers)
      .all()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => this.toIngress(s, ings.get(s.id)));
  }

  ingress(serverId: string): Ingress | null {
    const server = this.serverRow(serverId);
    return server ? this.toIngress(server, this.ingressRow(serverId)) : null;
  }

  // ---- GameRelayHooks ------------------------------------------------------------------

  relayOf(gameId: string): GameRelay | null {
    const r = this.relayRow(gameId);
    if (!r) return null;
    const server = this.serverRow(r.ingressServerId);
    const ip = this.publicIpOf(this.ingressRow(r.ingressServerId), server);
    const game = this.deps.games.row(gameId);
    const port = game ? this.listenOf(r, game)[0]?.port : undefined;
    const host = r.dnsName ?? ip;
    const dns = this.storedDns();
    return {
      ingressServerId: r.ingressServerId,
      ingressName: server?.name ?? r.ingressServerId,
      dnsName: r.dnsName,
      address: host === null ? null : port === undefined ? host : `${host}:${port}`,
      state: r.state === 'ok' || r.state === 'error' ? r.state : 'pending',
      error: r.error,
      dnsOk:
        r.dnsName === null || dns.provider === 'none' || dns.tokenEnc === null
          ? null
          : ip !== null && r.dnsIp === ip,
    };
  }

  listenPortsOn(serverId: string, exceptGameId?: string): HostPort[] {
    const out: HostPort[] = [];
    for (const r of this.relaysOf(serverId)) {
      if (r.gameId === exceptGameId) continue;
      const game = this.deps.games.row(r.gameId);
      if (!game || game.serverId === serverId) continue;
      out.push(...this.listenOf(r, game));
    }
    return out;
  }

  /**
   * Host ports never touch the ingress (it keeps its stored listen ports), so only
   * running on the ingress itself is a conflict.
   */
  checkPorts(gameId: string, hostServerId: string, _ports: readonly HostPort[]): void {
    const r = this.relayRow(gameId);
    if (r && r.ingressServerId === hostServerId) {
      throw new HttpError(
        409,
        'conflict',
        undefined,
        'Das Ziel ist der Eingang dieses Gameservers: erst das Relay entfernen',
      );
    }
  }

  hint(gameId: string): string | null {
    const r = this.relayRow(gameId);
    const game = this.deps.games.row(gameId);
    if (!r || !game) return null;
    const name = this.serverRow(r.ingressServerId)?.name ?? r.ingressServerId;
    const parts = this.listenOf(r, game).map(
      (p) => `${p.name} ${portRange(p.port, p.count)} (${PROTO_LABEL[p.protocol]})`,
    );
    const address = this.relayOf(gameId)?.address ?? null;
    const stays = address ? `Adresse bleibt ${address}` : 'Adresse bleibt gleich';
    return parts.length === 0
      ? `${stays} (Eingang ${name}). Kein Router-Portforwarding nötig`
      : `${stays} (Eingang ${name}). Kein Router-Portforwarding nötig, Ports am Eingang ${name} in der Firewall des Anbieters: ${parts.join(', ')}`;
  }

  /** The ingress of a game's relay, null without. */
  ingressOf(gameId: string): string | null {
    return this.relayRow(gameId)?.ingressServerId ?? null;
  }

  // ---- checks -----------------------------------------------------------------------

  /** Ports in use on the ingress, without `gameId`: games running there and other relays. */
  private usedOnIngress(ingressId: string, gameId: string): UsedPorts {
    const used = emptyUsed();
    for (const g of this.gamesOn(ingressId)) {
      if (g.id === gameId) continue;
      for (const p of this.deps.games.publicPortsOf(g)) markUsed(used, p);
    }
    for (const r of this.relaysOf(ingressId)) {
      if (r.gameId === gameId) continue;
      const g = this.deps.games.row(r.gameId);
      if (!g || g.serverId === ingressId) continue;
      for (const p of this.listenOf(r, g)) markUsed(used, p);
    }
    return used;
  }

  private rangeError(ing: ServerIngressRow, pub: readonly HostPort[]): string | null {
    for (const p of pub) {
      if (p.port < ing.portFrom || p.port + p.count - 1 > ing.portTo) {
        return `Port ${portRange(p.port, p.count)} liegt nicht im Bereich des Eingangs (${ing.portFrom}–${ing.portTo})`;
      }
    }
    return null;
  }

  private overlapError(used: UsedPorts, pub: readonly HostPort[]): string | null {
    for (const p of pub) {
      if (!isFree(used, p)) {
        return `Port ${portRange(p.port, p.count)} (${PROTO_LABEL[p.protocol]}) ist am Eingang schon belegt`;
      }
    }
    return null;
  }

  private routeCount(pub: readonly HostPort[]): number {
    return pub.reduce(
      (n, p) => n + protosOf(p.protocol).length * Math.ceil(p.count / MAX_COUNT),
      0,
    );
  }

  /** German reason why the game's public ports cannot be relayed by this ingress, or null. */
  private conflict(
    ingressId: string,
    gameId: string,
    hostServerId: string,
    pub: readonly HostPort[],
  ): string | null {
    const ing = this.ingressRow(ingressId);
    if (!ing?.enabled) return 'Server ist kein Eingang';
    if (hostServerId === ingressId) return 'Der Gameserver läuft auf dem Eingang selbst';
    const range = this.rangeError(ing, pub);
    if (range !== null) return range;
    const overlap = this.overlapError(this.usedOnIngress(ingressId, gameId), pub);
    if (overlap !== null) return overlap;
    const others = this.plan(ingressId).routes.filter((r) => !r.id.startsWith(`${gameId}:`));
    if (others.length + this.routeCount(pub) > RELAY_MAX_ROUTES) return RELAY_TEXT.tooMany;
    return null;
  }

  // ---- plan and send ----------------------------------------------------------------

  /** Routes of an ingress and the outcome per game (before the agent answered). */
  plan(ingressId: string): Plan {
    const ing = this.ingressRow(ingressId);
    const plan: Plan = { routes: [], games: new Map() };
    const relays = this.relaysOf(ingressId);
    if (!ing?.enabled) {
      for (const r of relays) {
        plan.games.set(r.gameId, { routeIds: [], error: RELAY_TEXT.disabled, direct: false });
      }
      return plan;
    }
    const used = emptyUsed();
    const relayed = new Set(relays.map((r) => r.gameId));
    for (const g of this.gamesOn(ingressId)) {
      if (relayed.has(g.id)) continue;
      for (const p of this.deps.games.publicPortsOf(g)) markUsed(used, p);
    }
    for (const r of relays) {
      const game = this.deps.games.row(r.gameId);
      if (!game) continue;
      const pairs = this.pairsOf(r, game);
      const pub = pairs.map((p) => p.listen);
      const fail = (error: string) =>
        plan.games.set(r.gameId, { routeIds: [], error, direct: false });
      if (game.serverId === ingressId) {
        // Reached directly on the ingress's own ports.
        for (const p of pub) markUsed(used, p);
        plan.games.set(r.gameId, { routeIds: [], error: null, direct: true });
        continue;
      }
      const host = this.serverRow(game.serverId)?.tailscaleIp ?? null;
      if (host === null || !tailnetIpSchema.safeParse(host).success) {
        fail(RELAY_TEXT.noTailnet);
        continue;
      }
      if (pub.length === 0) {
        fail(RELAY_TEXT.noPorts);
        continue;
      }
      const reason = this.rangeError(ing, pub) ?? this.overlapError(used, pub);
      if (reason !== null) {
        fail(reason);
        continue;
      }
      const routes: RelayRoute[] = [];
      for (const { listen, host: hp } of pairs) {
        for (const proto of protosOf(listen.protocol)) {
          for (let off = 0; off < listen.count; off += MAX_COUNT) {
            routes.push({
              id: `${r.gameId}:${listen.name}:${proto}${off === 0 ? '' : `:${off}`}`,
              protocol: proto,
              // Friends keep the stored port; the target follows the host port.
              listenPort: listen.port + off,
              count: Math.min(MAX_COUNT, listen.count - off),
              target: { host, port: hp.port + off },
            });
          }
        }
      }
      if (plan.routes.length + routes.length > RELAY_MAX_ROUTES) {
        fail(RELAY_TEXT.tooMany);
        continue;
      }
      for (const p of pub) markUsed(used, p);
      plan.routes.push(...routes);
      plan.games.set(r.gameId, { routeIds: routes.map((x) => x.id), error: null, direct: false });
    }
    // Stable order for the agent and for comparing with the last list sent.
    plan.routes.sort(
      (a, b) =>
        a.listenPort - b.listenPort ||
        a.protocol.localeCompare(b.protocol) ||
        a.id.localeCompare(b.id),
    );
    return plan;
  }

  /**
   * Computes the routes of an ingress and sends them with relay.set when they
   * changed (or `force`: after the agent's hello). Serialised per ingress.
   */
  reconcile(ingressId: string, force = false): Promise<void> {
    const prev = this.chains.get(ingressId) ?? Promise.resolve();
    const next = prev.then(() => this.runReconcile(ingressId, force));
    const settled = next.catch((err: unknown) => {
      this.deps.log.error(
        { err: err instanceof Error ? { name: err.name, stack: err.stack } : 'error' },
        'relay reconcile failed',
      );
    });
    this.chains.set(ingressId, settled);
    void settled.finally(() => {
      if (this.chains.get(ingressId) === settled) this.chains.delete(ingressId);
    });
    return settled;
  }

  private async runReconcile(ingressId: string, force: boolean): Promise<void> {
    if (this.stopped) return;
    // Demo servers (HZ_DEMO=1) have no agent: their seeded state stays.
    if (this.deps.servers.isVirtual(ingressId) && !this.deps.hub.isConnected(ingressId)) return;
    const plan = this.plan(ingressId);
    const json = JSON.stringify(plan.routes);
    const outcome = new Map<string, { state: 'ok' | 'pending' | 'error'; error: string | null }>();
    const withRoutes: [string, PlanEntry][] = [];
    for (const [gameId, e] of plan.games) {
      if (e.error !== null) outcome.set(gameId, { state: 'error', error: e.error });
      else if (e.direct) outcome.set(gameId, { state: 'ok', error: null });
      else withRoutes.push([gameId, e]);
    }
    const connected = this.deps.hub.isConnected(ingressId);
    const last = this.lastSent.get(ingressId);
    if (!connected) {
      this.lastSent.delete(ingressId);
      for (const [gameId] of withRoutes) outcome.set(gameId, { state: 'pending', error: null });
    } else if (!force && (last ?? '[]') === json) {
      // Unchanged: the stored states are still right.
    } else if (
      force &&
      plan.routes.length === 0 &&
      !this.capable(this.serverRow(ingressId)) &&
      last === undefined
    ) {
      // A fresh agent without relay capability and nothing to relay: nothing to send.
    } else {
      try {
        const data = await this.deps.hub.call(
          ingressId,
          'relay.set',
          { routes: plan.routes },
          { timeoutMs: RELAY_TIMEOUT_MS },
        );
        this.lastSent.set(ingressId, json);
        const parsed = relaySetDataSchema.safeParse(data);
        const results = new Map(parsed.success ? parsed.data.routes.map((r) => [r.id, r]) : []);
        for (const [gameId, e] of withRoutes) {
          const failed = e.routeIds
            .map((id) => results.get(id))
            .find((r) => r === undefined || !r.ok);
          if (!parsed.success) outcome.set(gameId, { state: 'error', error: RELAY_TEXT.failed });
          else if (failed === undefined) outcome.set(gameId, { state: 'ok', error: null });
          else {
            outcome.set(gameId, {
              state: 'error',
              error: failed.error?.slice(0, 200) ?? RELAY_TEXT.noAnswer,
            });
          }
        }
      } catch (err) {
        const code = err instanceof RpcError ? err.code : 'failed';
        const offline = code === 'offline' || code === 'disconnected';
        if (offline) this.lastSent.delete(ingressId);
        // Refusals are not retried on every game change; the next hello sends again.
        else this.lastSent.set(ingressId, json);
        const error = offline
          ? null
          : code === 'not_allowed'
            ? RELAY_TEXT.notAllowed
            : code === 'timeout'
              ? RELAY_TEXT.timeout
              : RELAY_TEXT.failed;
        if (!offline) {
          this.deps.log.warn({ serverId: ingressId, code }, 'relay.set refused');
        }
        for (const [gameId] of withRoutes) {
          outcome.set(gameId, { state: offline ? 'pending' : 'error', error });
        }
      }
    }
    this.store(outcome);
  }

  private store(
    outcome: Map<string, { state: 'ok' | 'pending' | 'error'; error: string | null }>,
  ): void {
    for (const [gameId, o] of outcome) {
      const r = this.relayRow(gameId);
      if (!r || (r.state === o.state && r.error === o.error)) continue;
      this.deps.db
        .update(gameRelays)
        .set({ state: o.state, error: o.error })
        .where(eq(gameRelays.gameId, gameId))
        .run();
      this.deps.games.touch(gameId);
    }
  }

  /** Every ingress, coalesced (game changes, inventories). */
  queueAll(): void {
    if (this.queued || this.stopped) return;
    this.queued = true;
    setImmediate(() => {
      this.queued = false;
      if (this.stopped) return;
      const ids = new Set([
        ...this.deps.db
          .select({ id: serverIngress.serverId })
          .from(serverIngress)
          .all()
          .map((r) => r.id),
        ...this.lastSent.keys(),
      ]);
      for (const id of ids) this.track(this.reconcile(id));
    });
  }

  /** Agent hello: the agent may have restarted without routes. */
  onAgentConnected(serverId: string): void {
    if (!this.ingressRow(serverId)) return;
    this.lastSent.delete(serverId);
    this.track(this.reconcile(serverId, true));
  }

  /** New inventory: Tailscale or public addresses may have changed. */
  onInventory(serverId: string): void {
    this.queueAll();
    const ing = this.ingressRow(serverId);
    if (!ing?.enabled || ing.publicIp !== null) return;
    for (const r of this.relaysOf(serverId)) {
      if (r.dnsName !== null) this.track(this.applyDns(r.gameId));
    }
  }

  onServerDeleted(serverId: string): void {
    this.lastSent.delete(serverId);
    this.queueAll();
  }

  // ---- admin changes ----------------------------------------------------------------

  async updateIngress(serverId: string, req: IngressUpdate): Promise<Ingress> {
    const server = this.serverRow(serverId);
    if (!server) throw new HttpError(404, 'not_found');
    const prev = this.ingressRow(serverId);
    const prevIp = this.publicIpOf(prev, server);
    const assigned = this.relaysOf(serverId);
    if (!req.enabled && assigned.length > 0) {
      throw new HttpError(
        409,
        'conflict',
        undefined,
        'Erst die Gameserver von diesem Eingang nehmen',
      );
    }
    for (const r of assigned) {
      const game = this.deps.games.row(r.gameId);
      if (!game || game.serverId === serverId) continue;
      const pub = this.listenOf(r, game);
      const bad = pub.find((p) => p.port < req.portFrom || p.port + p.count - 1 > req.portTo);
      if (bad) {
        throw new HttpError(
          409,
          'conflict',
          undefined,
          `Portbereich passt nicht zu ${game.name} (Port ${portRange(bad.port, bad.count)})`,
        );
      }
    }
    const now = this.deps.now();
    const values = {
      enabled: req.enabled,
      publicIp: req.publicIp,
      portFrom: req.portFrom,
      portTo: req.portTo,
      updatedAt: now,
    };
    this.deps.db
      .insert(serverIngress)
      .values({ serverId, ...values })
      .onConflictDoUpdate({ target: serverIngress.serverId, set: values })
      .run();
    const stored = this.ingressRow(serverId);
    writeAudit(this.deps.db, now, {
      actor: 'admin',
      action: 'server.ingress_updated',
      target: serverId,
      details: {
        name: server.name,
        enabled: stored?.enabled ?? false,
        publicIp: stored?.publicIp ?? null,
        portFrom: stored?.portFrom ?? null,
        portTo: stored?.portTo ?? null,
      },
    });
    await this.reconcile(serverId);
    if (this.publicIpOf(stored, server) !== prevIp) {
      for (const r of assigned) if (r.dnsName !== null) await this.applyDns(r.gameId);
    }
    for (const r of assigned) this.deps.games.touch(r.gameId);
    return this.ingress(serverId) as Ingress;
  }

  async setRelay(gameId: string, req: GameRelayRequest): Promise<GameRelay | null> {
    const game = this.deps.games.row(gameId);
    if (!game) throw new HttpError(404, 'not_found');
    const prev = this.relayRow(gameId);
    const now = this.deps.now();
    if (req.ingressServerId === null) {
      if (!prev) return null;
      this.deps.db.delete(gameRelays).where(eq(gameRelays.gameId, gameId)).run();
      writeAudit(this.deps.db, now, {
        actor: 'admin',
        action: 'game.relay_removed',
        target: gameId,
        details: { name: game.name, ingress: prev.ingressServerId },
      });
      await this.reconcile(prev.ingressServerId);
      await this.releaseName(gameId, prev);
      this.deps.games.touch(gameId);
      return null;
    }
    const ingressId = req.ingressServerId;
    const server = this.serverRow(ingressId);
    if (!server) throw new HttpError(404, 'not_found');
    const ing = this.ingressRow(ingressId);
    if (!ing?.enabled) throw new HttpError(409, 'conflict', undefined, 'Server ist kein Eingang');
    if (!this.capable(server)) {
      throw new HttpError(409, 'conflict', undefined, RELAY_TEXT.notAllowed);
    }
    if (this.publicIpOf(ing, server) === null) {
      throw new HttpError(409, 'conflict', undefined, 'Eingang hat keine öffentliche IPv4');
    }
    if (game.serverId === ingressId) {
      throw new HttpError(
        400,
        'invalid_input',
        undefined,
        'Läuft schon auf dem Eingang, kein Relay nötig',
      );
    }
    const sameIngress = prev?.ingressServerId === ingressId;
    // Listen ports: kept while the ingress stays, else the game's current public ports.
    const pub =
      prev && sameIngress ? this.listenOf(prev, game) : this.deps.games.publicPortsOf(game);
    if (pub.length === 0) throw new HttpError(400, 'invalid_input', undefined, RELAY_TEXT.noPorts);
    const reason = this.conflict(ingressId, gameId, game.serverId, pub);
    if (reason !== null) throw new HttpError(409, 'conflict', undefined, reason);
    const dnsName = req.dnsName === undefined ? (prev?.dnsName ?? null) : req.dnsName;
    if (dnsName !== null) {
      const owner = this.nameOwner(dnsName, gameId);
      if (owner !== null) {
        throw new HttpError(409, 'conflict', undefined, `DNS-Name wird schon von ${owner} genutzt`);
      }
    }
    const dns = this.storedDns();
    if (dnsName !== null && dns.provider !== 'none' && !nameAllowed(dns.provider, dnsName)) {
      throw new HttpError(
        400,
        'invalid_input',
        undefined,
        'Bei DuckDNS nur Namen unter duckdns.org',
      );
    }
    const values = {
      listenPortsJson: JSON.stringify(pub.map((p) => ({ name: p.name, port: p.port }))),
      ingressServerId: ingressId,
      dnsName,
      dnsIp: prev?.dnsName === dnsName ? (prev?.dnsIp ?? null) : null,
      state: sameIngress ? prev.state : 'pending',
      error: sameIngress ? prev.error : null,
      // A new assignment goes last: on a port conflict the older relay keeps its ports.
      updatedAt: sameIngress ? prev.updatedAt : now,
    };
    this.deps.db
      .insert(gameRelays)
      .values({ gameId, ...values })
      .onConflictDoUpdate({ target: gameRelays.gameId, set: values })
      .run();
    writeAudit(this.deps.db, now, {
      actor: 'admin',
      action: 'game.relay_set',
      target: gameId,
      details: {
        name: game.name,
        ingress: ingressId,
        ingressName: server.name,
        dnsName,
        ports: pub.map((p) => ({ name: p.name, port: p.port, protocol: p.protocol })),
      },
    });
    await this.reconcile(ingressId);
    if (prev && !sameIngress) await this.reconcile(prev.ingressServerId);
    if (prev && prev.dnsName !== dnsName) await this.releaseName(gameId, prev);
    if (dnsName !== null) await this.applyDns(gameId);
    this.deps.games.touch(gameId);
    return this.relayOf(gameId);
  }

  // ---- DNS ----------------------------------------------------------------------------

  private storedDns(): StoredDns {
    const parsed = storedDnsSchema.safeParse(readSetting(this.deps.db, DNS_SETTING) ?? EMPTY_DNS);
    return parsed.success ? parsed.data : EMPTY_DNS;
  }

  private writeDns(next: StoredDns): void {
    writeSetting(this.deps.db, DNS_SETTING, next, this.deps.now());
  }

  /** Never the token: only whether one is stored. */
  dnsSettings(): DnsSettings {
    const s = this.storedDns();
    return {
      provider: s.provider,
      tokenSet: s.tokenEnc !== null,
      zoneId: s.provider === 'cloudflare' ? s.zoneId : null,
      lastError: s.lastError,
      lastUpdateAt: s.lastUpdateAt === null ? null : iso(s.lastUpdateAt),
    };
  }

  private dnsConfig(): DnsConfig | null {
    const s = this.storedDns();
    if (s.provider === 'none' || s.tokenEnc === null) return null;
    let token: string;
    try {
      token = this.deps.box.decrypt(s.tokenEnc, DNS_AAD);
    } catch {
      return null;
    }
    return { provider: s.provider, token, zoneId: s.zoneId };
  }

  async updateDns(req: DnsSettingsRequest): Promise<DnsSettings> {
    const prev = this.storedDns();
    const now = this.deps.now();
    let next: StoredDns;
    if (req.provider === 'none') {
      next = { ...EMPTY_DNS };
    } else {
      // A token is only ever sent to the provider it was entered for.
      if (req.token === undefined && req.provider !== prev.provider) {
        throw new HttpError(
          400,
          'invalid_input',
          undefined,
          'Bei einem Anbieterwechsel das Token neu eingeben',
        );
      }
      const tokenEnc =
        req.token !== undefined ? this.deps.box.encrypt(req.token, DNS_AAD) : prev.tokenEnc;
      if (tokenEnc === null) {
        throw new HttpError(400, 'invalid_input', undefined, 'Token fehlt');
      }
      const zoneId =
        req.provider === 'cloudflare'
          ? req.zoneId === undefined
            ? prev.zoneId
            : req.zoneId
          : null;
      if (req.provider === 'cloudflare' && zoneId === null) {
        throw new HttpError(400, 'invalid_input', undefined, 'Cloudflare-Zone fehlt');
      }
      next = { provider: req.provider, tokenEnc, zoneId, lastError: null, lastUpdateAt: null };
    }
    this.writeDns(next);
    writeAudit(this.deps.db, now, {
      actor: 'admin',
      action: 'settings.dns_updated',
      target: null,
      details: {
        provider: next.provider,
        tokenChanged:
          req.token !== undefined || (req.provider === 'none' && prev.tokenEnc !== null),
        zoneId: next.zoneId,
      },
    });
    if (next.provider !== 'none') {
      const named = this.deps.db
        .select({ gameId: gameRelays.gameId, dnsName: gameRelays.dnsName })
        .from(gameRelays)
        .all()
        .filter((r) => r.dnsName !== null);
      for (const r of named) await this.applyDns(r.gameId, true);
    }
    return this.dnsSettings();
  }

  /** Name of the game that uses `dnsName` for its relay (other than `gameId`), or null. */
  private nameOwner(dnsName: string, gameId: string): string | null {
    const other = this.deps.db
      .select({ gameId: gameRelays.gameId })
      .from(gameRelays)
      .where(eq(gameRelays.dnsName, dnsName))
      .all()
      .find((r) => r.gameId !== gameId);
    if (!other) return null;
    return this.deps.games.row(other.gameId)?.name ?? other.gameId;
  }

  /**
   * A game gave up its DNS name: delete the A record the core set (Cloudflare,
   * only if it still points to that IP and no other game uses the name). DuckDNS
   * cannot delete; its record stays. Failures are reported, not thrown.
   */
  releaseName(gameId: string, prev: Pick<GameRelayRow, 'dnsName' | 'dnsIp'>): Promise<void> {
    const name = prev.dnsName;
    const ip = prev.dnsIp;
    if (name === null || ip === null || this.nameOwner(name, gameId) !== null) {
      return Promise.resolve();
    }
    const run = this.dnsChain.then(async () => {
      const cfg = this.dnsConfig();
      if (!cfg) return;
      try {
        const deleted = await deleteARecord(this.deps.fetch ?? fetch, cfg, name, ip);
        if (!deleted) return;
        writeAudit(this.deps.db, this.deps.now(), {
          actor: 'system',
          action: 'relay.dns_deleted',
          target: gameId,
          details: { name, provider: cfg.provider, ip },
        });
      } catch (err) {
        const text =
          err instanceof DnsError ? err.text : 'DNS-Eintrag konnte nicht gelöscht werden';
        this.writeDns({ ...this.storedDns(), lastError: text });
        this.deps.log.warn({ gameId, name, error: text }, 'dns delete failed');
        writeAudit(this.deps.db, this.deps.now(), {
          actor: 'system',
          action: 'relay.dns_failed',
          target: gameId,
          details: { name, provider: cfg.provider, error: text },
        });
      }
    });
    this.dnsChain = run.catch(() => undefined);
    return this.dnsChain;
  }

  /** Points the game's DNS name to its ingress (skipped when already done unless `force`). */
  applyDns(gameId: string, force = false): Promise<void> {
    const run = this.dnsChain.then(() => this.runDns(gameId, force));
    this.dnsChain = run.catch(() => undefined);
    return this.dnsChain;
  }

  private async runDns(gameId: string, force: boolean): Promise<void> {
    const r = this.relayRow(gameId);
    if (!r?.dnsName) return;
    const ip = this.publicIpOf(
      this.ingressRow(r.ingressServerId),
      this.serverRow(r.ingressServerId),
    );
    if (ip === null || (!force && r.dnsIp === ip)) return;
    const cfg = this.dnsConfig();
    if (!cfg) return;
    const name = r.dnsName;
    try {
      if (!nameAllowed(cfg.provider, name)) {
        throw new DnsError('Bei DuckDNS nur Namen unter duckdns.org');
      }
      await setARecord(this.deps.fetch ?? fetch, cfg, name, ip);
    } catch (err) {
      const text = err instanceof DnsError ? err.text : 'DNS-Eintrag konnte nicht gesetzt werden';
      this.writeDns({ ...this.storedDns(), lastError: text });
      this.deps.log.warn({ gameId, name, error: text }, 'dns update failed');
      writeAudit(this.deps.db, this.deps.now(), {
        actor: 'system',
        action: 'relay.dns_failed',
        target: gameId,
        details: { name, provider: cfg.provider, error: text },
      });
      this.deps.games.touch(gameId);
      return;
    }
    // Only if the relay still has this name and ingress (it may have changed meanwhile).
    this.deps.db
      .update(gameRelays)
      .set({ dnsIp: ip })
      .where(
        and(
          eq(gameRelays.gameId, gameId),
          eq(gameRelays.dnsName, name),
          eq(gameRelays.ingressServerId, r.ingressServerId),
        ),
      )
      .run();
    this.writeDns({ ...this.storedDns(), lastError: null, lastUpdateAt: this.deps.now() });
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'system',
      action: 'relay.dns_updated',
      target: gameId,
      details: { name, provider: cfg.provider, ip },
    });
    this.deps.games.touch(gameId);
  }
}

import { asc, eq } from 'drizzle-orm';
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
  type gameRelayRequestSchema,
  type ingressUpdateRequestSchema,
} from '@hz/shared';
import { RpcError, type AgentHub } from '../agents/hub.js';
import type { Clock } from '../clock.js';
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
import { HttpError } from '../http/errors.js';
import { emptyUsed, isFree, markUsed, protosOf, type UsedPorts } from '../games/ports.js';
import type { HostPort } from '../games/render.js';
import type { GameRelayHooks, GameService } from '../games/service.js';

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
 * Optional DNS: the A record of a game's name points to the ingress IPv4. The
 * record belongs to the domains module (M20, owner 'relay', ownerRef = game id),
 * reached through the small RelayDns interface (wired in app.ts, see
 * relay/domains-dns.ts). The relay never sees a provider token.
 *
 * When DNS is (re)applied: on assignment, name change, ingress switch and ingress
 * IP change (ensure), on unassignment and name removal (remove). Everything else
 * (domains module switched on, a provider added or its zones changed, a provider
 * that was down, records left over while the module was off or of deleted games)
 * is caught by syncDns(): every minute (job relay.dns) and right after the domains
 * module is switched on. It only calls ensure for relays whose record is missing
 * or points elsewhere; keeping an existing record in sync is the domains job.
 */

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

type IngressUpdate = z.output<typeof ingressUpdateRequestSchema>;
type GameRelayRequest = z.output<typeof gameRelayRequestSchema>;

export const DNS_TEXT = {
  moduleOff: 'Modul Domains ist aus (Einstellungen → Module).',
  noProvider: 'Kein DNS-Anbieter für diesen Namen (Internet → Domains).',
  pending: 'DNS-Eintrag wird gesetzt …',
  noIp: 'Eingang hat keine öffentliche IPv4',
  failed: 'DNS-Eintrag konnte nicht gesetzt werden',
} as const;

/** A relay-owned A record as the domains module stores it. */
export interface RelayDnsRecord {
  providerId: string;
  name: string;
  /** IPv4 the record should point to. */
  target: string | null;
  /** IPv4 the provider has (last sync). */
  value: string | null;
  status: 'ok' | 'pending' | 'error';
  /** German, no secret. */
  lastError: string | null;
}

/**
 * What the relay needs from the domains module (M20). One A record per game
 * (ownerRef = game id). ensure/remove throw HttpError with a fixed German
 * userMessage (e.g. 409 exists, 404 module_disabled).
 */
export interface RelayDns {
  /** Domains module switched on. */
  enabled(): boolean;
  /** First provider whose zones contain the name, null if none. No request. */
  providerFor(name: string): string | null;
  /** Clash with a record the hub already manages (admin or other owner), else null. */
  conflict(gameId: string, providerId: string, name: string): string | null;
  record(gameId: string): RelayDnsRecord | null;
  /** Game ids that own a relay record. */
  owners(): string[];
  ensure(input: { gameId: string; providerId: string; name: string; ip: string }): Promise<void>;
  remove(gameId: string): Promise<void>;
}

export interface RelayDeps {
  db: Db;
  now: Clock;
  hub: Pick<AgentHub, 'call' | 'isConnected'>;
  servers: { isConnected(id: string): boolean; isVirtual(id: string): boolean };
  games: GameService;
  log: FastifyBaseLogger;
  /** Domains module; null until wired (setDns) or without DNS. */
  dns?: RelayDns | null;
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

export class RelayService implements GameRelayHooks {
  /** JSON of the routes the ingress agent accepted last (cleared on hello / offline). */
  private readonly lastSent = new Map<string, string>();
  private readonly chains = new Map<string, Promise<void>>();
  private dnsChain: Promise<void> = Promise.resolve();
  private dns: RelayDns | null;
  /** Last ensure failure per game (German, no secret), cleared on success. */
  private readonly dnsErrors = new Map<string, string>();
  private readonly background = new Set<Promise<unknown>>();
  private queued = false;
  private stopped = false;

  constructor(private readonly deps: RelayDeps) {
    this.dns = deps.dns ?? null;
  }

  /** The domains module is created after the relay (features.ts): wired here. */
  setDns(dns: RelayDns | null): void {
    this.dns = dns;
  }

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
    const dns = this.dnsStatus(r, ip);
    return {
      ingressServerId: r.ingressServerId,
      ingressName: server?.name ?? r.ingressServerId,
      dnsName: r.dnsName,
      address: host === null ? null : port === undefined ? host : `${host}:${port}`,
      state: r.state === 'ok' || r.state === 'error' ? r.state : 'pending',
      error: r.error,
      dnsOk: dns.ok,
      dnsError: dns.error,
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
      if (prev.dnsName !== null) await this.removeDns(gameId);
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
    if (dnsName !== null && this.dns?.enabled()) {
      // A record the hub already manages under this name (admin or leftover): refuse
      // up front. A name that exists only at the provider shows up in dnsError.
      const providerId = this.dns.providerFor(dnsName);
      const clash = providerId === null ? null : this.dns.conflict(gameId, providerId, dnsName);
      if (clash !== null) throw new HttpError(409, 'conflict', undefined, clash);
    }
    const values = {
      listenPortsJson: JSON.stringify(pub.map((p) => ({ name: p.name, port: p.port }))),
      ingressServerId: ingressId,
      dnsName,
      dnsIp: null,
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
    if (prev && prev.dnsName !== dnsName) this.dnsErrors.delete(gameId);
    if (dnsName !== null) await this.applyDns(gameId);
    else if (prev !== undefined && prev.dnsName !== null) await this.removeDns(gameId);
    this.deps.games.touch(gameId);
    return this.relayOf(gameId);
  }

  // ---- DNS (domains module) -----------------------------------------------------------

  /** dnsOk / dnsError of the relay view. */
  private dnsStatus(
    r: GameRelayRow,
    ip: string | null,
  ): { ok: boolean | null; error: string | null } {
    const name = r.dnsName;
    if (name === null) return { ok: null, error: null };
    const dns = this.dns;
    if (!dns?.enabled()) return { ok: false, error: DNS_TEXT.moduleOff };
    const providerId = dns.providerFor(name);
    if (providerId === null) return { ok: false, error: DNS_TEXT.noProvider };
    if (ip === null) return { ok: false, error: DNS_TEXT.noIp };
    const rec = dns.record(r.gameId);
    const mine = rec !== null && rec.providerId === providerId && rec.name === name;
    if (mine && rec.status === 'ok' && rec.value === ip) return { ok: true, error: null };
    const error = this.dnsErrors.get(r.gameId) ?? (mine ? rec.lastError : null) ?? DNS_TEXT.pending;
    return { ok: false, error: error.slice(0, 200) };
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

  /** Serialises every DNS change (one at a time, in order). */
  private dnsQueue(fn: () => Promise<void>): Promise<void> {
    const run = this.dnsChain.then(fn);
    this.dnsChain = run.catch((err: unknown) => {
      this.deps.log.error(
        { err: err instanceof Error ? { name: err.name, stack: err.stack } : 'error' },
        'relay dns failed',
      );
    });
    return this.dnsChain;
  }

  private dnsFailure(gameId: string, name: string, err: unknown): void {
    const text = (
      err instanceof HttpError && err.userMessage !== undefined ? err.userMessage : DNS_TEXT.failed
    ).slice(0, 200);
    const prev = this.dnsErrors.get(gameId);
    this.dnsErrors.set(gameId, text);
    if (prev === text) return; // periodic retries: report a reason once
    this.deps.log.warn({ gameId, name, error: text }, 'dns update failed');
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'system',
      action: 'relay.dns_failed',
      target: gameId,
      details: { name, error: text },
    });
    this.deps.games.touch(gameId);
  }

  /**
   * A game gave up its DNS name (or its relay): the domains module deletes its
   * record, also at the provider. While the module is off the record stays and
   * syncDns removes it later. Failures are reported, not thrown.
   */
  removeDns(gameId: string): Promise<void> {
    this.dnsErrors.delete(gameId);
    return this.dnsQueue(async () => {
      const dns = this.dns;
      if (!dns?.enabled() || dns.record(gameId) === null) return;
      try {
        await dns.remove(gameId);
        writeAudit(this.deps.db, this.deps.now(), {
          actor: 'system',
          action: 'relay.dns_deleted',
          target: gameId,
          details: {},
        });
      } catch (err) {
        const text =
          err instanceof HttpError && err.userMessage !== undefined
            ? err.userMessage.slice(0, 200)
            : 'DNS-Eintrag konnte nicht gelöscht werden';
        this.deps.log.warn({ gameId, error: text }, 'dns delete failed');
        writeAudit(this.deps.db, this.deps.now(), {
          actor: 'system',
          action: 'relay.dns_failed',
          target: gameId,
          details: { error: text },
        });
      }
    });
  }

  /** Points the game's DNS name to its ingress (no-op while the record already does). */
  applyDns(gameId: string): Promise<void> {
    return this.dnsQueue(() => this.runDns(gameId));
  }

  private async runDns(gameId: string): Promise<void> {
    const dns = this.dns;
    if (this.stopped || !dns?.enabled()) return;
    const r = this.relayRow(gameId);
    if (!r?.dnsName) return;
    const name = r.dnsName;
    const providerId = dns.providerFor(name);
    if (providerId === null) {
      // No provider (any more) for this name: an old record of the game goes.
      this.dnsErrors.delete(gameId);
      if (dns.record(gameId) !== null) await dns.remove(gameId).catch(() => undefined);
      return;
    }
    const ip = this.publicIpOf(
      this.ingressRow(r.ingressServerId),
      this.serverRow(r.ingressServerId),
    );
    if (ip === null) return;
    const rec = dns.record(gameId);
    const current =
      rec !== null && rec.providerId === providerId && rec.name === name && rec.target === ip;
    if (current && !this.dnsErrors.has(gameId)) return;
    try {
      await dns.ensure({ gameId, providerId, name, ip });
    } catch (err) {
      this.dnsFailure(gameId, name, err);
      return;
    }
    this.dnsErrors.delete(gameId);
    writeAudit(this.deps.db, this.deps.now(), {
      actor: 'system',
      action: 'relay.dns_updated',
      target: gameId,
      details: { name, ip },
    });
    this.deps.games.touch(gameId);
  }

  /**
   * Brings all relay records in line (job relay.dns every minute, and when the
   * domains module is switched on): records of games without a DNS name (or
   * without relay) go, named relays whose record is missing or points elsewhere
   * are ensured. Nothing happens while the module is off.
   */
  async syncDns(): Promise<void> {
    const dns = this.dns;
    if (this.stopped || !dns?.enabled()) return;
    const named = this.deps.db
      .select({ gameId: gameRelays.gameId, dnsName: gameRelays.dnsName })
      .from(gameRelays)
      .all()
      .filter((r) => r.dnsName !== null)
      .map((r) => r.gameId);
    const keep = new Set(named);
    for (const id of this.dnsErrors.keys()) if (!keep.has(id)) this.dnsErrors.delete(id);
    for (const owner of dns.owners()) if (!keep.has(owner)) await this.removeDns(owner);
    for (const gameId of named) await this.applyDns(gameId);
  }

  /** syncDns in the background (module switched on). */
  queueDns(): void {
    this.track(this.syncDns());
  }
}

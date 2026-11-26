import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import {
  RELAY_MAX_ROUTES,
  relaySetDataSchema,
  tailnetIpSchema,
  type RelayRoute,
  type RelaySetData,
  type RpcParams,
} from '@hz/shared';
import type { Logger } from '../log.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * M15 game relay (relay.set). On an ingress server the agent listens on the
 * public game ports and forwards byte for byte into the tailnet, to the server
 * the game runs on:
 * - TCP: one upstream connection per client, piped both ways (backpressure via
 *   stream.pipe), half-close passed through, 10 min idle timeout.
 * - UDP: one session per client address with its own connected upstream socket,
 *   2 min idle; datagrams above 64 KiB are dropped.
 * - At most 256 connections (TCP) or sessions (UDP) per route and 16 per client
 *   IP; a full UDP route evicts its oldest session for a new client.
 * - A route whose target is this server itself on one of its own relay ports
 *   (a forwarding loop) is refused.
 * Nothing of the payload and no client address is ever logged.
 */

export const RELAY_MAX_CONNECTIONS = 256;
export const RELAY_TCP_IDLE_MS = 10 * 60_000;
export const RELAY_UDP_IDLE_MS = 2 * 60_000;
export const RELAY_MAX_DATAGRAM = 64 * 1024;
/** Connections (TCP) or sessions (UDP) per client IP and route. */
export const RELAY_MAX_PER_IP = 16;
/** Upstream TCP connect timeout. */
export const RELAY_CONNECT_TIMEOUT_MS = 10_000;
/** Datagrams queued per UDP session while its upstream socket connects. */
const UDP_PENDING_MAX = 32;
/** After one side of a TCP pair closed, the other gets this long to flush. */
const CLOSE_GRACE_MS = 5_000;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

type Protocol = RelayRoute['protocol'];

export interface RelayManagerOptions {
  log: Logger;
  /** Bind address; production binds all interfaces, tests 127.0.0.1. */
  host?: string;
  /** Ports held by the agent's own wake listeners (WakeManager.holds). */
  wakeHolds?: (port: number, protocol: Protocol) => boolean;
  /**
   * Only for tests: accept a target outside the tailnet (e.g. 127.0.0.1).
   * Default (undefined) is strict: tailnetIpSchema and net.isIP.
   */
  allowTarget?: ((host: string) => boolean) | undefined;
  tcpIdleMs?: number;
  udpIdleMs?: number;
  maxConnections?: number;
  maxPerIp?: number;
  /** Addresses of this server (loop check); default: all interface addresses. */
  localAddresses?: () => readonly string[];
}

/** Canonical text form of an IP (IPv6 compressed, lower case); null if no IP. */
export function canonicalIp(ip: string): string | null {
  const v = net.isIP(ip);
  if (v === 4) return ip;
  if (v !== 6) return null;
  try {
    return new URL(`http://[${ip}]/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function interfaceAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((list) =>
    (list ?? []).map((a) => a.address),
  );
}

/** A usable UDP peer: literal IP and a port that dgram.send accepts. */
export function validPeer(rinfo: { address: string; port: number }): boolean {
  return (
    net.isIP(rinfo.address) !== 0 &&
    Number.isInteger(rinfo.port) &&
    rinfo.port >= 1 &&
    rinfo.port <= 65535
  );
}

/** dgram send that never throws (bad port/address throws synchronously). */
export function safeSend(sock: dgram.Socket, data: Buffer, port?: number, address?: string): void {
  try {
    if (port === undefined || address === undefined) sock.send(data, () => undefined);
    else sock.send(data, port, address, () => undefined);
  } catch {
    // socket closed or bad peer: drop the datagram
  }
}

/** True for a literal Tailscale IP (100.64.0.0/10, fd7a:115c:a1e0::/48). */
export function isTailnetTarget(host: string): boolean {
  return net.isIP(host) !== 0 && tailnetIpSchema.safeParse(host).success;
}

interface Target {
  host: string;
  port: number;
}

/** One listening route (all its ports) with its live connections. */
interface ActiveRoute {
  route: RelayRoute;
  target: Target;
  /** Live TCP connections or UDP sessions of all ports of this route. */
  live: number;
  /** Closes every connection/session (target changed), keeps the listeners. */
  dropAll(): void;
  /** Closes listeners and everything else. */
  close(): Promise<void>;
}

function sameListen(a: RelayRoute, b: RelayRoute): boolean {
  return a.protocol === b.protocol && a.listenPort === b.listenPort && a.count === b.count;
}

function sameTarget(a: Target, b: Target): boolean {
  return a.host === b.host && a.port === b.port;
}

class BindError extends Error {
  constructor(public readonly german: string) {
    super(german);
    this.name = 'BindError';
  }
}

function bindError(err: unknown, port: number, protocol: Protocol): BindError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') return new BindError(`Port ${port}/${protocol} ist belegt`);
  if (code === 'EACCES') return new BindError(`Port ${port}/${protocol}: keine Berechtigung`);
  return new BindError(`Port ${port}/${protocol} konnte nicht geöffnet werden`);
}

export class RelayManager {
  private readonly routes = new Map<string, ActiveRoute>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly o: RelayManagerOptions) {}

  private get maxConnections(): number {
    return this.o.maxConnections ?? RELAY_MAX_CONNECTIONS;
  }

  /** Route ids that listen now (tests, diagnostics). */
  active(): string[] {
    return [...this.routes.keys()];
  }

  /** True when a relay route listens on this port (wake listeners must not take it). */
  holds(port: number, protocol: Protocol): boolean {
    for (const a of this.routes.values()) {
      const r = a.route;
      if (r.protocol === protocol && port >= r.listenPort && port < r.listenPort + r.count) {
        return true;
      }
    }
    return false;
  }

  private get maxPerIp(): number {
    return this.o.maxPerIp ?? RELAY_MAX_PER_IP;
  }

  /** Live connections/sessions of a route (tests). */
  liveCount(id: string): number {
    return this.routes.get(id)?.live ?? 0;
  }

  private targetAllowed(host: string): boolean {
    return this.o.allowTarget ? this.o.allowTarget(host) : isTailnetTarget(host);
  }

  /** Throws invalid_params for a list that must not be applied at all. */
  private validate(routes: readonly RelayRoute[]): void {
    if (routes.length > RELAY_MAX_ROUTES) {
      throw new ActionError('invalid_params', 'too many relay routes');
    }
    const ids = new Set<string>();
    for (const r of routes) {
      if (ids.has(r.id)) throw new ActionError('invalid_params', 'route id listed twice');
      ids.add(r.id);
      const ints = [r.listenPort, r.count, r.target.port];
      if (!ints.every((n) => Number.isInteger(n)) || r.count < 1 || r.count > 10) {
        throw new ActionError('invalid_params', 'invalid route');
      }
      if (r.listenPort < MIN_PORT || r.listenPort + r.count - 1 > MAX_PORT) {
        throw new ActionError('invalid_params', 'listen ports must be 1024-65535');
      }
      if (r.target.port < MIN_PORT || r.target.port + r.count - 1 > MAX_PORT) {
        throw new ActionError('invalid_params', 'target ports must be 1024-65535');
      }
      if (!this.targetAllowed(r.target.host)) {
        throw new ActionError('invalid_params', 'relay target must be a tailnet address');
      }
    }
    const local = new Set(
      (this.o.localAddresses ?? interfaceAddresses)()
        .map(canonicalIp)
        .filter((x): x is string => x !== null),
    );
    for (const r of routes) {
      const host = canonicalIp(r.target.host);
      if (host === null || !local.has(host)) continue;
      const from = r.target.port;
      const to = r.target.port + r.count - 1;
      const loop = routes.some(
        (o) =>
          o.protocol === r.protocol && from <= o.listenPort + o.count - 1 && o.listenPort <= to,
      );
      if (loop) throw new ActionError('invalid_params', 'relay route points back to the relay');
    }
    routes.forEach((a, i) => {
      for (const b of routes.slice(i + 1)) {
        if (a.protocol !== b.protocol) continue;
        const overlap =
          a.listenPort <= b.listenPort + b.count - 1 && b.listenPort <= a.listenPort + a.count - 1;
        if (overlap) throw new ActionError('invalid_params', 'relay routes overlap');
      }
    });
  }

  /** Replaces all routes (relay.set). Calls are serialized. */
  set(routes: readonly RelayRoute[]): Promise<RelaySetData> {
    const run = this.queue.catch(() => undefined).then(() => this.apply(routes));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async apply(routes: readonly RelayRoute[]): Promise<RelaySetData> {
    if (this.closed) throw new ActionError('failed', 'relay is shutting down', false);
    this.validate(routes);
    const wanted = new Map(routes.map((r) => [r.id, r]));

    // Removed routes and routes whose ports changed go first, so a new route may
    // take over their ports.
    const closing: Promise<void>[] = [];
    for (const [id, active] of this.routes) {
      const next = wanted.get(id);
      if (!next || !sameListen(active.route, next)) {
        this.routes.delete(id);
        closing.push(active.close());
      }
    }
    await Promise.all(closing);

    const results: RelaySetData['routes'] = [];
    let opened = 0;
    for (const r of routes) {
      const target = { host: r.target.host, port: r.target.port };
      const existing = this.routes.get(r.id);
      if (existing) {
        // Same ports: listeners stay. A new target (game moved) drops the old
        // connections; an unchanged route keeps them.
        if (!sameTarget(existing.target, target)) {
          existing.target = target;
          existing.dropAll();
        }
        existing.route = r;
        results.push({ id: r.id, ok: true, error: null });
        continue;
      }
      try {
        const active = await this.open(r, target);
        this.routes.set(r.id, active);
        opened += 1;
        results.push({ id: r.id, ok: true, error: null });
      } catch (err) {
        const text = err instanceof BindError ? err.german : `Route konnte nicht geöffnet werden`;
        results.push({ id: r.id, ok: false, error: text });
        this.o.log.warn('relay route failed', { route: r.id, protocol: r.protocol });
      }
    }
    this.o.log.info('relay routes set', {
      routes: routes.length,
      opened,
      closed: closing.length,
      failed: results.filter((x) => !x.ok).length,
    });
    return relaySetDataSchema.parse({ routes: results });
  }

  /** Closes every route (agent shutdown). Later relay.set calls fail. */
  async closeAll(): Promise<void> {
    this.closed = true;
    await this.queue.catch(() => undefined);
    const all = [...this.routes.values()];
    this.routes.clear();
    await Promise.all(all.map((r) => r.close()));
  }

  private async open(route: RelayRoute, target: Target): Promise<ActiveRoute> {
    for (let i = 0; i < route.count; i++) {
      const port = route.listenPort + i;
      if (this.o.wakeHolds?.(port, route.protocol)) {
        throw new BindError(`Port ${port}/${route.protocol} ist vom Schlafmodus belegt`);
      }
    }
    return route.protocol === 'tcp' ? this.openTcp(route, target) : this.openUdp(route, target);
  }

  // -------------------------------------------------------------------------
  // TCP

  private async openTcp(route: RelayRoute, target: Target): Promise<ActiveRoute> {
    const servers: net.Server[] = [];
    const conns = new Set<net.Socket>();
    const idleMs = this.o.tcpIdleMs ?? RELAY_TCP_IDLE_MS;
    const max = this.maxConnections;

    const active: ActiveRoute = {
      route,
      target,
      live: 0,
      dropAll: () => {
        for (const s of conns) s.destroy();
      },
      close: async () => {
        // server.close() waits for open connections, so cut them right after.
        const closing = servers.map((srv) => new Promise<void>((done) => srv.close(() => done())));
        active.dropAll();
        await Promise.all(closing);
      },
    };

    const perIp = new Map<string, number>();
    const maxPerIp = this.maxPerIp;
    const onClient = (client: net.Socket, offset: number): void => {
      const ip = client.remoteAddress;
      if (active.live >= max || ip === undefined || (perIp.get(ip) ?? 0) >= maxPerIp) {
        client.destroy();
        return;
      }
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      const t = active.target;
      const upstream = net.connect({
        host: t.host,
        port: t.port + offset,
        allowHalfOpen: true,
      });
      conns.add(client);
      conns.add(upstream);
      active.live += 1;
      let counted = true;
      const release = (): void => {
        if (!counted) return;
        counted = false;
        clearTimeout(connectTimer);
        conns.delete(client);
        conns.delete(upstream);
        active.live -= 1;
        const left = (perIp.get(ip) ?? 1) - 1;
        if (left > 0) perIp.set(ip, left);
        else perIp.delete(ip);
      };
      const kill = (): void => {
        client.destroy();
        upstream.destroy();
        release();
      };
      const connectTimer = setTimeout(kill, RELAY_CONNECT_TIMEOUT_MS);
      connectTimer.unref();
      upstream.once('connect', () => clearTimeout(connectTimer));
      const pair: [net.Socket, net.Socket][] = [
        [client, upstream],
        [upstream, client],
      ];
      for (const [s, other] of pair) {
        s.setNoDelay(true);
        s.setTimeout(idleMs, kill);
        s.on('error', kill);
        s.on('close', () => {
          if (other.destroyed) {
            release();
            return;
          }
          // The other side may still flush what this one sent; end it and give
          // it a moment instead of holding a slot until the idle timeout.
          other.end();
          setTimeout(() => other.destroy(), CLOSE_GRACE_MS).unref();
        });
      }
      // pipe: backpressure both ways; end() passes a half-close on.
      client.pipe(upstream);
      upstream.pipe(client);
    };

    try {
      for (let i = 0; i < route.count; i++) {
        const port = route.listenPort + i;
        const srv = net.createServer({ allowHalfOpen: true }, (s) => onClient(s, i));
        await new Promise<void>((resolve, reject) => {
          srv.once('error', (err) => reject(bindError(err, port, 'tcp')));
          srv.listen({ port, host: this.o.host ?? '0.0.0.0', exclusive: true }, () => {
            srv.removeAllListeners('error');
            srv.on('error', () => undefined);
            resolve();
          });
        });
        servers.push(srv);
      }
    } catch (err) {
      await active.close();
      throw err;
    }
    return active;
  }

  // -------------------------------------------------------------------------
  // UDP

  private async openUdp(route: RelayRoute, target: Target): Promise<ActiveRoute> {
    const host = this.o.host ?? '0.0.0.0';
    const idleMs = this.o.udpIdleMs ?? RELAY_UDP_IDLE_MS;
    const max = this.maxConnections;
    const listeners: dgram.Socket[] = [];

    interface Session {
      upstream: dgram.Socket;
      timer: NodeJS.Timeout;
      connected: boolean;
      pending: Buffer[];
      closed: boolean;
      ip: string;
    }
    /** Insertion order = age: the first entry is the oldest session. */
    const sessions = new Map<string, Session>();
    const perIp = new Map<string, number>();
    const maxPerIp = this.maxPerIp;

    const endSession = (key: string, s: Session): void => {
      if (s.closed) return;
      s.closed = true;
      clearTimeout(s.timer);
      s.pending = [];
      if (sessions.get(key) === s) sessions.delete(key);
      active.live = sessions.size;
      const left = (perIp.get(s.ip) ?? 1) - 1;
      if (left > 0) perIp.set(s.ip, left);
      else perIp.delete(s.ip);
      try {
        s.upstream.close();
      } catch {
        // already closed
      }
    };

    const active: ActiveRoute = {
      route,
      target,
      live: 0,
      dropAll: () => {
        for (const [key, s] of [...sessions]) endSession(key, s);
      },
      close: async () => {
        active.dropAll();
        await Promise.all(
          listeners.map(
            (l) =>
              new Promise<void>((done) => {
                try {
                  l.close(() => done());
                } catch {
                  done();
                }
              }),
          ),
        );
      },
    };

    const onMessage = (
      listener: dgram.Socket,
      offset: number,
      msg: Buffer,
      rinfo: dgram.RemoteInfo,
    ): void => {
      // Port 0 or a bad address would make dgram.send throw synchronously.
      if (msg.length > RELAY_MAX_DATAGRAM || !validPeer(rinfo)) return;
      const peerPort = rinfo.port;
      const peerAddress = rinfo.address;
      const key = `${offset}|${peerAddress}|${peerPort}`;
      let s = sessions.get(key);
      if (!s) {
        if ((perIp.get(peerAddress) ?? 0) >= maxPerIp) return;
        if (sessions.size >= max) {
          const oldest = sessions.entries().next().value;
          if (oldest) endSession(oldest[0], oldest[1]);
        }
        const t = active.target;
        const upstream = dgram.createSocket(net.isIPv6(t.host) ? 'udp6' : 'udp4');
        const created: Session = {
          upstream,
          timer: setTimeout(() => endSession(key, created), idleMs),
          connected: false,
          pending: [],
          closed: false,
          ip: peerAddress,
        };
        created.timer.unref();
        s = created;
        sessions.set(key, s);
        perIp.set(peerAddress, (perIp.get(peerAddress) ?? 0) + 1);
        active.live = sessions.size;
        upstream.on('error', () => endSession(key, created));
        upstream.on('message', (reply) => {
          if (created.closed || reply.length > RELAY_MAX_DATAGRAM) return;
          created.timer.refresh();
          safeSend(listener, reply, peerPort, peerAddress);
        });
        // connect(): the kernel only delivers datagrams from the target.
        try {
          upstream.connect(t.port + offset, t.host, () => {
            if (created.closed) return;
            created.connected = true;
            for (const p of created.pending.splice(0)) safeSend(upstream, p);
          });
        } catch {
          endSession(key, created);
          return;
        }
      }
      s.timer.refresh();
      if (s.connected) {
        safeSend(s.upstream, msg);
      } else if (s.pending.length < UDP_PENDING_MAX) {
        s.pending.push(msg);
      }
    };

    try {
      for (let i = 0; i < route.count; i++) {
        const port = route.listenPort + i;
        const sock = dgram.createSocket({
          type: net.isIPv6(host) ? 'udp6' : 'udp4',
          reuseAddr: false,
        });
        sock.on('message', (msg, rinfo) => {
          try {
            onMessage(sock, i, msg, rinfo);
          } catch {
            // Defense in depth: one bad datagram never takes the agent down.
          }
        });
        await new Promise<void>((resolve, reject) => {
          sock.once('error', (err) => {
            try {
              sock.close();
            } catch {
              // not bound
            }
            reject(bindError(err, port, 'udp'));
          });
          sock.bind({ port, address: host, exclusive: true }, () => {
            sock.removeAllListeners('error');
            sock.on('error', () => undefined);
            resolve();
          });
        });
        listeners.push(sock);
      }
    } catch (err) {
      await active.close();
      throw err;
    }
    return active;
  }
}

// ---------------------------------------------------------------------------
// Action

export async function relaySet(
  params: RpcParams<'relay.set'>,
  ctx: ActionContext,
): Promise<RelaySetData> {
  if (!ctx.relay) throw new ActionError('not_allowed', 'relay is disabled on this server');
  return ctx.relay.set(params.routes);
}

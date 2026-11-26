import { and, eq } from 'drizzle-orm';
import {
  MAX_ALLOWED_PORTS,
  newPortAlertBody,
  newPortAlertTitle,
  parsePortAlertKey,
  portAlertKey,
  publicListeningPorts,
  type AllowedPort,
  type ListeningPort,
  type PortAuditProto,
  type PortAuditResponse,
} from '@hz/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import { alerts, serverAllowedPorts, serverPortAudit, servers, serverState } from '../db/schema.js';

/**
 * Port audit (ROADMAP M11, contract in @hz/shared ports.ts): a list of allowed
 * public ports per server, seeded from the first inventory; every public port
 * outside the list is a `warn` alert with key portAlertKey(...).
 */
export class PortAuditService {
  constructor(
    private readonly deps: {
      db: Db;
      now: Clock;
      alerts: AlertService;
      log: FastifyBaseLogger;
    },
  ) {}

  seeded(serverId: string): boolean {
    return (
      this.deps.db
        .select({ id: serverPortAudit.serverId })
        .from(serverPortAudit)
        .where(eq(serverPortAudit.serverId, serverId))
        .get() !== undefined
    );
  }

  allowed(serverId: string): AllowedPort[] {
    return this.deps.db
      .select()
      .from(serverAllowedPorts)
      .where(eq(serverAllowedPorts.serverId, serverId))
      .all()
      .map((r) => ({
        port: r.port,
        proto: r.proto as PortAuditProto,
        ...(r.note !== null && r.note !== '' ? { note: r.note } : {}),
      }))
      .sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
  }

  private lastPorts(serverId: string): ListeningPort[] | null {
    const st = this.deps.db
      .select({ json: serverState.listeningPortsJson })
      .from(serverState)
      .where(eq(serverState.serverId, serverId))
      .get();
    if (!st?.json) return null;
    try {
      return JSON.parse(st.json) as ListeningPort[];
    } catch {
      return null;
    }
  }

  private markSeeded(tx: Pick<Db, 'insert'>, serverId: string, now: number): void {
    tx.insert(serverPortAudit).values({ serverId, seededAt: now }).onConflictDoNothing().run();
  }

  /**
   * Called after every stored inventory. An empty port list means the agent
   * could not read it (every host listens on something): no seeding, no change.
   */
  onInventory(serverId: string, ports: readonly ListeningPort[]): void {
    if (ports.length === 0) return;
    const now = this.deps.now();
    if (!this.seeded(serverId)) {
      const open = publicListeningPorts(ports).slice(0, MAX_ALLOWED_PORTS);
      this.deps.db.transaction((tx) => {
        for (const p of open) {
          tx.insert(serverAllowedPorts)
            .values({ serverId, proto: p.proto, port: p.port, note: null, createdAt: now })
            .onConflictDoNothing()
            .run();
        }
        this.markSeeded(tx, serverId, now);
      });
      this.deps.log.info({ serverId, ports: open.length }, 'port list seeded');
      this.reconcile(serverId, ports);
      return;
    }
    this.reconcile(serverId, ports);
  }

  /**
   * Raises an alert for every public port outside the list and resolves the
   * port alerts of this server whose port is allowed or no longer listening.
   */
  private reconcile(serverId: string, ports: readonly ListeningPort[] | null): void {
    const server = this.deps.db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, serverId))
      .get();
    if (!server) return;
    const open = publicListeningPorts(ports ?? [], this.allowed(serverId));
    const unknown = new Set<string>();
    for (const p of open) {
      if (p.allowed) continue;
      const key = portAlertKey(serverId, p.proto, p.port);
      unknown.add(key);
      this.deps.alerts.raise(
        key,
        'warn',
        newPortAlertTitle(p.port, p.proto, p.process),
        newPortAlertBody(server.name, p),
        serverId,
        'server',
      );
    }
    for (const key of this.activeKeys(serverId)) {
      if (!unknown.has(key)) this.deps.alerts.resolve(key);
    }
  }

  private activeKeys(serverId: string): string[] {
    return this.deps.db
      .select({ key: alerts.key, state: alerts.state })
      .from(alerts)
      .where(eq(alerts.serverId, serverId))
      .all()
      .filter((a) => a.state !== 'resolved' && parsePortAlertKey(a.key)?.serverId === serverId)
      .map((a) => a.key);
  }

  get(serverId: string): PortAuditResponse {
    const allowed = this.allowed(serverId);
    return {
      seeded: this.seeded(serverId),
      allowed,
      open: publicListeningPorts(this.lastPorts(serverId) ?? [], allowed),
    };
  }

  /** Replaces the list (PUT). Counts as seeding. */
  replace(serverId: string, list: readonly AllowedPort[]): PortAuditResponse {
    const now = this.deps.now();
    this.deps.db.transaction((tx) => {
      tx.delete(serverAllowedPorts).where(eq(serverAllowedPorts.serverId, serverId)).run();
      for (const p of list) {
        tx.insert(serverAllowedPorts)
          .values({ serverId, proto: p.proto, port: p.port, note: p.note ?? null, createdAt: now })
          .run();
      }
      this.markSeeded(tx, serverId, now);
    });
    this.reconcile(serverId, this.lastPorts(serverId));
    return this.get(serverId);
  }

  /**
   * Adds one entry (idempotent; a new note replaces the old) and resolves its
   * alert. 'full' when the list already has MAX_ALLOWED_PORTS other entries.
   */
  allow(serverId: string, p: AllowedPort): PortAuditResponse | 'full' {
    const now = this.deps.now();
    const where = and(
      eq(serverAllowedPorts.serverId, serverId),
      eq(serverAllowedPorts.proto, p.proto),
      eq(serverAllowedPorts.port, p.port),
    );
    const exists = this.deps.db.select().from(serverAllowedPorts).where(where).get();
    if (!exists && this.allowed(serverId).length >= MAX_ALLOWED_PORTS) return 'full';
    this.deps.db.transaction((tx) => {
      if (exists) {
        if (p.note !== undefined)
          tx.update(serverAllowedPorts).set({ note: p.note }).where(where).run();
      } else {
        tx.insert(serverAllowedPorts)
          .values({ serverId, proto: p.proto, port: p.port, note: p.note ?? null, createdAt: now })
          .run();
      }
      this.markSeeded(tx, serverId, now);
    });
    // The admin allowed it: close the alert without an OK entry.
    const active = this.deps.alerts.active(portAlertKey(serverId, p.proto, p.port));
    if (active) this.deps.alerts.resolveById(active.id);
    this.reconcile(serverId, this.lastPorts(serverId));
    return this.get(serverId);
  }
}

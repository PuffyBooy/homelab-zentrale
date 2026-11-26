import { and, eq, like, ne } from 'drizzle-orm';
import {
  parseStorageAlertKey,
  storageAlertPrefix,
  storageInfoSchema,
  storageProblems,
  type StorageInfo,
  type StorageServer,
} from '@hz/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import { alerts, servers, serverStorage } from '../db/schema.js';

/**
 * NAS und Speicher (ROADMAP M13, contract in @hz/shared api/storage.ts).
 * Keeps the latest inventory.storage per server and turns storageProblems(...)
 * into alerts (key storageAlertKey(...), source server). A problem that is gone
 * resolves its alert with an OK entry. Module `storage` off: nothing is stored
 * or raised, open storage alerts are resolved.
 */
export class StorageService {
  private enabled = true;

  constructor(
    private readonly deps: {
      db: Db;
      now: Clock;
      alerts: AlertService;
      log: FastifyBaseLogger;
    },
  ) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.deps.alerts.resolveAllWithPrefix('storage:');
    else for (const s of this.list()) this.reconcile(s.serverId, s.name, s.storage);
  }

  /** Called after every stored inventory. Older agents send no storage: nothing changes. */
  onInventory(serverId: string, storage: StorageInfo | undefined): void {
    if (!this.enabled || storage === undefined) return;
    // The hub already validated the message; parse again so only known fields are stored.
    const parsed = storageInfoSchema.parse(storage);
    const now = this.deps.now();
    const json = JSON.stringify(parsed);
    this.deps.db
      .insert(serverStorage)
      .values({ serverId, storageJson: json, updatedAt: now })
      .onConflictDoUpdate({
        target: serverStorage.serverId,
        set: { storageJson: json, updatedAt: now },
      })
      .run();
    const server = this.deps.db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, serverId))
      .get();
    if (server) this.reconcile(serverId, server.name, parsed);
  }

  private reconcile(serverId: string, name: string, storage: StorageInfo): void {
    const problems = storageProblems(serverId, name, storage);
    const keys = new Set<string>();
    for (const p of problems) {
      keys.add(p.key);
      this.deps.alerts.raise(p.key, p.level, p.title, p.body, serverId, 'server');
    }
    for (const key of this.activeKeys(serverId)) {
      if (keys.has(key)) continue;
      const parsed = parseStorageAlertKey(key);
      this.deps.alerts.resolve(key, {
        title: `Speicher auf ${name} wieder in Ordnung`,
        body: parsed ? `${okText(parsed.kind)} (${parsed.device}).` : 'Das Problem ist behoben.',
      });
    }
  }

  private activeKeys(serverId: string): string[] {
    const prefix = storageAlertPrefix(serverId);
    return (
      this.deps.db
        .select({ key: alerts.key })
        .from(alerts)
        .where(
          and(
            eq(alerts.serverId, serverId),
            ne(alerts.state, 'resolved'),
            like(alerts.key, `${prefix}%`),
          ),
        )
        .all()
        // `_` in a server id is a LIKE wildcard: the exact check stays.
        .filter((a) => parseStorageAlertKey(a.key)?.serverId === serverId)
        .map((a) => a.key)
    );
  }

  private toServer(row: {
    serverId: string;
    name: string;
    storageJson: string;
    updatedAt: number;
  }): StorageServer | null {
    let storage: StorageInfo;
    try {
      const p = storageInfoSchema.safeParse(JSON.parse(row.storageJson));
      if (!p.success) return null;
      storage = p.data;
    } catch {
      return null;
    }
    return {
      serverId: row.serverId,
      name: row.name,
      updatedAt: row.updatedAt,
      storage,
      problems: storageProblems(row.serverId, row.name, storage),
    };
  }

  private rows() {
    return this.deps.db
      .select({
        serverId: serverStorage.serverId,
        name: servers.name,
        storageJson: serverStorage.storageJson,
        updatedAt: serverStorage.updatedAt,
      })
      .from(serverStorage)
      .innerJoin(servers, eq(servers.id, serverStorage.serverId));
  }

  list(): StorageServer[] {
    return this.rows()
      .all()
      .map((r) => this.toServer(r))
      .filter((s): s is StorageServer => s !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(serverId: string): StorageServer | null {
    const row = this.rows().where(eq(serverStorage.serverId, serverId)).get();
    return row ? this.toServer(row) : null;
  }
}

function okText(kind: string): string {
  switch (kind) {
    case 'raid':
      return 'Das RAID ist wieder vollständig';
    case 'smart':
      return 'SMART meldet keinen Ausfall mehr';
    case 'sectors':
      return 'Keine defekten Sektoren mehr gemeldet';
    default:
      return 'Die Temperatur ist wieder normal';
  }
}

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ImageVersion } from '@hz/shared';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import { servers, updateRuns } from '../db/schema.js';
import type { UpdateService } from '../updates/service.js';

/**
 * Demo data for M17 (HZ_DEMO=1 only): versions per demo server, the home server
 * as core host and a few runs, so the "Auto-Update" tile and the settings
 * section have something to show. Demo servers have no agent, so "Jetzt
 * prüfen" / "Jetzt aktualisieren" answer agent_offline.
 */

const HOUR = 3_600_000;

function version(tag: string, created: number): ImageVersion {
  const hex = createHash('sha256').update(tag).digest('hex');
  return {
    imageId: `sha256:${hex}`,
    revision: hex.slice(0, 40),
    version: tag,
    created: new Date(created).toISOString(),
  };
}

export function seedDemoUpdates(deps: {
  db: Db;
  now: Clock;
  updates: UpdateService;
  serverIds: readonly string[];
}): void {
  const { db, updates } = deps;
  const t0 = deps.now();
  const checkedAt = new Date(t0 - 2 * HOUR).toISOString();
  const oldAgent = version('sha-1a2b3c4', t0 - 9 * 24 * HOUR);
  const newAgent = version('sha-5d6e7f8', t0 - 30 * HOUR);
  const [heim, oracle, raspi] = deps.serverIds;
  if (heim) {
    updates.markDemoCoreHost(heim);
    updates.seedComponent(heim, 'agent', {
      current: newAgent,
      available: null,
      upToDate: true,
      checkedAt,
    });
    updates.seedComponent(heim, 'core', {
      current: version('sha-5d6e7f8', t0 - 30 * HOUR),
      available: null,
      upToDate: true,
      checkedAt,
    });
  }
  if (oracle) {
    updates.seedComponent(oracle, 'agent', {
      current: oldAgent,
      available: newAgent,
      upToDate: false,
      checkedAt,
    });
  }
  if (raspi) {
    updates.seedComponent(raspi, 'agent', {
      current: newAgent,
      available: null,
      upToDate: true,
      checkedAt,
    });
  }
  const name = (id: string): string =>
    db.select({ name: servers.name }).from(servers).where(eq(servers.id, id)).get()?.name ?? '';
  const runs: {
    serverId: string | undefined;
    target: string;
    status: string;
    agoH: number;
    from: string | null;
    to: string | null;
    message: string | null;
  }[] = [
    {
      serverId: heim,
      target: 'core',
      status: 'updated',
      agoH: 26,
      from: 'sha-1a2b3c4',
      to: 'sha-5d6e7f8',
      message: null,
    },
    {
      serverId: heim,
      target: 'agent',
      status: 'updated',
      agoH: 26.2,
      from: 'sha-1a2b3c4',
      to: 'sha-5d6e7f8',
      message: null,
    },
    {
      serverId: raspi,
      target: 'os',
      status: 'updated',
      agoH: 27,
      from: null,
      to: '12 Pakete',
      message: '12 Pakete aktualisiert',
    },
    {
      serverId: raspi,
      target: 'agent',
      status: 'updated',
      agoH: 26.8,
      from: 'sha-1a2b3c4',
      to: 'sha-5d6e7f8',
      message: null,
    },
    {
      serverId: oracle,
      target: 'agent',
      status: 'rolled_back',
      agoH: 25,
      from: 'sha-1a2b3c4',
      to: 'sha-5d6e7f8',
      message: 'health check failed after 180 s',
    },
  ];
  for (const [i, r] of runs.entries()) {
    if (!r.serverId) continue;
    const id = `demo-run-${i}`;
    if (db.select({ id: updateRuns.id }).from(updateRuns).where(eq(updateRuns.id, id)).get()) {
      continue;
    }
    const startedAt = Math.round(t0 - r.agoH * HOUR);
    db.insert(updateRuns)
      .values({
        id,
        serverId: r.serverId,
        serverName: name(r.serverId),
        target: r.target,
        trigger: 'schedule',
        status: r.status,
        startedAt,
        finishedAt: startedAt + 3 * 60_000,
        fromText: r.from,
        toText: r.to,
        message: r.message,
      })
      .run();
  }
}

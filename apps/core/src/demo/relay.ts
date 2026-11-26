import { eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import { gameRelays, serverIngress, servers } from '../db/schema.js';

/** Documentation address (TEST-NET-3), never a real server. */
export const DEMO_INGRESS_IP = '203.0.113.10';

/**
 * M15 demo data (HZ_DEMO=1 only): the cloud demo server (oracle-a1) is an ingress
 * with relay capability, and the demo Minecraft game on the first demo server is
 * relayed through it with a DNS name, so the relay parts of the UI show something.
 * Demo servers have no agent: the relay service leaves this seeded state alone.
 */
export function seedDemoRelay(deps: {
  db: Db;
  now: Clock;
  serverIds: readonly string[];
  gameId: string | null;
}): void {
  const { db } = deps;
  const ingressId = deps.serverIds[1];
  if (!ingressId || deps.gameId === null) return;
  const t0 = deps.now();
  db.update(servers)
    .set({ capabilitiesJson: JSON.stringify({ terminal: false, docker: true, relay: true }) })
    .where(eq(servers.id, ingressId))
    .run();
  db.insert(serverIngress)
    .values({
      serverId: ingressId,
      enabled: true,
      publicIp: DEMO_INGRESS_IP,
      portFrom: 25565,
      portTo: 25600,
      updatedAt: t0,
    })
    .onConflictDoNothing()
    .run();
  db.insert(gameRelays)
    .values({
      gameId: deps.gameId,
      ingressServerId: ingressId,
      dnsName: 'mc.example.org',
      dnsIp: null,
      listenPortsJson: JSON.stringify([{ name: 'game', port: 25565 }]),
      state: 'ok',
      error: null,
      updatedAt: t0,
    })
    .onConflictDoNothing()
    .run();
}

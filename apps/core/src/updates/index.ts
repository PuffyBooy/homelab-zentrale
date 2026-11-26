import type { FastifyInstance } from 'fastify';
import type { AgentHub } from '../agents/hub.js';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/index.js';
import type { LiveHub } from '../live/hub.js';
import type { Scheduler } from '../scheduler.js';
import type { ServerService } from '../servers/service.js';
import { updateRoutes } from './routes.js';
import { UpdateService } from './service.js';

export { UpdateService } from './service.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** M17 update service (routes, tests). */
    hzUpdates: UpdateService;
  }
}

/** Live topic `updates`: snapshot and every update are the full UpdatesResponse. */
export const UPDATES_TOPIC = 'updates';

/**
 * M17 wiring in one place (keeps app.ts small): service, agent event, live
 * topic, the minute tick and the routes under /api.
 */
export async function setupUpdates(
  app: FastifyInstance,
  deps: {
    db: Db;
    now: Clock;
    hub: AgentHub;
    servers: ServerService;
    alerts: AlertService;
    live: LiveHub;
    scheduler: Scheduler;
  },
): Promise<UpdateService> {
  const updates = new UpdateService({
    db: deps.db,
    now: deps.now,
    hub: deps.hub,
    alerts: deps.alerts,
    isConnected: (id) => deps.servers.isConnected(id),
    log: app.log.child({ mod: 'updates' }),
  });
  deps.servers.onUpdateResult((serverId, e) => updates.onUpdateResult(serverId, e));
  deps.servers.onChange((id, deleted) => {
    if (deleted) updates.forgetServer(id);
    else deps.live.mark(UPDATES_TOPIC, UPDATES_TOPIC, 'upsert');
  });
  deps.live.addProvider({
    matches: (topic) => topic === UPDATES_TOPIC,
    snapshot: () => updates.response(),
    item: () => updates.response(),
  });
  updates.onChange(() => deps.live.mark(UPDATES_TOPIC, UPDATES_TOPIC, 'upsert'));
  deps.scheduler.every('updates.tick', 60_000, () => updates.tick(), { align: true });
  app.decorate('hzUpdates', updates);
  app.addHook('preClose', async () => {
    updates.close();
    await Promise.race([updates.idle(), new Promise((r) => setTimeout(r, 1_000).unref())]);
  });
  await app.register(updateRoutes, { prefix: '/api', db: deps.db, now: deps.now, updates });
  return updates;
}

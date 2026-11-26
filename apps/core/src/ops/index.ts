import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { AgentHub } from '../agents/hub.js';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import type { ContainerService } from '../containers/service.js';
import type { Db } from '../db/index.js';
import type { ModuleService } from '../modules/service.js';
import type { Scheduler } from '../scheduler.js';
import type { ServerService } from '../servers/service.js';
import { Fail2banService } from './fail2ban.js';
import { LogSearchService } from './logsearch.js';
import { opsRoutes } from './routes.js';
import { VulnScanService } from './vulnscan.js';

export interface OpsDeps {
  db: Db;
  now: Clock;
  hub: AgentHub;
  alerts: AlertService;
  scheduler: Scheduler;
  modules: ModuleService;
  servers: ServerService;
  containers: ContainerService;
  log: FastifyBaseLogger;
}

export interface OpsServices {
  logsearch: LogSearchService;
  vulnscan: VulnScanService;
  fail2ban: Fail2banService;
}

/**
 * Operations modules logsearch, vulnscan and fail2ban (all off by default):
 * services, routes under /api, the nightly scan job and the module switches.
 */
export async function setupOps(app: FastifyInstance, d: OpsDeps): Promise<OpsServices> {
  const logsearch = new LogSearchService({
    db: d.db,
    now: d.now,
    hub: d.hub,
    containers: d.containers,
  });
  const vulnscan = new VulnScanService({
    db: d.db,
    now: d.now,
    hub: d.hub,
    alerts: d.alerts,
    scheduler: d.scheduler,
    log: d.log.child({ mod: 'vulnscan' }),
  });
  const fail2ban = new Fail2banService({ db: d.db, now: d.now, hub: d.hub });

  vulnscan.setEnabled(d.modules.enabled('vulnscan'));
  d.modules.onChange((m, on) => {
    if (m === 'vulnscan') vulnscan.setEnabled(on);
    else if (m === 'fail2ban' && !on) fail2ban.clear();
  });
  d.servers.onChange((id, deleted) => {
    if (!deleted) return;
    vulnscan.forgetServer(id);
    fail2ban.forget(id);
  });
  d.containers.onChange((id, deleted) => {
    if (deleted) vulnscan.onContainerDeleted(id);
  });
  app.addHook('preClose', async () => {
    vulnscan.stop();
    await Promise.race([vulnscan.idle(), new Promise((r) => setTimeout(r, 3_000).unref())]);
  });

  await app.register(opsRoutes, {
    prefix: '/api',
    db: d.db,
    now: d.now,
    logsearch,
    vulnscan,
    fail2ban,
  });
  return { logsearch, vulnscan, fail2ban };
}

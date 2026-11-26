import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { AgentHub } from '../agents/hub.js';
import type { AgentTokens } from '../agents/tokens.js';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import type { SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import type { GameService } from '../games/service.js';
import type { ModuleService } from '../modules/service.js';
import type { Scheduler } from '../scheduler.js';
import type { OnboardingService } from '../servers/onboarding.js';
import type { ServerService } from '../servers/service.js';
import { AzureClient, azureEndpoints, type AzureFetch } from './azure.js';
import { cloudRoutes } from './routes.js';
import { CLOUD_TICK_MS, CloudService } from './service.js';

export interface CloudDeps {
  db: Db;
  box: SecretBox;
  now: Clock;
  log: FastifyBaseLogger;
  config: Pick<Config, 'demo' | 'azureOverrides'>;
  alerts: AlertService;
  hub: AgentHub;
  tokens: AgentTokens;
  onboarding: OnboardingService;
  servers: ServerService;
  games: GameService;
  modules: ModuleService;
  scheduler: Scheduler;
  /** Transport for Azure (tests: a fake). */
  fetch?: AzureFetch;
}

/**
 * M22 cloud module: Azure client, service, routes under /api/cloud, the tick, the
 * game hook (a start on a sleeping VM starts the VM first), the server hook (a
 * deallocated VM is OFF, not offline) and the module switch.
 */
export async function setupCloud(app: FastifyInstance, d: CloudDeps): Promise<CloudService> {
  const azure = new AzureClient({
    fetch: d.fetch ?? fetch,
    endpoints: azureEndpoints(d.config),
    now: d.now,
  });
  const cloud = new CloudService({
    db: d.db,
    box: d.box,
    now: d.now,
    log: d.log,
    alerts: d.alerts,
    hub: d.hub,
    tokens: d.tokens,
    onboarding: d.onboarding,
    servers: d.servers,
    games: d.games,
    azure,
  });
  d.games.setCloudHost(cloud);
  d.servers.setAsleep((id) => cloud.isAsleep(id));
  // A game created, deleted or re-ported on a cloud server: resync its NSG.
  d.games.onChange(() => cloud.tick());
  d.servers.onAgentConnected(() => cloud.tick());
  d.scheduler.every('cloud.tick', CLOUD_TICK_MS, () => cloud.tick());
  d.modules.onChange((m, on) => {
    if (m === 'cloud') cloud.setEnabled(on);
  });
  app.addHook('onReady', async () => {
    cloud.setEnabled(d.modules.enabled('cloud'));
  });
  app.addHook('preClose', async () => {
    cloud.setEnabled(false);
    await Promise.race([cloud.idle(), new Promise((r) => setTimeout(r, 3_000).unref())]);
  });
  await app.register(cloudRoutes, { prefix: '/api', db: d.db, now: d.now, cloud });
  return cloud;
}

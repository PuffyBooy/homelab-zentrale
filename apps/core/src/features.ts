import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AgentHub } from './agents/hub.js';
import type { AlertService } from './alerts/service.js';
import type { CheckService } from './checks/service.js';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { ContainerService } from './containers/service.js';
import type { SecretBox } from './crypto.js';
import type { Db } from './db/index.js';
import type { GameService } from './games/service.js';
import type { ModuleService } from './modules/service.js';
import type { Scheduler } from './scheduler.js';
import type { PortAuditService } from './servers/ports.js';
import type { ServerService } from './servers/service.js';
import type { ThrottleService } from './throttle/service.js';
import { setupApps, type AppsDeps, type AppsHandle } from './appstore/index.js';
import { setupDomains, type DomainsDeps, type DomainsHandle } from './domains/index.js';
import { setupSelfheal, type SelfhealDeps, type SelfhealHandle } from './selfheal/index.js';
import { setupSpeedtest, type SpeedtestDeps, type SpeedtestHandle } from './speedtest/index.js';
import { setupTasks, type TasksDeps, type TasksHandle } from './tasks/index.js';

/**
 * M20/M21 optional modules (tasks, selfheal, speedtest, domains, apps). Each lives in
 * its own folder and exports setup<Name>(ctx, deps) -> handle. A handle owns its
 * module switch (ctx.modules.onChange), scheduler jobs and routes (registered with
 * prefix /api by registerFeatureRoutes). app.ts only calls setupFeatures and
 * registerFeatureRoutes, so the features never edit app.ts.
 */
export interface FeatureContext {
  config: Config;
  db: Db;
  box: SecretBox;
  now: Clock;
  log: FastifyBaseLogger;
  scheduler: Scheduler;
  hub: AgentHub;
  alerts: AlertService;
  servers: ServerService;
  containers: ContainerService;
  checks: CheckService;
  games: GameService;
  throttle: ThrottleService;
  ports: PortAuditService;
  modules: ModuleService;
}

/** Common part of every handle. */
export interface FeatureHandle {
  /** Routes, registered with prefix /api after the auth guard. */
  routes?: FastifyPluginAsync;
  /** Resolves when running work (HTTP calls, RPCs) has finished (preClose). */
  idle(): Promise<void>;
  /** Stops timers and connections (preClose, after idle). */
  stop(): void;
}

/** Test hooks per feature (fake HTTP, short timers, template dirs). */
export interface FeatureDeps {
  tasks?: TasksDeps;
  selfheal?: SelfhealDeps;
  speedtest?: SpeedtestDeps;
  domains?: DomainsDeps;
  apps?: AppsDeps;
}

export interface Features {
  tasks: TasksHandle;
  selfheal: SelfhealHandle;
  speedtest: SpeedtestHandle;
  domains: DomainsHandle;
  apps: AppsHandle;
}

export function setupFeatures(ctx: FeatureContext, deps: FeatureDeps = {}): Features {
  const child = (mod: string): FeatureContext => ({ ...ctx, log: ctx.log.child({ mod }) });
  const domains = setupDomains(child('domains'), deps.domains);
  return {
    tasks: setupTasks(child('tasks'), deps.tasks),
    selfheal: setupSelfheal(child('selfheal'), deps.selfheal),
    speedtest: setupSpeedtest(child('speedtest'), deps.speedtest),
    domains,
    apps: setupApps(child('apps'), deps.apps),
  };
}

function handles(f: Features): FeatureHandle[] {
  return [f.tasks, f.selfheal, f.speedtest, f.domains, f.apps];
}

export async function registerFeatureRoutes(app: FastifyInstance, f: Features): Promise<void> {
  for (const h of handles(f)) if (h.routes) await app.register(h.routes, { prefix: '/api' });
}

export function featuresIdle(f: Features): Promise<unknown> {
  return Promise.all(handles(f).map((h) => h.idle()));
}

export function stopFeatures(f: Features): void {
  for (const h of handles(f)) h.stop();
}

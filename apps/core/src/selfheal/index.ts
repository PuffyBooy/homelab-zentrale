import type { FeatureContext, FeatureHandle } from '../features.js';
import { selfhealRoutes } from './routes.js';
import { SelfhealService, SELFHEAL_TICK_MS } from './service.js';

/** Test hooks (see FeatureDeps in ../features.ts). */
export interface SelfhealDeps {
  /** Scheduler tick of `selfheal.tick` (default 10 s). */
  tickMs?: number;
}

export interface SelfhealHandle extends FeatureHandle {
  service: SelfhealService;
}

/** M20 "Selbstheilung" (api/selfheal.ts). Switches itself with the module `selfheal`. */
export function setupSelfheal(ctx: FeatureContext, deps: SelfhealDeps = {}): SelfhealHandle {
  const service = new SelfhealService(ctx, { tickMs: deps.tickMs ?? SELFHEAL_TICK_MS });
  if (ctx.modules.enabled('selfheal')) service.start();
  const off = ctx.modules.onChange((id, on) => {
    if (id !== 'selfheal') return;
    if (on) service.start();
    else service.disable();
  });
  return {
    service,
    routes: selfhealRoutes(ctx, service),
    idle: () => service.idle(),
    stop: () => {
      off();
      service.stop();
    },
  };
}

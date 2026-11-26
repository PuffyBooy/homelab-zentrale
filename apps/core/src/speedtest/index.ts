import type { FeatureContext, FeatureHandle } from '../features.js';
import { speedtestRoutes } from './routes.js';
import { SpeedtestService, SPEEDTEST_TICK_MS } from './service.js';

/** Test hooks (see FeatureDeps in ../features.ts). */
export interface SpeedtestDeps {
  /** Scheduler tick of `speedtest.tick` (default 1 min). */
  tickMs?: number;
}

export interface SpeedtestHandle extends FeatureHandle {
  service: SpeedtestService;
}

/** M20 "Speedtest-Verlauf" (api/speedtest.ts). Switches itself with the module `speedtest`. */
export function setupSpeedtest(ctx: FeatureContext, deps: SpeedtestDeps = {}): SpeedtestHandle {
  const service = new SpeedtestService(ctx, { tickMs: deps.tickMs ?? SPEEDTEST_TICK_MS });
  if (ctx.modules.enabled('speedtest')) service.start();
  const off = ctx.modules.onChange((id, on) => {
    if (id !== 'speedtest') return;
    if (on) service.start();
    else service.disable();
  });
  return {
    service,
    routes: speedtestRoutes(service),
    idle: () => service.idle(),
    stop: () => {
      off();
      service.stop();
    },
  };
}

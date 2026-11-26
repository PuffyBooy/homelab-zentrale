import type { FeatureContext, FeatureHandle } from '../features.js';
import { appRoutes } from './routes.js';
import { AppService } from './service.js';
import { appTemplatesDir, loadBuiltinTemplates } from './templates.js';

/**
 * M21 App-Store (module `apps`, off by default). Routes are gated by the module
 * switch (installModuleGate: 404 module_disabled); the module has no timers or
 * jobs, so switching it off only blocks the routes. Work already started on a
 * server (install, update, remove) finishes.
 */

/** Test hooks (see FeatureDeps in ../features.ts). */
export interface AppsDeps {
  /** Built-in templates directory (default: HZ_APP_TEMPLATES_DIR, the image copy or the repo). */
  templatesDir?: string;
}

export interface AppsHandle extends FeatureHandle {
  service: AppService;
}

export function setupApps(ctx: FeatureContext, deps: AppsDeps = {}): AppsHandle {
  const dir = appTemplatesDir(deps.templatesDir);
  const service = new AppService(ctx, loadBuiltinTemplates(dir, ctx.log));
  return {
    service,
    routes: appRoutes(service, ctx.now),
    idle: () => service.idle(),
    stop: () => service.stop(),
  };
}

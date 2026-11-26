import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { installAuthGuard } from './guard.js';
import { authRoutes } from './routes.js';
import { AuthService, type AuthDeps } from './service.js';

export {
  hasStepUp,
  requireStepUp,
  DEVICE_API_ROUTES,
  PUBLIC_API_PREFIXES,
  PUBLIC_API_ROUTES,
} from './guard.js';
export { AuthService } from './service.js';

/**
 * Installs the global /api guard (session + Origin), the auth routes and, if no
 * admin exists yet, arms the one-time setup and logs the setup link.
 * Must run before any other /api route is registered.
 */
export async function setupAuth(
  app: FastifyInstance,
  deps: AuthDeps & { config: Config },
): Promise<AuthService> {
  const svc = new AuthService(deps);
  installAuthGuard(app, {
    sessions: svc.sessions,
    baseUrl: deps.config.baseUrl,
    wallDevices: () => svc.wallDevices,
  });
  await app.register(authRoutes, { prefix: '/api', auth: svc });

  if (!svc.hasUser()) {
    const { config } = deps;
    if (config.setupToken !== undefined) {
      svc.setup.arm(config.setupToken);
      app.log.warn('setup armed with HZ_SETUP_TOKEN (NODE_ENV=test only)');
    } else {
      const token = svc.setup.arm();
      const base = (config.baseUrl ?? `http://127.0.0.1:${config.port}`).replace(/\/+$/, '');
      // The only place a setup token is ever written. It lives in the URL
      // fragment, so browsers never send it to the server or into access logs.
      app.log.info(`Ersteinrichtung: ${base}/setup#token=${token}`);
    }
  }
  return svc;
}

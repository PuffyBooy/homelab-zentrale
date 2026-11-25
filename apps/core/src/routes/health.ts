import type { FastifyPluginAsync } from 'fastify';

/** Public liveness probe. Must stay free of any internal details. */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({ ok: true }) as const);
};

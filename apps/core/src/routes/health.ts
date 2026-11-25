import type { FastifyPluginAsync } from 'fastify';
import { healthResponseSchema, type HealthResponse } from '@hz/shared';

/** Public liveness probe. Must stay free of any internal details. */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (): Promise<HealthResponse> => healthResponseSchema.parse({ ok: true }));
};

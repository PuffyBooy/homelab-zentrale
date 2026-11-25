import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { healthRoutes } from './routes/health.js';

const here = dirname(fileURLToPath(import.meta.url));

/** apps/web/dist, seen from apps/core/src or apps/core/dist. */
export const defaultWebDir = resolve(here, '../../web/dist');

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.env === 'test' ? false : { level: config.env === 'development' ? 'debug' : 'info' },
  });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // design/components.css loads the fonts from Google Fonts until they are self-hosted.
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  await app.register(healthRoutes, { prefix: '/api' });

  const webDir = resolve(config.webDir ?? defaultWebDir);
  const hasWeb = existsSync(resolve(webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const isApi = path === '/api' || path.startsWith('/api/');
    if (hasWeb && request.method === 'GET' && !isApi) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({ ok: false, error: 'not_found' });
  });

  return app;
}

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { setupAuth, type AuthService } from './auth/index.js';
import { isApiPath, requestPath } from './auth/guard.js';
import { systemClock, type Clock } from './clock.js';
import type { Config } from './config.js';
import { createSecretBox } from './crypto.js';
import { openDatabase, type DbHandle } from './db/index.js';
import { errorHandler, sendError } from './http/errors.js';
import { healthRoutes } from './routes/health.js';

const here = dirname(fileURLToPath(import.meta.url));

/** apps/web/dist, seen from apps/core/src or apps/core/dist. */
export const defaultWebDir = resolve(here, '../../web/dist');

export interface AppDeps {
  /** Database. Defaults to `${dataDir}/hz.sqlite`. The app closes it on shutdown. */
  db?: DbHandle;
  /** Clock for sessions, step-up, TOTP and rate limits (tests move time). */
  now?: Clock;
  /** Capture logs (tests). Enables logging also with NODE_ENV=test. */
  logStream?: NodeJS.WritableStream;
}

export interface RouteInfo {
  method: string;
  url: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route registered, collected via onRoute (used by the 401 test). */
    hzRoutes: RouteInfo[];
    hzAuth: AuthService;
  }
}

/** Keys that must never reach the log, wherever they appear. */
const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  'headers["set-cookie"]',
  ...[
    'password',
    'currentPassword',
    'newPassword',
    'code',
    'token',
    'secret',
    'setupToken',
  ].flatMap((k) => [k, `*.${k}`, `body.${k}`, `req.body.${k}`]),
];

function isLoopbackAddress(addr: string): boolean {
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

function loggerOptions(config: Config, deps: AppDeps): NonNullable<FastifyServerOptions['logger']> {
  const level = config.env === 'development' ? 'debug' : 'info';
  if (deps.logStream) return { level: 'debug', stream: deps.logStream, redact: REDACT };
  if (config.env === 'test') return false;
  return { level, redact: REDACT };
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const db = deps.db ?? openDatabase(join(config.dataDir, 'hz.sqlite'));
  const now = deps.now ?? systemClock;

  const app = Fastify({
    logger: loggerOptions(config, deps),
    // `tailscale serve` connects from loopback and appends X-Forwarded-For. Only
    // then do we take the client IP from that header (the last hop). Direct
    // connections from anywhere else use the socket address, so the header
    // cannot be spoofed to dodge the rate limit.
    trustProxy: (address: string, hop: number) => hop === 0 && isLoopbackAddress(address),
    bodyLimit: 1024 * 1024,
  });
  app.addHook('onClose', async () => db.close());

  const routes: RouteInfo[] = [];
  app.decorate('hzRoutes', routes);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routes.push({ method, url: r.url });
  });

  app.setErrorHandler(errorHandler);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(fastifyCookie);

  // Auth first: it installs the global /api guard that every later route inherits.
  const auth = await setupAuth(app, {
    db: db.db,
    box: createSecretBox(config.secretKey),
    now,
    config,
  });
  app.decorate('hzAuth', auth);

  await app.register(healthRoutes, { prefix: '/api' });

  const webDir = resolve(config.webDir ?? defaultWebDir);
  const hasWeb = existsSync(resolve(webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    if (hasWeb && request.method === 'GET' && !isApiPath(requestPath(request.url))) {
      return reply.type('text/html').sendFile('index.html');
    }
    return sendError(reply, 404, 'not_found');
  });

  return app;
}

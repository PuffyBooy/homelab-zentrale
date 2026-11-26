import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { extname, join, sep } from 'node:path';
import type {
  FastifyError,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import {
  shareActionRequestSchema,
  shareCommandRequestSchema,
  shareCommandResponseSchema,
  shareConsoleQuerySchema,
  shareConsoleResponseSchema,
  shareErrorResponseSchema,
  shareStatusResponseSchema,
  shareWhitelistAskSchema,
  shareWhitelistRequestSchema,
} from '@hz/shared';
import { originAllowed } from '../auth/guard.js';
import { FailureLimiter, loginLimits } from '../auth/rate-limit.js';
import type { Clock } from '../clock.js';
import { sendError } from '../http/errors.js';
import { WindowLimiter } from './limits.js';
import {
  ResponseShapeError,
  SHARE_CONSOLE_IP_LIMIT,
  SHARE_CONSOLE_TOKEN_LIMIT,
  SHARE_IP_LIMIT,
  SHARE_LIMIT_WINDOW_MS,
  SHARE_TOKEN_LIMIT,
  ShareError,
  shareErrorOf,
  shareTokenHash,
  strictOut,
  type ShareContext,
  type ShareService,
  type ShareVia,
} from './service.js';

const shareEmptyQuerySchema = z.strictObject({});

/** Strict CSP for the share page: own files only, no inline code, no framing. */
export const SHARE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const UI_MISSING =
  'Die Freigabe-Seite ist gerade nicht verfügbar. Bitte später noch einmal versuchen.';
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

declare module 'fastify' {
  interface FastifyRequest {
    /** Friend IP reported by the gateway (X-Share-Client-Ip), set by the gateway hook. */
    shareClientIp?: string;
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return typeof v === 'string' ? v : undefined;
}

function sendShareError(reply: FastifyReply, err: ShareError): FastifyReply {
  const body = shareErrorResponseSchema.parse({ ok: false, error: err.code, ...err.extra });
  if (err.extra.retryAfter !== undefined) {
    void reply.header('retry-after', String(err.extra.retryAfter));
  }
  return reply.code(err.status).send(body);
}

/** Friend API errors use only the share error codes and never echo input. */
function shareErrorHandler(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (err instanceof ShareError) return sendShareError(reply, err);
  if (err instanceof z.ZodError) return sendShareError(reply, new ShareError(400, 'invalid_input'));
  if (err instanceof ResponseShapeError) {
    request.log.error({ err: { name: err.name } }, 'share response refused');
    return sendShareError(reply, new ShareError(503, 'unavailable'));
  }
  const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
  if (status >= 400 && status < 500) {
    return sendShareError(reply, new ShareError(400, 'invalid_input'));
  }
  const mapped = shareErrorOf(err);
  if (mapped.status >= 500) {
    request.log.error({ err: { name: err.name, stack: err.stack } }, 'share request failed');
  }
  return sendShareError(reply, mapped);
}

interface FriendApiOptions {
  shares: ShareService;
  now: Clock;
  via: ShareVia;
  /** Friend's share token from the request (header), or undefined. */
  token: (request: FastifyRequest) => string | undefined;
  /** Friend's IP. */
  ip: (request: FastifyRequest) => string;
}

/**
 * status, action, console (GET/POST), whitelist. Same handlers for the
 * tailnet (`/s/api`) and the gateway (`/api/share-gateway`). Order per request:
 * rate limit per IP, rate limit per token, token/state/PIN, permission, action.
 */
function friendApi(app: FastifyInstance, o: FriendApiOptions): void {
  // Two budgets like the gateway: API calls, and GET console polls.
  const limits = {
    api: {
      ip: new WindowLimiter(SHARE_IP_LIMIT, SHARE_LIMIT_WINDOW_MS, o.now),
      token: new WindowLimiter(SHARE_TOKEN_LIMIT, SHARE_LIMIT_WINDOW_MS, o.now),
    },
    poll: {
      ip: new WindowLimiter(SHARE_CONSOLE_IP_LIMIT, SHARE_LIMIT_WINDOW_MS, o.now),
      token: new WindowLimiter(SHARE_CONSOLE_TOKEN_LIMIT, SHARE_LIMIT_WINDOW_MS, o.now),
    },
  };

  const ctxOf = async (
    request: FastifyRequest,
    budget: 'api' | 'poll' = 'api',
  ): Promise<ShareContext> => {
    const ip = o.ip(request);
    const l = limits[budget];
    const waitIp = l.ip.hit(ip);
    if (waitIp !== null) throw new ShareError(429, 'rate_limited', { retryAfter: waitIp });
    const token = o.token(request);
    if (token !== undefined && token !== '') {
      const waitToken = l.token.hit(shareTokenHash(token));
      if (waitToken !== null) throw new ShareError(429, 'rate_limited', { retryAfter: waitToken });
    }
    return o.shares.authenticate(token, header(request, 'x-share-pin'), ip, o.via);
  };

  app.get('/status', async (request) => {
    const ctx = await ctxOf(request);
    return strictOut(shareStatusResponseSchema, o.shares.status(ctx));
  });

  app.post('/action', async (request) => {
    const ctx = await ctxOf(request);
    const { action } = shareActionRequestSchema.parse(request.body);
    return strictOut(shareStatusResponseSchema, await o.shares.action(ctx, action));
  });

  app.get('/console', async (request) => {
    const ctx = await ctxOf(request, 'poll');
    const { after } = shareConsoleQuerySchema.parse(request.query ?? {});
    return strictOut(shareConsoleResponseSchema, o.shares.console(ctx, after));
  });

  app.post('/console', async (request) => {
    const ctx = await ctxOf(request);
    const { command } = shareCommandRequestSchema.parse(request.body);
    return strictOut(shareCommandResponseSchema, await o.shares.command(ctx, command));
  });

  app.post('/whitelist', async (request) => {
    const ctx = await ctxOf(request);
    const { op, player } = shareWhitelistRequestSchema.parse(request.body);
    return strictOut(shareCommandResponseSchema, await o.shares.whitelist(ctx, op, player));
  });

  // M12: whitelist request (the admin approves after a push).
  app.post('/whitelist-request', async (request) => {
    const ctx = await ctxOf(request);
    const { player } = shareWhitelistAskSchema.parse(request.body);
    return strictOut(shareStatusResponseSchema, o.shares.whitelistAsk(ctx, player));
  });

  // M12: world download, streamed (never buffered) from game.export.
  app.get('/world', async (request, reply) => {
    const ctx = await ctxOf(request);
    shareEmptyQuerySchema.parse(request.query ?? {});
    const dl = await o.shares.world(ctx);
    reply.raw.once('close', () => {
      if (!dl.stream.writableFinished) dl.stream.destroy();
    });
    return reply
      .code(200)
      .header('content-type', 'application/zstd')
      .header('content-disposition', `attachment; filename="${dl.fileName}"`)
      .header('content-length', String(dl.bytes))
      .header('x-content-type-options', 'nosniff')
      .send(dl.stream);
  });

  // Nothing else exists under this API.
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/*',
    handler: async () => {
      throw new ShareError(404, 'not_found');
    },
  });
}

export interface ShareTailnetOptions {
  shares: ShareService;
  now: Clock;
  baseUrl: string | undefined;
  /** Directory of the built share UI (index.html, assets/). */
  uiDir: string;
}

function shareTokenFromAuthorization(request: FastifyRequest): string | undefined {
  const auth = header(request, 'authorization');
  const m = auth === undefined ? null : /^Share ([^\s]+)$/.exec(auth);
  return m?.[1];
}

/**
 * Tailnet share page and API (prefix `/s`): no admin session. The page path
 * contains the token, so these responses are never cached, never indexed and
 * send no Referer; the logger redacts `/s/<token>` (app.ts).
 */
export const shareTailnetRoutes: FastifyPluginAsync<ShareTailnetOptions> = async (app, o) => {
  app.setErrorHandler(shareErrorHandler);
  app.addHook('onSend', async (_request, reply) => {
    void reply.header('cache-control', 'no-store');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('x-robots-tag', 'noindex, nofollow');
    void reply.header('content-security-policy', SHARE_CSP);
  });

  await app.register(
    async (api) => {
      api.setErrorHandler(shareErrorHandler);
      // The token travels in a header, so CSRF needs no cookie defence; still,
      // a browser POST from another origin is refused.
      api.addHook('onRequest', async (request) => {
        if (request.method !== 'POST' || request.headers.origin === undefined) return;
        if (!originAllowed(request, o.baseUrl)) throw new ShareError(403, 'forbidden');
      });
      friendApi(api, {
        shares: o.shares,
        now: o.now,
        via: 'tailnet',
        token: shareTokenFromAuthorization,
        ip: (request) => request.ip,
      });
    },
    { prefix: '/api' },
  );

  const uiRoot = (): string | null => {
    try {
      return existsSync(join(o.uiDir, 'index.html')) ? realpathSync(o.uiDir) : null;
    } catch {
      return null;
    }
  };
  const missing = (reply: FastifyReply) =>
    reply.code(503).type('text/plain; charset=utf-8').send(UI_MISSING);

  app.get('/assets/*', async (request, reply) => {
    const name = (request.params as Record<string, string | undefined>)['*'] ?? '';
    const root = uiRoot();
    if (root === null) return missing(reply);
    if (!ASSET_RE.test(name)) return reply.code(404).type('text/plain').send('Nicht gefunden');
    const assets = join(root, 'assets');
    let file: string;
    try {
      file = realpathSync(join(assets, name));
    } catch {
      return reply.code(404).type('text/plain').send('Nicht gefunden');
    }
    if (!file.startsWith(assets + sep) || !statSync(file).isFile()) {
      return reply.code(404).type('text/plain').send('Nicht gefunden');
    }
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    return reply.type(type).header('x-content-type-options', 'nosniff').send(readFileSync(file));
  });

  // Same page for every token: the page itself never says whether a link exists.
  app.get('/:token', async (_request, reply) => {
    const root = uiRoot();
    if (root === null) return missing(reply);
    return reply.type('text/html; charset=utf-8').send(readFileSync(join(root, 'index.html')));
  });
};

export interface ShareGatewayOptions {
  shares: ShareService;
  now: Clock;
}

function bearer(request: FastifyRequest): string | undefined {
  const auth = header(request, 'authorization');
  const m = auth === undefined ? null : /^Bearer ([^\s]+)$/.exec(auth);
  return m?.[1];
}

/**
 * Gateway API (prefix `/api/share-gateway`): only with the gateway token, only
 * while the gateway is on, friend IP from `X-Share-Client-Ip`. Nothing else
 * is reachable with the gateway token.
 */
export const shareGatewayRoutes: FastifyPluginAsync<ShareGatewayOptions> = async (app, o) => {
  const failures = new FailureLimiter(loginLimits, o.now);
  app.setErrorHandler(shareErrorHandler);
  app.addHook('onRequest', async (request, reply) => {
    const token = bearer(request);
    if (token === undefined) return sendError(reply, 401, 'unauthorized');
    // Only wrong tokens count, so guessing is slowed down (5 per 15 min, then longer).
    const limited = failures.check(request.ip);
    if (limited.blocked) return sendError(reply, 429, 'rate_limited', limited.retryAfter);
    if (!o.shares.gatewayTokenOk(token)) {
      failures.fail(request.ip);
      return sendError(reply, 401, 'unauthorized');
    }
    if (!o.shares.gatewayEnabled())
      return sendShareError(reply, new ShareError(503, 'unavailable'));
    o.shares.touchGateway();
    const ip = header(request, 'x-share-client-ip')?.trim() ?? '';
    if (ip.length > 64 || isIP(ip) === 0) {
      return sendShareError(reply, new ShareError(400, 'invalid_input'));
    }
    request.shareClientIp = ip;
    return undefined;
  });
  friendApi(app, {
    shares: o.shares,
    now: o.now,
    via: 'gateway',
    token: (request) => header(request, 'x-share-token'),
    ip: (request) => request.shareClientIp ?? request.ip,
  });
};

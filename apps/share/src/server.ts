import http from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import { clientIp, rateLimitKey } from './client-ip.js';
import {
  checkCoreAnswer,
  checkDownloadHeaders,
  findRoute,
  sharePinFrom,
  shareTokenFrom,
  type ApiRoute,
  type ShareErrorBody,
} from './proxy.js';
import { RateLimiter } from './rate-limit.js';
import type { UiFiles } from './static.js';

export const MAX_BODY = 4 * 1024;
const MAX_CORE_BODY = 4 * 1024 * 1024;
const CORE_TIMEOUT_MS = 10_000;
const MAX_IN_FLIGHT = 32;
/** World downloads (M12): the core builds the archive first, then streams it. */
export const DOWNLOAD_HEADERS_TIMEOUT_MS = 16 * 60_000;
/** No byte from the core for this long during a download: abort. */
export const DOWNLOAD_IDLE_MS = 2 * 60_000;
/** Downloads at once over all friends (each is a long-lived core connection). */
export const MAX_DOWNLOADS = 4;
/** World downloads per IP and hour (the core allows 1 per link and hour). */
export const WORLD_PER_IP_HOUR = 3;

/** Limits per IP (IPv6 per /64) and minute. */
export const LIMITS = {
  /** NETWORK.md: 10 API requests per minute and IP (status, actions, commands, whitelist). */
  api: 10,
  /** GET /s/api/console polls every 3 s (20/min), so it has its own budget. */
  poll: 30,
  /** Page and assets. */
  page: 120,
  /** All IPs together, protects the core. */
  global: 600,
} as const;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

const PAGE_PATH = /^\/s\/[A-Za-z0-9_-]{43}$/;
const ASSET_PATH = /^\/s\/assets\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
/** Raw request path: plain characters only, no percent-encoding, no dot segments. */
const SAFE_PATH = /^\/[A-Za-z0-9/._-]*$/;

export interface GatewayDeps {
  config: Config;
  logger: Logger;
  ui: UiFiles;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Ctx {
  route: string;
  ip: string;
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string | Buffer,
  type: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': String(Buffer.byteLength(body)),
    ...extra,
  });
  res.end(body);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8', {
    'Cache-Control': 'no-store',
    ...extra,
  });
}

function sendError(
  res: http.ServerResponse,
  status: number,
  body: ShareErrorBody,
  extra: Record<string, string> = {},
): void {
  const headers =
    body.retryAfter !== undefined
      ? { 'Retry-After': String(Math.max(0, body.retryAfter)), ...extra }
      : extra;
  sendJson(res, status, body, headers);
}

function notFound(res: http.ServerResponse): void {
  send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
}

/** Reads at most `max` bytes; null when the body is larger. */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        done = true;
        resolve(null);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? undefined : v;
}

export function createGateway(deps: GatewayDeps): http.Server {
  const { config, logger, ui } = deps;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  logger.addSecret(config.gatewayToken);

  const limiters = {
    api: new RateLimiter(LIMITS.api, 60_000),
    poll: new RateLimiter(LIMITS.poll, 60_000),
    page: new RateLimiter(LIMITS.page, 60_000),
    global: new RateLimiter(LIMITS.global, 60_000, 1),
    world: new RateLimiter(WORLD_PER_IP_HOUR, 60 * 60_000),
  };
  let inFlight = 0;
  let downloads = 0;

  /**
   * GET /s/api/world: the core's file answer is piped to the friend chunk by
   * chunk (backpressure through pipeline), never buffered. Only a 200 with
   * application/zstd, a valid size and our file name passes; more bytes than
   * announced end the response.
   */
  async function proxyDownload(
    res: http.ServerResponse,
    route: ApiRoute,
    url: string,
    headers: Record<string, string>,
    ctx: Ctx,
  ): Promise<void> {
    if (downloads >= MAX_DOWNLOADS) {
      return sendError(res, 503, { ok: false, error: 'unavailable', retryAfter: 60 });
    }
    downloads += 1;
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), DOWNLOAD_HEADERS_TIMEOUT_MS);
    // The friend went away (also while the core still builds the archive): abort
    // the core request, so the slot is freed and the core cancels the export.
    const onClose = (): void => {
      if (!res.writableFinished) ctrl.abort();
    };
    res.once('close', onClose);
    try {
      let coreRes: Response;
      try {
        coreRes = await doFetch(url, {
          method: 'GET',
          headers: { ...headers, Accept: 'application/zstd, application/json' },
          redirect: 'error',
          signal: ctrl.signal,
        });
      } catch {
        logger.warn('core unreachable', { route: ctx.route, reason: 'network' });
        return sendError(res, 502, { ok: false, error: 'unavailable' });
      }
      clearTimeout(timer);
      if (coreRes.status !== 200) {
        const type = coreRes.headers.get('content-type') ?? '';
        const text = /^application\/json\b/i.test(type)
          ? await readCapped(coreRes, 16 * 1024)
          : null;
        if (text === null) await coreRes.body?.cancel().catch(() => undefined);
        let json: unknown = undefined;
        try {
          json = text === null ? undefined : JSON.parse(text);
        } catch {
          json = undefined;
        }
        const outcome = checkCoreAnswer(route, coreRes.status, json);
        if (outcome.kind === 'error') return sendError(res, outcome.status, outcome.body);
        logger.warn('core answer refused', { route: ctx.route, coreStatus: coreRes.status });
        return sendError(res, 502, { ok: false, error: 'unavailable' });
      }
      const ok = checkDownloadHeaders({
        type: coreRes.headers.get('content-type'),
        length: coreRes.headers.get('content-length'),
        disposition: coreRes.headers.get('content-disposition'),
      });
      if (!ok || !coreRes.body) {
        await coreRes.body?.cancel().catch(() => undefined);
        logger.warn('core answer refused', { route: ctx.route, coreStatus: 200 });
        return sendError(res, 502, { ok: false, error: 'unavailable' });
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/zstd',
        'Content-Length': String(ok.length),
        'Content-Disposition': ok.disposition,
        'Cache-Control': 'no-store',
      });
      let seen = 0;
      timer = setTimeout(() => ctrl.abort(), DOWNLOAD_IDLE_MS);
      const guard = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          clearTimeout(timer);
          timer = setTimeout(() => ctrl.abort(), DOWNLOAD_IDLE_MS);
          if (seen > ok.length) {
            cb(new Error('more bytes than announced'));
            return;
          }
          cb(null, chunk);
        },
      });
      const body = Readable.fromWeb(coreRes.body as unknown as NodeReadableStream);
      try {
        await pipeline(body, guard, res);
      } catch {
        logger.warn('download aborted', { route: ctx.route, bytes: seen });
        res.destroy();
      }
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      downloads -= 1;
    }
  }

  const limited = (res: http.ServerResponse, retryAfter: number, json: boolean): void => {
    if (json) {
      sendError(res, 429, { ok: false, error: 'rate_limited', retryAfter });
    } else {
      send(res, 429, 'Zu viele Anfragen', 'text/plain; charset=utf-8', {
        'Retry-After': String(retryAfter),
        'Cache-Control': 'no-store',
      });
    }
  };

  async function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: ApiRoute,
    search: string,
    ctx: Ctx,
  ): Promise<void> {
    const token = shareTokenFrom(headerValue(req.headers.authorization));
    // Same answer as an unknown token: the core never sees malformed ones.
    if (!token) return sendError(res, 404, { ok: false, error: 'not_found' });
    const pin = sharePinFrom(req.headers['x-share-pin']);
    if (pin === null) return sendError(res, 400, { ok: false, error: 'invalid_input' });

    let query = '';
    if (route.query) {
      const params = new URLSearchParams(search);
      const obj: Record<string, string> = {};
      for (const [k, v] of params) {
        if (k in obj) return sendError(res, 400, { ok: false, error: 'invalid_input' });
        obj[k] = v;
      }
      const parsed = route.query.safeParse(obj);
      if (!parsed.success) return sendError(res, 400, { ok: false, error: 'invalid_input' });
      const clean = new URLSearchParams(parsed.data as Record<string, string>).toString();
      query = clean === '' ? '' : `?${clean}`;
    }

    let body: string | undefined;
    if (route.request) {
      const type = headerValue(req.headers['content-type']) ?? '';
      if (!/^application\/json\s*(;\s*charset=utf-8\s*)?$/i.test(type)) {
        return sendError(res, 400, { ok: false, error: 'invalid_input' });
      }
      const declared = Number(req.headers['content-length'] ?? '0');
      if (declared > MAX_BODY) {
        return sendError(res, 413, { ok: false, error: 'invalid_input' }, { Connection: 'close' });
      }
      const raw = await readBody(req, MAX_BODY);
      if (raw === null) {
        return sendError(res, 413, { ok: false, error: 'invalid_input' }, { Connection: 'close' });
      }
      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendError(res, 400, { ok: false, error: 'invalid_input' });
      }
      const parsed = route.request.safeParse(json);
      if (!parsed.success) return sendError(res, 400, { ok: false, error: 'invalid_input' });
      body = JSON.stringify(parsed.data);
    }

    if (inFlight >= MAX_IN_FLIGHT) {
      return sendError(res, 503, { ok: false, error: 'unavailable', retryAfter: 5 });
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${config.gatewayToken}`,
      'X-Share-Token': token,
      'X-Share-Client-Ip': ctx.ip,
    };
    if (pin !== undefined) headers['X-Share-Pin'] = pin;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (route.download) {
      const w = limiters.world.hit(rateLimitKey(ctx.ip), now());
      if (!w.ok) return limited(res, w.retryAfter, true);
      return proxyDownload(
        res,
        route,
        `${config.coreUrl}/api/share-gateway/${route.name}${query}`,
        headers,
        ctx,
      );
    }

    inFlight += 1;
    try {
      const coreRes = await doFetch(`${config.coreUrl}/api/share-gateway/${route.name}${query}`, {
        method: route.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(CORE_TIMEOUT_MS),
      });
      const type = coreRes.headers.get('content-type') ?? '';
      const text = /^application\/json\b/i.test(type)
        ? await readCapped(coreRes, MAX_CORE_BODY)
        : null;
      let json: unknown = undefined;
      if (text !== null) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      const outcome = checkCoreAnswer(route, coreRes.status, json);
      if (outcome.kind === 'bad') {
        logger.warn('core answer refused', { route: ctx.route, coreStatus: coreRes.status });
        return sendError(res, 502, { ok: false, error: 'unavailable' });
      }
      if (outcome.kind === 'error') return sendError(res, outcome.status, outcome.body);
      return sendJson(res, 200, outcome.body);
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network';
      logger.warn('core unreachable', { route: ctx.route, reason });
      return sendError(res, 502, { ok: false, error: 'unavailable' });
    } finally {
      inFlight -= 1;
    }
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: Ctx,
  ): Promise<void> {
    const url = req.url ?? '';
    const q = url.indexOf('?');
    const pathname = q === -1 ? url : url.slice(0, q);
    const search = q === -1 ? '' : url.slice(q + 1);
    const method = req.method ?? '';
    const segments = pathname.split('/');
    if (
      !SAFE_PATH.test(pathname) ||
      segments.some((s, i) => i > 0 && (s === '' || s === '.' || s === '..'))
    ) {
      return notFound(res);
    }
    const t = now();

    if (pathname.startsWith('/s/api/')) {
      const route = findRoute(method, pathname);
      ctx.route = route ? `${method} ${pathname}` : 'unmatched';
      const budget = route?.budget ?? 'api';
      const g = limiters.global.hit('*', t);
      if (!g.ok) return limited(res, g.retryAfter, true);
      const r = limiters[budget].hit(rateLimitKey(ctx.ip), t);
      if (!r.ok) return limited(res, r.retryAfter, true);
      if (!route) return sendError(res, 404, { ok: false, error: 'not_found' });
      return handleApi(req, res, route, search, ctx);
    }

    if (method !== 'GET') return notFound(res);
    const asset = ASSET_PATH.exec(pathname);
    const isPage = PAGE_PATH.test(pathname);
    if (!asset && !isPage) return notFound(res);
    ctx.route = isPage ? 'GET /s/:token' : `GET /s/assets/${asset?.[1] ?? ''}`;
    const r = limiters.page.hit(rateLimitKey(ctx.ip), t);
    if (!r.ok) return limited(res, r.retryAfter, false);

    if (isPage) {
      // The page never checks the token; the API does. So the answer is the same for all.
      if (!ui.index) {
        return send(res, 503, 'Nicht verfügbar', 'text/plain; charset=utf-8', {
          'Cache-Control': 'no-store',
        });
      }
      return send(res, 200, ui.index, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
    const file = asset?.[1] === undefined ? undefined : ui.assets.get(asset[1]);
    if (!file) return notFound(res);
    return send(res, 200, file.body, file.type, {
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  }

  const server = http.createServer(
    { maxHeaderSize: 8 * 1024, requestTimeout: 15_000, headersTimeout: 10_000 },
    (req, res) => {
      const started = now();
      const ctx: Ctx = {
        route: 'unmatched',
        ip: clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']),
      };
      res.on('finish', () => {
        // Never the raw URL or headers: tokens and PINs stay out of the log.
        logger.info('request', {
          method: req.method,
          route: ctx.route,
          status: res.statusCode,
          ms: now() - started,
          ip: ctx.ip,
        });
      });
      handle(req, res, ctx).catch((err: unknown) => {
        logger.error('request failed', { route: ctx.route, err });
        if (!res.headersSent) sendError(res, 500, { ok: false, error: 'unavailable' });
        else res.destroy();
      });
    },
  );
  server.keepAliveTimeout = 5_000;
  return server;
}

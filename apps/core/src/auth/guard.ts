import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ONBOARDING_EXCHANGE_PATH, WALL_COOKIE } from '@hz/shared';
import type { Clock } from '../clock.js';
import { sendError } from '../http/errors.js';
import { SESSION_COOKIE, SESSION_TTL_MS, type AuthContext, type SessionStore } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Admin session, set by the global guard for every /api request. */
    auth: AuthContext | null;
    /** Wall device (cookie `hz_wall`), only ever set on DEVICE_API_ROUTES. */
    wallDevice: WallDeviceContext | null;
  }
}

export interface WallDeviceContext {
  id: string;
  lastSeenAt: number | null;
}

/** Resolves a wall cookie value to a device (installed by the wall module). */
export type WallDeviceResolver = (token: string | undefined) => WallDeviceContext | null;

/**
 * /api routes that work without a session. Everything else under /api, including
 * unknown paths, answers 401 without a valid session. Extend this list only for
 * routes with their own auth (e.g. the share gateway API with its gateway token).
 */
export const PUBLIC_API_ROUTES: readonly string[] = [
  '/api/health',
  '/api/auth/state',
  '/api/auth/login',
  '/api/setup/start',
  '/api/setup/confirm',
  // Swaps a wall device token for the wall cookie (own rate limit, Origin checked).
  '/api/wall/session',
  // M11: install.sh swaps a one-time onboarding code (own rate limit, see below for Origin).
  ONBOARDING_EXCHANGE_PATH,
];
/**
 * Exact public routes called by scripts (curl sends no Origin). A request
 * without Origin passes; one with an Origin still has to match, so a web page
 * cannot post there from another site.
 */
export const SCRIPT_API_ROUTES: readonly string[] = [ONBOARDING_EXCHANGE_PATH];
/**
 * The only routes (GET) that accept the read-only wall device cookie instead of an
 * admin session. Every other route ignores that cookie.
 */
export const DEVICE_API_ROUTES: readonly string[] = ['/api/wall/state'];
/**
 * Prefixes with their own auth (no session). The share gateway API authenticates
 * with a bearer token in a header, not a cookie, so it needs no Origin check
 * (server-to-server calls send no Origin).
 */
export const PUBLIC_API_PREFIXES: string[] = ['/api/share-gateway/'];
const OWN_AUTH_PREFIXES: readonly string[] = ['/api/share-gateway/'];

function ownAuthPath(path: string): boolean {
  return OWN_AUTH_PREFIXES.some((p) => path.startsWith(p));
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

export function isPublicApiPath(path: string): boolean {
  return PUBLIC_API_ROUTES.includes(path) || PUBLIC_API_PREFIXES.some((p) => path.startsWith(p));
}

export function requestPath(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * The path as the router sees it: percent-decoded once, like find-my-way does,
 * so `/%61pi/...` cannot bypass the guard. Returns null for malformed encodings.
 */
export function decodedPath(url: string): string | null {
  try {
    return decodeURIComponent(requestPath(url));
  } catch {
    return null;
  }
}

/** Decides with both the decoded URL and the matched route pattern. */
function guardPath(request: FastifyRequest): { path: string; api: boolean } | null {
  const decoded = decodedPath(request.url);
  if (decoded === null) return null;
  const route = request.routeOptions.url;
  const api = isApiPath(decoded) || (typeof route === 'string' && isApiPath(route));
  return { path: typeof route === 'string' && isApiPath(route) ? route : decoded, api };
}

/**
 * CSRF: a state-changing request needs an Origin whose host matches the Host
 * header (also true behind the Vite dev proxy, which keeps Host on :5173) or the
 * host of HZ_BASE_URL. The scheme is not compared, because `tailscale serve`
 * terminates TLS and the core itself only sees plain HTTP.
 */
export function originAllowed(request: FastifyRequest, baseUrl: string | undefined): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return false;
  let originHost: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    originHost = u.host.toLowerCase();
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  const host = request.headers.host;
  if (typeof host === 'string' && host !== '') allowed.add(host.toLowerCase());
  if (baseUrl) allowed.add(new URL(baseUrl).host.toLowerCase());
  return allowed.has(originHost);
}

export function sessionCookieOptions(maxAgeMs = SESSION_TTL_MS) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  } as const;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(0));
}

export function installAuthGuard(
  app: FastifyInstance,
  opts: {
    sessions: SessionStore;
    baseUrl: string | undefined;
    /** Looked up per request: the wall module installs it after the guard. */
    wallDevices: () => WallDeviceResolver | null;
  },
): void {
  app.decorateRequest('auth', null);
  app.decorateRequest('wallDevice', null);

  app.addHook('onRequest', async (request, reply) => {
    const g = guardPath(request);
    if (g === null) return sendError(reply, 400, 'invalid_input');
    if (!g.api) return;
    const path = g.path;

    const token = request.cookies[SESSION_COOKIE];
    request.auth = opts.sessions.resolve(token);
    if (request.auth?.touched && token) setSessionCookie(reply, token);

    if (!isPublicApiPath(path) && !request.auth) {
      const deviceRoute =
        (request.method === 'GET' || request.method === 'HEAD') && DEVICE_API_ROUTES.includes(path);
      const device = deviceRoute
        ? (opts.wallDevices()?.(request.cookies[WALL_COOKIE]) ?? null)
        : null;
      if (!device) return sendError(reply, 401, 'unauthorized');
      request.wallDevice = device;
    }
    const scriptCall = SCRIPT_API_ROUTES.includes(path) && request.headers.origin === undefined;
    if (
      MUTATING.has(request.method) &&
      !ownAuthPath(path) &&
      !scriptCall &&
      !originAllowed(request, opts.baseUrl)
    ) {
      return sendError(reply, 403, 'bad_origin');
    }
  });

  app.addHook('onSend', async (request, reply) => {
    if (guardPath(request)?.api) void reply.header('cache-control', 'no-store');
  });
}

/** True if the session has a valid step-up (fresh TOTP within the last 15 min). */
export function hasStepUp(request: FastifyRequest, now: Clock): boolean {
  const until = request.auth?.session.stepUpUntil ?? null;
  return request.auth !== null && until !== null && until > now();
}

/** preHandler for routes that need a fresh TOTP (docs/SECURITY.md, step-up). */
export function requireStepUp(now: Clock) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    if (!hasStepUp(request, now)) return sendError(reply, 403, 'step_up_required');
    return undefined;
  };
}

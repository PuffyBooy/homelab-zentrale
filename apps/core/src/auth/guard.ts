import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../clock.js';
import { sendError } from '../http/errors.js';
import { SESSION_COOKIE, SESSION_TTL_MS, type AuthContext, type SessionStore } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Admin session, set by the global guard for every /api request. */
    auth: AuthContext | null;
  }
}

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
];
/** Prefixes with their own auth. Empty until M7 (`/api/share-gateway/`). */
export const PUBLIC_API_PREFIXES: string[] = [];

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
  opts: { sessions: SessionStore; baseUrl: string | undefined },
): void {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request, reply) => {
    const path = requestPath(request.url);
    if (!isApiPath(path)) return;

    const token = request.cookies[SESSION_COOKIE];
    request.auth = opts.sessions.resolve(token);
    if (request.auth?.touched && token) setSessionCookie(reply, token);

    if (!isPublicApiPath(path) && !request.auth) {
      return sendError(reply, 401, 'unauthorized');
    }
    if (MUTATING.has(request.method) && !originAllowed(request, opts.baseUrl)) {
      return sendError(reply, 403, 'bad_origin');
    }
  });

  app.addHook('onSend', async (request, reply) => {
    if (isApiPath(requestPath(request.url))) void reply.header('cache-control', 'no-store');
  });
}

/** preHandler for routes that need a fresh TOTP (docs/SECURITY.md, step-up). */
export function requireStepUp(now: Clock) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    const until = request.auth?.session.stepUpUntil ?? null;
    if (!request.auth || until === null || until <= now()) {
      return sendError(reply, 403, 'step_up_required');
    }
    return undefined;
  };
}

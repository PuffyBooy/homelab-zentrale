import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  WALL_COOKIE,
  okResponseSchema,
  wallDeviceCreateRequestSchema,
  wallDeviceCreateResponseSchema,
  wallDeviceLinkResponseSchema,
  wallDeviceListResponseSchema,
  wallDeviceParamsSchema,
  wallSessionRequestSchema,
  wallStateSchema,
} from '@hz/shared';
import { requireStepUp } from '../auth/guard.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { WindowLimiter } from '../share/limits.js';
import { WALL_COOKIE_MAX_AGE_MS, type WallService } from './service.js';

export interface WallRoutesOptions {
  db: Db;
  now: Clock;
  wall: WallService;
  baseUrl: string | undefined;
  port: number;
}

/** POST /api/wall/session: 10 attempts per minute and IP. */
export const WALL_SESSION_LIMIT = 10;
export const WALL_SESSION_WINDOW_MS = 60_000;

function wallCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/api/wall',
    maxAge: Math.floor(maxAgeMs / 1000),
  } as const;
}

/** The cookie carries the device session secret (never the link token). */
function setWallCookie(reply: FastifyReply, secret: string): void {
  void reply.setCookie(WALL_COOKIE, secret, wallCookieOptions(WALL_COOKIE_MAX_AGE_MS));
}

/** Base of the wall link: HZ_BASE_URL, else the Host of this (tailnet) request. */
function wallBase(request: FastifyRequest, o: WallRoutesOptions): string {
  if (o.baseUrl) return o.baseUrl.replace(/\/+$/, '');
  const host = typeof request.headers.host === 'string' ? request.headers.host : null;
  return host ? `https://${host}` : `http://127.0.0.1:${o.port}`;
}

/**
 * Wall mode (SPEC 12). Device management needs the admin session (global guard);
 * creating a device and issuing a new link need step-up (SECURITY.md: tokens).
 * `/api/wall/session` is public (rate limited) and swaps the one-time link token
 * for a device session cookie; `/api/wall/state` is the only route that accepts
 * the device cookie (DEVICE_API_ROUTES in the guard), besides the admin session.
 */
export const wallRoutes: FastifyPluginAsync<WallRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const limiter = new WindowLimiter(WALL_SESSION_LIMIT, WALL_SESSION_WINDOW_MS, o.now);
  const audit = (action: string, target: string | null, details?: Record<string, unknown>) =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, ...(details ? { details } : {}) });

  // ---- admin: devices ----------------------------------------------------------------

  app.get('/settings/wall-devices', async () =>
    wallDeviceListResponseSchema.parse({ devices: o.wall.list() }),
  );

  app.post('/settings/wall-devices', { preHandler: stepUp }, async (request) => {
    const body = wallDeviceCreateRequestSchema.parse(request.body);
    const { device, token } = o.wall.create(body.name);
    audit('wall.device_created', device.id, { name: device.name });
    // The only place the token ever appears (as URL and QR code in the web app).
    return wallDeviceCreateResponseSchema.parse({
      device,
      url: `${wallBase(request, o)}/wall?t=${token}`,
    });
  });

  app.post('/settings/wall-devices/:id/link', { preHandler: stepUp }, async (request) => {
    const { id } = wallDeviceParamsSchema.parse(request.params);
    const linked = o.wall.relink(id);
    if (!linked) throw new HttpError(404, 'not_found');
    audit('wall.device_relinked', id, { name: linked.device.name });
    return wallDeviceLinkResponseSchema.parse({
      device: linked.device,
      url: `${wallBase(request, o)}/wall?t=${linked.token}`,
    });
  });

  app.delete('/settings/wall-devices/:id', async (request) => {
    const { id } = wallDeviceParamsSchema.parse(request.params);
    const device = o.wall.get(id);
    if (!device || !o.wall.delete(id)) throw new HttpError(404, 'not_found');
    audit('wall.device_revoked', id, { name: device.name });
    return okResponseSchema.parse({ ok: true });
  });

  // ---- device ------------------------------------------------------------------------

  app.post('/wall/session', async (request, reply) => {
    const wait = limiter.hit(request.ip);
    if (wait !== null) throw new HttpError(429, 'rate_limited', wait);
    const parsed = wallSessionRequestSchema.safeParse(request.body);
    const result = parsed.success
      ? o.wall.exchange(parsed.data.token, request.cookies[WALL_COOKIE])
      : null;
    if (!parsed.success || !result) {
      writeAudit(o.db, o.now(), {
        actor: 'anonymous',
        action: 'wall.session_failed',
        details: { ip: request.ip },
      });
      if (!parsed.success) throw new HttpError(400, 'invalid_input');
      throw new HttpError(401, 'unauthorized');
    }
    if (result.kind === 'paired') {
      setWallCookie(reply, result.secret);
      writeAudit(o.db, o.now(), {
        actor: `wall:${result.id}`,
        action: 'wall.session',
        target: result.id,
        details: { ip: request.ip },
      });
    }
    // `repeat`: a kiosk reload of the used link with a valid cookie; nothing changes.
    return okResponseSchema.parse({ ok: true });
  });

  app.get('/wall/state', async (request, reply) => {
    // The guard let the request through with an admin session or a wall device.
    if (!request.auth && !request.wallDevice) throw new HttpError(401, 'unauthorized');
    if (!request.auth && request.wallDevice) {
      if (o.wall.touch(request.wallDevice)) {
        const token = request.cookies[WALL_COOKIE];
        if (token) setWallCookie(reply, token);
      }
    }
    return wallStateSchema.parse(o.wall.state());
  });
};

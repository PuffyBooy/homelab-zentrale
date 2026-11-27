import type { FastifyPluginAsync } from 'fastify';
import {
  INSTALL_SCRIPT_CONTENT_TYPE,
  INSTALL_SCRIPT_PATH,
  ONBOARDING_EXCHANGE_PATH,
  ONBOARDING_INVALID_MESSAGE,
  onboardingCreateRequestSchema,
  onboardingCreateResponseSchema,
  type OnboardingCreateResponse,
  onboardingExchangeRequestSchema,
  onboardingExchangeToEnv,
  onboardingIdParamsSchema,
  onboardingStatusResponseSchema,
  okResponseSchema,
  ONBOARDING_TTL_MINUTES,
  tailscaleSettingsRequestSchema,
  tailscaleSettingsSchema,
} from '@hz/shared';
import { requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError, sendError } from '../http/errors.js';
import {
  ExchangeLimiter,
  OnboardingError,
  withAuthKey,
  type OnboardingService,
} from './onboarding.js';
import { TailscaleError, type TailscaleJoin } from './tailscale.js';

export interface OnboardingRoutesOptions {
  db: Db;
  now: Clock;
  onboarding: OnboardingService;
  tailscale: TailscaleJoin;
}

const NOT_CONFIGURED_MESSAGE =
  'HZ_BASE_URL fehlt: die https-Adresse der Zentrale im Tailnet setzen.';
const TOO_MANY_MESSAGE = 'Zu viele offene Codes. Einen davon abbrechen oder ablaufen lassen.';

/**
 * Admin routes (prefix /api, session; create also step-up) and the public
 * exchange POST /api/onboarding/exchange (no session, own rate limit).
 */
export const onboardingRoutes: FastifyPluginAsync<OnboardingRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const limiter = new ExchangeLimiter(o.now);
  /** Onboarding id -> id of its unused Tailscale key (revoked on cancel; in memory). */
  const pendingKeys = new Map<string, string>();

  app.post('/servers/onboarding', { preHandler: stepUp }, async (request, reply) => {
    const body = onboardingCreateRequestSchema.parse(request.body);
    if (pendingKeys.size > 100) pendingKeys.clear();
    let created: OnboardingCreateResponse;
    try {
      created = o.onboarding.create(body.name, body.location);
    } catch (err) {
      if (!(err instanceof OnboardingError)) throw err;
      if (err.reason === 'name_taken') throw new HttpError(409, 'conflict');
      if (err.reason === 'too_many')
        throw new HttpError(409, 'conflict', undefined, TOO_MANY_MESSAGE);
      throw new HttpError(409, 'conflict', undefined, NOT_CONFIGURED_MESSAGE);
    }
    // M11b: a single-use Tailscale auth key for exactly this onboarding (never stored).
    const hub = o.onboarding.hub();
    if (hub && o.tailscale.configured()) {
      try {
        const key = await o.tailscale.mint(body.name, ONBOARDING_TTL_MINUTES * 60);
        if (key) {
          created = withAuthKey(created, hub.origin, key.key);
          pendingKeys.set(created.id, key.id);
        }
      } catch (err) {
        if (!(err instanceof TailscaleError)) throw err;
        created = { ...created, tailscaleNote: `Tailscale-Schlüssel ging nicht: ${err.text}` };
      }
    }
    writeAudit(o.db, o.now(), {
      actor: 'admin',
      action: 'server.onboarding_created',
      target: created.id,
      details: { name: body.name, location: body.location, tailscale: created.tailscale },
    });
    return reply.code(201).send(onboardingCreateResponseSchema.parse(created));
  });

  app.get('/tailscale', async () => tailscaleSettingsSchema.parse(o.tailscale.view()));

  app.put('/tailscale', { preHandler: stepUp }, async (request) => {
    const body = tailscaleSettingsRequestSchema.parse(request.body);
    const fields = o.tailscale.update(body);
    writeAudit(o.db, o.now(), {
      actor: 'admin',
      action: 'tailscale.settings_changed',
      details: { fields },
    });
    // Check right away, so the tile shows whether minting works.
    return tailscaleSettingsSchema.parse(await o.tailscale.test());
  });

  app.post('/tailscale/test', async () => tailscaleSettingsSchema.parse(await o.tailscale.test()));

  app.delete('/tailscale', { preHandler: stepUp }, async () => {
    o.tailscale.clear();
    writeAudit(o.db, o.now(), { actor: 'admin', action: 'tailscale.settings_cleared' });
    return tailscaleSettingsSchema.parse(o.tailscale.view());
  });

  app.get('/servers/onboarding/:id', async (request) => {
    const { id } = onboardingIdParamsSchema.parse(request.params);
    const status = o.onboarding.status(id);
    if (!status) throw new HttpError(404, 'not_found');
    return onboardingStatusResponseSchema.parse(status);
  });

  app.delete('/servers/onboarding/:id', async (request) => {
    const { id } = onboardingIdParamsSchema.parse(request.params);
    const r = o.onboarding.cancel(id);
    if (r === null) throw new HttpError(404, 'not_found');
    if (r === 'connected') throw new HttpError(409, 'conflict');
    const keyId = pendingKeys.get(id);
    pendingKeys.delete(id);
    if (keyId && r === 'waiting') void o.tailscale.revoke(keyId);
    if (r === 'waiting' || r === 'installing') {
      writeAudit(o.db, o.now(), {
        actor: 'admin',
        action: 'server.onboarding_cancelled',
        target: id,
        details: { state: r },
      });
    }
    return okResponseSchema.parse({ ok: true });
  });

  // Public (guard: PUBLIC_API_ROUTES). Neither the code nor the token is ever
  // logged: Fastify does not log bodies, and this handler logs neither.
  app.post(ONBOARDING_EXCHANGE_PATH.replace(/^\/api/, ''), async (request, reply) => {
    const wait = limiter.attempt(request.ip);
    if (wait > 0) return sendError(reply, 429, 'rate_limited', wait);
    const parsed = onboardingExchangeRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'invalid_input');
    const result = o.onboarding.exchange(parsed.data.code);
    if (!result.ok) {
      limiter.failure();
      writeAudit(o.db, o.now(), {
        actor: 'anonymous',
        action: 'server.onboarding_refused',
        details: { ip: request.ip },
      });
      return sendError(reply, 400, 'invalid_credentials', undefined, ONBOARDING_INVALID_MESSAGE);
    }
    writeAudit(o.db, o.now(), {
      actor: 'anonymous',
      action: 'server.onboarding_exchanged',
      target: result.id,
      details: { name: result.response.name, ip: request.ip },
    });
    request.log.info({ onboarding: result.id }, 'onboarding code exchanged');
    return reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(onboardingExchangeToEnv(result.response));
  });
};

/** GET /install.sh (root prefix, outside /api, no session). */
export const installScriptRoutes: FastifyPluginAsync<{ onboarding: OnboardingService }> = async (
  app,
  o,
) => {
  app.get(INSTALL_SCRIPT_PATH, async (_request, reply) => {
    const script = o.onboarding.installScript();
    if (script === null) return sendError(reply, 404, 'not_found');
    return reply
      .type(INSTALL_SCRIPT_CONTENT_TYPE)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(script);
  });
};

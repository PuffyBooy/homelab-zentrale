import type { FastifyPluginAsync } from 'fastify';
import {
  notifyChannelParamsSchema,
  notifyChannelSchema,
  notifyChannelsResponseSchema,
  notifyChannelUpdateNeedsStepUp,
  notifyChannelUpdateRequestSchema,
  okResponseSchema,
} from '@hz/shared';
import { hasStepUp, requireStepUp } from '../auth/index.js';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { WindowLimiter } from '../share/limits.js';
import type { NotifyService } from './service.js';

/** Test messages per minute (all channels together). */
export const NOTIFY_TESTS_PER_MIN = 5;

export interface NotifyRoutesOptions {
  db: Db;
  now: Clock;
  notify: NotifyService;
}

/**
 * /api/notify/channels* (SPEC 9/16). Admin session everywhere (global guard).
 * Step-up for every change of a secret or the ntfy server and for DELETE.
 * Responses only say `configured` / `tokenSet`, never a secret.
 */
export const notifyRoutes: FastifyPluginAsync<NotifyRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  const testLimiter = new WindowLimiter(NOTIFY_TESTS_PER_MIN, 60_000, o.now);
  const audit = (action: string, target: string, details?: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, ...(details ? { details } : {}) });

  app.get('/notify/channels', async () =>
    notifyChannelsResponseSchema.parse({ channels: o.notify.list() }),
  );

  app.put('/notify/channels/:id', async (request) => {
    const { id } = notifyChannelParamsSchema.parse(request.params);
    const body = notifyChannelUpdateRequestSchema.parse(request.body);
    if (notifyChannelUpdateNeedsStepUp(body) && !hasStepUp(request, o.now)) {
      throw new HttpError(403, 'step_up_required');
    }
    const r = o.notify.update(id, body);
    audit('notify.channel_updated', id, {
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.minLevel !== undefined ? { minLevel: body.minLevel } : {}),
      secretsChanged: r.secretsChanged,
      dropped: r.dropped,
      serverChanged: r.serverChanged,
    });
    return notifyChannelSchema.parse(r.channel);
  });

  app.delete('/notify/channels/:id', { preHandler: stepUp }, async (request) => {
    const { id } = notifyChannelParamsSchema.parse(request.params);
    o.notify.remove(id);
    audit('notify.channel_removed', id);
    return okResponseSchema.parse({ ok: true });
  });

  app.post('/notify/channels/:id/test', async (request) => {
    const { id } = notifyChannelParamsSchema.parse(request.params);
    const wait = testLimiter.hit('test');
    if (wait !== null) throw new HttpError(429, 'rate_limited', wait);
    try {
      await o.notify.test(id);
    } catch (err) {
      audit('notify.channel_tested', id, { ok: false });
      throw err;
    }
    audit('notify.channel_tested', id, { ok: true });
    return okResponseSchema.parse({ ok: true });
  });
};

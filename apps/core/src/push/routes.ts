import type { FastifyPluginAsync } from 'fastify';
import {
  notifySettingsPatchSchema,
  notifySettingsSchema,
  okResponseSchema,
  pushDeviceIdParamsSchema,
  pushDeviceListResponseSchema,
  pushDeviceResponseSchema,
  pushSubscribeRequestSchema,
  pushTestResponseSchema,
  vapidResponseSchema,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';
import { subscriptionKeysValid, type PushService } from './service.js';
import { patchNotifySettings, readNotifySettings } from './settings.js';

export interface PushRoutesOptions {
  db: Db;
  now: Clock;
  push: PushService;
}

export const pushRoutes: FastifyPluginAsync<PushRoutesOptions> = async (app, o) => {
  const audit = (action: string, target: string | null, details?: Record<string, unknown>): void =>
    writeAudit(o.db, o.now(), { actor: 'admin', action, target, ...(details ? { details } : {}) });

  // The public key is not a secret; the private key never leaves PushService.
  app.get('/push/vapid', async () => vapidResponseSchema.parse({ publicKey: o.push.publicKey }));

  app.get('/push/subscriptions', async () =>
    pushDeviceListResponseSchema.parse({ devices: o.push.list() }),
  );

  app.post('/push/subscriptions', async (request) => {
    const { subscription, label } = pushSubscribeRequestSchema.parse(request.body);
    if (!subscriptionKeysValid(subscription.keys)) throw new HttpError(400, 'invalid_input');
    const device = o.push.subscribe(subscription, label);
    audit('push.subscribed', device.id, { host: device.endpointHost, label: device.label });
    return pushDeviceResponseSchema.parse({ device });
  });

  app.delete('/push/subscriptions/:id', async (request) => {
    const { id } = pushDeviceIdParamsSchema.parse(request.params);
    if (!o.push.remove(id)) throw new HttpError(404, 'not_found');
    audit('push.unsubscribed', id);
    return okResponseSchema.parse({ ok: true });
  });

  app.post('/push/test', async () => {
    const sent = await o.push.sendAll({
      title: 'Testnachricht',
      body: 'Push funktioniert. So sehen Meldungen der Homelab-Zentrale aus.',
      level: 'info',
      url: '/settings',
      tag: 'test',
    });
    audit('push.test', null, { sent });
    return pushTestResponseSchema.parse({ ok: true, sent });
  });

  app.get('/settings/notify', async () => notifySettingsSchema.parse(readNotifySettings(o.db)));

  app.patch('/settings/notify', async (request) => {
    const patch = notifySettingsPatchSchema.parse(request.body ?? {});
    const next = patchNotifySettings(o.db, patch, o.now());
    audit('settings.notify', null, { ...patch });
    return notifySettingsSchema.parse(next);
  });
};

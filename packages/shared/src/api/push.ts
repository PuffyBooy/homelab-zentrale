import { z } from 'zod';

/** Browser PushSubscription.toJSON() */
export const pushSubscriptionSchema = z.strictObject({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  }),
});
export type PushSubscriptionJson = z.infer<typeof pushSubscriptionSchema>;

// GET /api/push/vapid -> public key (not a secret)
export const vapidResponseSchema = z.strictObject({ publicKey: z.string().nullable() });

// POST /api/push/subscriptions
export const pushSubscribeRequestSchema = z.strictObject({
  subscription: pushSubscriptionSchema,
  label: z.string().trim().max(60).default(''),
});
export const pushDeviceSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  /** Only the host of the endpoint, e.g. "fcm.googleapis.com". */
  endpointHost: z.string(),
  createdAt: z.iso.datetime(),
  lastOkAt: z.iso.datetime().nullable(),
});
// POST /api/push/subscriptions -> the stored device (same endpoint again updates it)
export const pushDeviceResponseSchema = z.strictObject({ device: pushDeviceSchema });
export const pushDeviceIdParamsSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});
export const pushDeviceListResponseSchema = z.strictObject({ devices: z.array(pushDeviceSchema) });
// DELETE /api/push/subscriptions/:id, POST /api/push/test -> { ok, sent }
export const pushTestResponseSchema = z.strictObject({
  ok: z.literal(true),
  sent: z.number().int(),
});

/** Notification settings (SPEC 9). Times in Europe/Vienna, "HH:MM". */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const notifySettingsSchema = z.strictObject({
  quietStart: hhmm.default('23:00'),
  quietEnd: hhmm.default('07:00'),
  /** warn pushes are bundled, at most one per this many minutes. */
  warnBundleMinutes: z.number().int().min(5).max(240).default(30),
  weeklyReport: z.boolean().default(true),
});
export type NotifySettings = z.infer<typeof notifySettingsSchema>;
export const notifySettingsPatchSchema = z.strictObject({
  quietStart: hhmm.optional(),
  quietEnd: hhmm.optional(),
  warnBundleMinutes: z.number().int().min(5).max(240).optional(),
  weeklyReport: z.boolean().optional(),
});

/** Payload the service worker receives (same text as the alert). */
export const pushPayloadSchema = z.strictObject({
  title: z.string().max(200),
  body: z.string().max(1000),
  level: z.enum(['ok', 'info', 'warn', 'crit']),
  /** Path inside the app, e.g. /alerts. */
  url: z.string().startsWith('/').max(200),
  tag: z.string().max(200),
});
export type PushPayload = z.infer<typeof pushPayloadSchema>;

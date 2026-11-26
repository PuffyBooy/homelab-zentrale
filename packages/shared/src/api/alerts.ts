import { z } from 'zod';

export const alertLevelSchema = z.enum(['ok', 'info', 'warn', 'crit']);
export type AlertLevel = z.infer<typeof alertLevelSchema>;
export const alertStateSchema = z.enum(['open', 'acked', 'resolved']);
export type AlertState = z.infer<typeof alertStateSchema>;
export const alertSourceSchema = z.enum([
  'server',
  'container',
  'check',
  'github',
  'game',
  'ha',
  'system',
]);
export type AlertSource = z.infer<typeof alertSourceSchema>;

export const alertSchema = z.strictObject({
  id: z.string(),
  /** Dedupe key, e.g. "server:<id>:offline". One open alert per key. */
  key: z.string(),
  level: alertLevelSchema,
  /** Was + Wo, e.g. "oracle-a1 ist offline". */
  title: z.string(),
  /** Seit wann + was hilft. */
  body: z.string(),
  serverId: z.string().nullable(),
  source: alertSourceSchema,
  state: alertStateSchema,
  openedAt: z.iso.datetime(),
  ackedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type Alert = z.infer<typeof alertSchema>;

// GET /api/alerts?state=&level=&serverId=&limit=
export const alertListQuerySchema = z.strictObject({
  state: z.enum(['open', 'acked', 'resolved', 'active', 'all']).default('active'),
  level: alertLevelSchema.optional(),
  serverId: z.string().max(64).optional(),
  source: alertSourceSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const alertListResponseSchema = z.strictObject({ alerts: z.array(alertSchema) });
export type AlertListResponse = z.infer<typeof alertListResponseSchema>;
export const alertIdParamsSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});
// POST /api/alerts/:id/ack, POST /api/alerts/:id/resolve -> { alert }
export const alertResponseSchema = z.strictObject({ alert: alertSchema });

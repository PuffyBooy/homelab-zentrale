import { z } from 'zod';

/** GET /api/health. Public, so it must never carry internal details. */
export const healthResponseSchema = z.strictObject({ ok: z.literal(true) });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

import { z } from 'zod';
import { alertSchema } from './api/alerts.js';
import { serverDetailSchema, serverSummarySchema } from './api/servers.js';

/**
 * Browser <-> core live channel, wss://<core>/live (session cookie + Origin check).
 * The client subscribes to topics. The core first sends a snapshot, then updates.
 * `update` carries full items (upsert by id) or removals; no JSON patches.
 */
export const liveTopicSchema = z.union([
  z.enum(['servers', 'containers', 'games', 'checks', 'alerts', 'github', 'ha']),
  z.string().regex(/^(server|container-logs|deploy|game):[A-Za-z0-9_-]{1,64}$/),
]);
export type LiveTopic = z.infer<typeof liveTopicSchema>;

export const liveClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('subscribe'), topics: z.array(liveTopicSchema).min(1).max(20) }),
  z.strictObject({
    type: z.literal('unsubscribe'),
    topics: z.array(liveTopicSchema).min(1).max(20),
  }),
  z.strictObject({ type: z.literal('ping') }),
]);
export type LiveClientMessage = z.infer<typeof liveClientMessageSchema>;

export const liveServerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('snapshot'), topic: z.string(), data: z.unknown() }),
  z.strictObject({
    type: z.literal('update'),
    topic: z.string(),
    upsert: z.array(z.unknown()).optional(),
    remove: z.array(z.string()).optional(),
  }),
  z.strictObject({ type: z.literal('pong') }),
  z.strictObject({
    type: z.literal('error'),
    code: z.enum(['invalid', 'forbidden', 'unknown_topic']),
  }),
]);
export type LiveServerMessage = z.infer<typeof liveServerMessageSchema>;

/** Data per topic: snapshot is the full list, upsert items have the same shape. */
export const liveTopicItemSchemas = {
  servers: serverSummarySchema,
  alerts: alertSchema,
} as const;

/**
 * Topic `server:<id>`: the snapshot `data` is one ServerDetail (not a list).
 * Each update carries the full new detail as the only `upsert` item. When the
 * server is deleted, the update is `remove: [<id>]`.
 */
export const liveServerTopicItemSchema = serverDetailSchema;

/** Close codes of the live socket. */
export const LIVE_CLOSE_SESSION_ENDED = 4001;

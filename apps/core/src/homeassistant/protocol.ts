import { z } from 'zod';
import { haEntityIdSchema } from '@hz/shared';

/**
 * Home Assistant WebSocket API (https://developers.home-assistant.io/docs/api/websocket),
 * only the messages the core uses. Every incoming frame is checked with these
 * schemas; anything else is dropped. Strings are clipped so a misbehaving HA
 * cannot blow up our state or responses.
 */

const clip = (max: number) => z.string().transform((s) => s.slice(0, max));

export const haAuthMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth_required'), ha_version: clip(40).optional() }),
  z.object({ type: z.literal('auth_ok'), ha_version: clip(40).optional() }),
  z.object({ type: z.literal('auth_invalid') }),
]);

export const haResultMessageSchema = z.object({
  id: z.number().int(),
  type: z.literal('result'),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: clip(60).catch('unknown') }).optional(),
});

export const haEventMessageSchema = z.object({
  id: z.number().int(),
  type: z.literal('event'),
  event: z.unknown(),
});

export const haPongMessageSchema = z.object({ id: z.number().int(), type: z.literal('pong') });

/** Projection of an HA state object; only the attributes the core shows. */
export interface HaEntityState {
  entityId: string;
  state: string;
  friendlyName: string | null;
  unit: string | null;
  deviceClass: string | null;
  /** climate: attributes.current_temperature. */
  currentTemperature: number | null;
  supportedFeatures: number;
  /** ISO (UTC) or null. */
  lastChanged: string | null;
}

const optString = (max: number) =>
  z
    .unknown()
    .transform((v) => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null))
    .optional();

const isoOrNull = z
  .unknown()
  .transform((v) => {
    if (typeof v !== 'string') return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  })
  .optional();

const rawStateSchema = z.object({
  entity_id: haEntityIdSchema,
  state: clip(255),
  attributes: z
    .object({
      friendly_name: optString(200),
      unit_of_measurement: optString(40),
      device_class: optString(60),
      current_temperature: z.unknown().optional(),
      supported_features: z.unknown().optional(),
    })
    .catch({}),
  last_changed: isoOrNull,
});

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parses one HA state object; null if it is not usable (e.g. odd entity id). */
export function parseHaState(raw: unknown): HaEntityState | null {
  const p = rawStateSchema.safeParse(raw);
  if (!p.success) return null;
  const a = p.data.attributes;
  const features = finite(a.supported_features);
  return {
    entityId: p.data.entity_id,
    state: p.data.state,
    friendlyName: a.friendly_name ?? null,
    unit: a.unit_of_measurement ?? null,
    deviceClass: a.device_class ?? null,
    currentTemperature: finite(a.current_temperature),
    supportedFeatures: features !== null && Number.isInteger(features) ? features : 0,
    lastChanged: p.data.last_changed ?? null,
  };
}

/** `state_changed` event data: entity id and the new state (null: removed). */
export const haStateChangedEventSchema = z.object({
  event_type: z.literal('state_changed'),
  data: z.object({
    entity_id: z.string().max(255),
    new_state: z.unknown().nullable().optional(),
  }),
});

export const haAreaListSchema = z
  .array(z.object({ area_id: z.string().max(200), name: clip(100) }))
  .max(10_000);

/** config/entity_registry/list_for_display (compact keys). */
export const haEntityDisplayListSchema = z.object({
  entities: z
    .array(
      z.object({
        ei: z.string().max(255),
        ai: z.string().max(200).nullable().optional(),
        di: z.string().max(200).nullable().optional(),
      }),
    )
    .max(50_000),
});

/** config/entity_registry/list (fallback for older HA). */
export const haEntityRegistryListSchema = z
  .array(
    z.object({
      entity_id: z.string().max(255),
      area_id: z.string().max(200).nullable().optional(),
      device_id: z.string().max(200).nullable().optional(),
    }),
  )
  .max(50_000);

export const haDeviceRegistryListSchema = z
  .array(z.object({ id: z.string().max(200), area_id: z.string().max(200).nullable().optional() }))
  .max(50_000);

/**
 * `<url>/api/websocket` with ws/wss. A path prefix of the URL (reverse proxy)
 * is kept, trailing slashes are dropped.
 */
export function haWebSocketUrl(url: string): string {
  const u = new URL(url);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/api/websocket`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

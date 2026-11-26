import { z } from 'zod';

/**
 * Home Assistant (SPEC 10). The core keeps one WebSocket connection to HA
 * (URL + long-lived access token, token AES-GCM encrypted in `settings`).
 * Only entities the admin selected appear and can be controlled; the core calls a
 * fixed set of services per kind and domain, never an arbitrary service.
 *
 * Kinds:
 * - toggle: light, switch, fan, input_boolean → `<domain>.turn_on|turn_off`
 * - metric: sensor, binary_sensor, climate (current_temperature) → read only
 * - button: door opener / intercom (BTicino, Shelly). Never a toggle. Needs
 *   `confirm: true` in the request and a step-up session (a stolen session
 *   must not open the front door). button → `button.press`, lock → `lock.open`
 *   (only locks with the OPEN feature, `supported_features & 1`; others are
 *   refused with 409 "Schloss kann nur auf-/zusperren", never `lock.unlock`),
 *   switch → `switch.turn_on` (Shelly with auto-off), script → `script.turn_on`.
 *
 * `switch` is both a toggle and a button domain, so the kind itself is
 * security relevant: PUT /api/ha/config needs step-up when it adds a `switch.*`
 * entity, adds a `button` entity or changes the kind of any entity
 * (`haConfigNeedsStepUp`). Otherwise a stolen session could turn the door
 * opener `switch.haustuer` into a toggle and open the door without step-up.
 */

/** "light.wohnzimmer", "sensor.strom_leistung". */
export const haEntityIdSchema = z
  .string()
  .max(255)
  .regex(/^[a-z_]+\.[a-z0-9_]+$/);
export const haEntityParamsSchema = z.strictObject({ entityId: haEntityIdSchema });

export const haKindSchema = z.enum(['toggle', 'metric', 'button']);
export type HaKind = z.infer<typeof haKindSchema>;

export const HA_TOGGLE_DOMAINS = ['light', 'switch', 'fan', 'input_boolean'] as const;
export const HA_METRIC_DOMAINS = ['sensor', 'binary_sensor', 'climate'] as const;
export const HA_BUTTON_DOMAINS = ['button', 'lock', 'switch', 'script'] as const;

/** Domain of an entity id ("light.x" → "light"). */
export function haDomain(entityId: string): string {
  return entityId.slice(0, entityId.indexOf('.'));
}

/** Whether a kind may be used for this entity (checked by core and web). */
export function haKindAllowed(kind: HaKind, entityId: string): boolean {
  const d = haDomain(entityId);
  const list: readonly string[] =
    kind === 'toggle'
      ? HA_TOGGLE_DOMAINS
      : kind === 'metric'
        ? HA_METRIC_DOMAINS
        : HA_BUTTON_DOMAINS;
  return list.includes(d);
}

export const haConnectionStatusSchema = z.enum([
  /** No URL or token set. */
  'off',
  'connecting',
  'connected',
  /** "Home Assistant nicht erreichbar" (also wrong token: see `error`). */
  'unreachable',
]);

// ---- settings ---------------------------------------------------------------------

// GET /api/ha/settings
export const haSettingsSchema = z.strictObject({
  /** e.g. "http://192.0.2.20:8123" or "https://ha.<tailnet>.ts.net". */
  url: z.string().nullable(),
  tokenSet: z.boolean(),
  status: haConnectionStatusSchema,
  /** Short German reason, e.g. "Token ungültig", "Nicht erreichbar (Zeitüberschreitung)". */
  error: z.string().nullable(),
  haVersion: z.string().nullable(),
  lastConnectedAt: z.iso.datetime().nullable(),
  /** € per kWh for the cost estimate, e.g. 0.25. */
  pricePerKwh: z.number().min(0).max(5),
  /** Total energy sensor (kWh, state_class total_increasing) for "kWh im Monat". */
  energyEntityId: haEntityIdSchema.nullable(),
  /** Current power sensor (W). */
  powerEntityId: haEntityIdSchema.nullable(),
});
export type HaSettings = z.infer<typeof haSettingsSchema>;

/**
 * Link-local addresses (169.254.0.0/16, fe80::/10, also IPv4-mapped) are cloud
 * metadata endpoints, never Home Assistant. Loopback stays allowed (HA may run
 * on the same host). The URL parser already normalises odd IPv4 forms
 * ("2852039166", "0xa9.254.169.254") to dotted decimal.
 */
export function haUrlIsLinkLocal(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1);
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;
    // ::ffff:169.254.x.x is normalised to ::ffff:a9fe:xxxx.
    if (v6.startsWith('::ffff:a9fe:')) return true;
  }
  return false;
}

/** Plain http is fine for HA in the LAN or tailnet; no credentials in the URL. */
export const haUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(200)
  .refine(
    (u) => {
      const p = new URL(u);
      return p.username === '' && p.password === '' && p.search === '' && p.hash === '';
    },
    { message: 'URL ohne Benutzer, Query oder Anker' },
  )
  .refine((u) => !haUrlIsLinkLocal(u), { message: 'Link-lokale Adressen sind nicht erlaubt' });

// PUT /api/ha/settings (step-up when url or token changes) -> haSettingsSchema
export const haSettingsRequestSchema = z.strictObject({
  url: haUrlSchema.optional(),
  /** Long-lived access token (JWT, about 180 chars). Omitted: keep the stored one. */
  token: z
    .string()
    .trim()
    .min(20)
    .max(1000)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
  pricePerKwh: z.number().min(0).max(5).optional(),
  energyEntityId: haEntityIdSchema.nullable().optional(),
  powerEntityId: haEntityIdSchema.nullable().optional(),
});
// DELETE /api/ha/token (step-up): disconnect and forget the token.

// ---- entity selection ------------------------------------------------------------------

// GET /api/ha/available -> all entities HA knows (for the picker in the settings)
export const haAvailableEntitySchema = z.strictObject({
  entityId: haEntityIdSchema,
  /** friendly_name, or the entity id. */
  name: z.string().max(200),
  state: z.string().max(255),
  unit: z.string().max(40).nullable(),
  deviceClass: z.string().max(60).nullable(),
  /** HA area name if the registry has one ("Wohnzimmer"). */
  area: z.string().max(100).nullable(),
  /** Kinds the core allows for this domain. */
  kinds: z.array(haKindSchema),
});
export const haAvailableResponseSchema = z.strictObject({
  entities: z.array(haAvailableEntitySchema).max(5000),
});

const roomIdSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);

export const haRoomSchema = z.strictObject({
  id: roomIdSchema,
  name: z.string().trim().min(1).max(40),
});

export const haEntityConfigSchema = z.strictObject({
  entityId: haEntityIdSchema,
  kind: haKindSchema,
  /** null: "Ohne Raum". */
  roomId: roomIdSchema.nullable(),
  /** Own label; null: HA friendly_name. */
  label: z.string().trim().min(1).max(60).nullable(),
  /** Shown in the "Wohnung" tile on the overview (wichtigste Schalter). */
  overview: z.boolean(),
});

// GET /api/ha/config, PUT /api/ha/config (full replace) -> haConfigSchema
export const haConfigSchema = z
  .strictObject({
    rooms: z.array(haRoomSchema).max(30),
    /** Order of the array is the display order. */
    entities: z.array(haEntityConfigSchema).max(200),
  })
  .superRefine((c, ctx) => {
    const rooms = new Set<string>();
    for (const r of c.rooms) {
      if (rooms.has(r.id)) ctx.addIssue({ code: 'custom', message: `duplicate room ${r.id}` });
      rooms.add(r.id);
    }
    const seen = new Set<string>();
    for (const e of c.entities) {
      if (seen.has(e.entityId))
        ctx.addIssue({ code: 'custom', message: `duplicate entity ${e.entityId}` });
      seen.add(e.entityId);
      if (e.roomId !== null && !rooms.has(e.roomId))
        ctx.addIssue({ code: 'custom', message: `unknown room ${e.roomId}` });
      if (!haKindAllowed(e.kind, e.entityId))
        ctx.addIssue({ code: 'custom', message: `${e.kind} not allowed for ${e.entityId}` });
    }
  });
export type HaConfig = z.infer<typeof haConfigSchema>;

/**
 * Whether replacing `prev` by `next` needs a step-up session: a new `switch.*`
 * entity, a new `button` entity, or any entity whose kind changes. Renames,
 * rooms, order, overview flags and removals stay without step-up.
 */
export function haConfigNeedsStepUp(
  prev: Pick<HaConfig, 'entities'>,
  next: Pick<HaConfig, 'entities'>,
): boolean {
  const before = new Map(prev.entities.map((e) => [e.entityId, e.kind]));
  for (const e of next.entities) {
    const kind = before.get(e.entityId);
    if (kind === undefined) {
      if (e.kind === 'button' || haDomain(e.entityId) === 'switch') return true;
    } else if (kind !== e.kind) {
      return true;
    }
  }
  return false;
}

// ---- live state (topic `ha`) and actions ------------------------------------------------

export const haItemSchema = z.strictObject({
  entityId: haEntityIdSchema,
  kind: haKindSchema,
  roomId: roomIdSchema.nullable(),
  /** Own label or friendly_name. */
  label: z.string(),
  overview: z.boolean(),
  /** Raw HA state ("on", "off", "21.5", "unavailable"). */
  state: z.string().max(255),
  /** Numeric state (or climate current_temperature) when it parses; null otherwise. */
  value: z.number().nullable(),
  unit: z.string().max(40).nullable(),
  deviceClass: z.string().max(60).nullable(),
  /** false for "unavailable"/"unknown" or when HA is not connected. */
  available: z.boolean(),
  lastChanged: z.iso.datetime().nullable(),
  /** A toggle/press is running (until HA reports the new state or 10 s pass). */
  pending: z.boolean(),
});
export type HaItem = z.infer<typeof haItemSchema>;

export const haEnergySchema = z.strictObject({
  powerW: z.number().nullable(),
  /** kWh since the 1st of this month 00:00 (Vienna). */
  monthKwh: z.number().nullable(),
  /** monthKwh × pricePerKwh, rounded to cents. */
  monthEur: z.number().nullable(),
  pricePerKwh: z.number(),
});

/** Snapshot of topic `ha` and GET /api/ha/state. Patches are full snapshots too. */
export const haStateSchema = z.strictObject({
  status: haConnectionStatusSchema,
  error: z.string().nullable(),
  rooms: z.array(haRoomSchema),
  items: z.array(haItemSchema),
  energy: haEnergySchema.nullable(),
  updatedAt: z.iso.datetime(),
});
export type HaState = z.infer<typeof haStateSchema>;

// POST /api/ha/entities/:entityId/toggle { on } -> { item }  (kind toggle only)
export const haToggleRequestSchema = z.strictObject({ on: z.boolean() });
// POST /api/ha/entities/:entityId/press { confirm: true } -> { item }  (kind button, step-up)
export const haPressRequestSchema = z.strictObject({ confirm: z.literal(true) });
export const haItemResponseSchema = z.strictObject({ item: haItemSchema });

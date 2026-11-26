import { z } from 'zod';
import { prioritySchema, throttledSchema } from './throttle.js';

/**
 * Game servers (SPEC 6.2/6.3). Templates live in templates/games/<id>/ with a
 * template.json (this schema) and a compose.yml with ${VAR} placeholders.
 * Game folders are /opt/homelab/games/<name>/; secrets (RCON password) go into
 * a 0600 `.env` next to compose.yml, never into compose.yml or a response.
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const gameIdParamsSchema = z.strictObject({ id: idSchema });

/** Folder and container name: lower case, digits, dash; 2–32 chars. */
export const gameNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/, {
    message: 'Nur Kleinbuchstaben, Ziffern und Bindestrich (2–32 Zeichen).',
  });

const ramSchema = z.string().regex(/^\d{1,3}G$/);
const envKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const portProtocolSchema = z.enum(['tcp', 'udp', 'tcp+udp']);

export const templateFieldSchema = z.discriminatedUnion('type', [
  z.strictObject({
    key: envKeySchema,
    label: z.string().max(80),
    type: z.literal('text'),
    default: z.string().max(200),
    optional: z.boolean().optional(),
    /** Optional regex the value must match (anchored by the core). */
    pattern: z.string().max(200).optional(),
    secret: z.boolean().optional(),
  }),
  z.strictObject({
    key: envKeySchema,
    label: z.string().max(80),
    type: z.literal('number'),
    default: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
    optional: z.boolean().optional(),
  }),
  z.strictObject({
    key: envKeySchema,
    label: z.string().max(80),
    type: z.literal('select'),
    options: z.array(z.string().max(60)).min(1).max(50),
    default: z.string().max(60),
    optional: z.boolean().optional(),
  }),
  z.strictObject({
    key: envKeySchema,
    label: z.string().max(80),
    type: z.literal('boolean'),
    default: z.boolean(),
    optional: z.boolean().optional(),
  }),
]);
export type TemplateField = z.infer<typeof templateFieldSchema>;

export const queryMethodSchema = z.enum(['minecraft', 'minecraft-bedrock', 'gamedig', 'none']);

/** template.json */
export const gameTemplateSchema = z.strictObject({
  $schema: z.string().optional(),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  name: z.string().max(80),
  image: z.string().max(200),
  ram: z.strictObject({ min: ramSchema, recommended: ramSchema }),
  ports: z
    .array(
      z.strictObject({
        /** PORT_<NAME> in compose.yml. */
        name: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
        container: z.number().int().min(1).max(65535),
        protocol: portProtocolSchema,
        default: z.number().int().min(1024).max(65535),
        /** Consecutive ports from `default` (Valheim: 3). */
        count: z.number().int().min(1).max(10).default(1),
        /** Bound to 127.0.0.1 only (e.g. Palworld REST API): no forwarding hint, not in the address. */
        local: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(5),
  query: z.strictObject({
    method: queryMethodSchema,
    /** Port name from `ports`. */
    port: z.string().optional(),
    /** GameDig game type (allowlist, enforced by the agent too). */
    type: z.enum(['valheim', 'counterstrike2', 'palworld']).optional(),
  }),
  rcon: z.strictObject({
    supported: z.boolean(),
    /** Container port of RCON; published only on 127.0.0.1. */
    port: z.number().int().min(1).max(65535).optional(),
    /** Command that answers with TPS (Paper: "tps"). */
    tpsCommand: z.string().max(40).optional(),
  }),
  /** World data, relative to the game folder; backed up by game.backup. */
  dataDir: z.string().regex(/^\.\/[A-Za-z0-9._/-]+$/),
  fields: z.array(templateFieldSchema).max(30),
});
export type GameTemplate = z.infer<typeof gameTemplateSchema>;

// GET /api/games/templates
export const gameTemplateListResponseSchema = z.strictObject({
  templates: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      image: z.string(),
      ram: z.strictObject({ min: ramSchema, recommended: ramSchema }),
      ports: z.array(
        z.strictObject({
          name: z.string(),
          protocol: portProtocolSchema,
          default: z.number().int(),
          count: z.number().int(),
          local: z.boolean(),
        }),
      ),
      rcon: z.boolean(),
      fields: z.array(templateFieldSchema),
    }),
  ),
});

// GET /api/games/suggest?templateId=&serverId= -> free ports and RAM check
export const gameSuggestQuerySchema = z.strictObject({
  templateId: z.string().max(40),
  serverId: z.string().max(64),
});
export const gameSuggestResponseSchema = z.strictObject({
  /** First free port per template port name (from the agent's listening ports and other games). */
  ports: z.record(z.string(), z.number().int()),
  freeRamBytes: z.number().nullable(),
  /** German warning, e.g. "Zu wenig RAM frei (2,1 GB frei, 4 GB empfohlen)". */
  ramWarning: z.string().nullable(),
  /**
   * M10: RAM kept free for `wichtig` containers on the server (bytes), null while
   * RAM is unknown. A start needs RAM limit <= freeRamBytes - ramReserveBytes.
   */
  ramReserveBytes: z.number().nonnegative().nullable().optional(),
});

const fieldValueSchema = z.union([z.string().max(200), z.number(), z.boolean()]);

// POST /api/games -> 202 { game } (setup runs, progress on topic game:<id>)
export const gameCreateRequestSchema = z.strictObject({
  templateId: z.string().max(40),
  serverId: z.string().min(1).max(64),
  name: gameNameSchema,
  /** Values for template fields by key. Unknown keys are rejected by the core. */
  values: z.record(envKeySchema, fieldValueSchema),
  /** Port per template port name; default: the suggestion. */
  ports: z.record(z.string(), z.number().int().min(1024).max(65535)).optional(),
  autoStopMinutes: z.number().int().min(0).max(1440).default(0),
  /** Shown to friends, e.g. "mc.hoebe.at" (DDNS) or a public IP. Empty: Tailscale IP. */
  externalAddress: z.string().trim().max(253).default(''),
});

// PUT /api/games/:id (settings, restart) -> { game }
export const gameUpdateRequestSchema = z.strictObject({
  values: z.record(envKeySchema, fieldValueSchema).optional(),
  autoStopMinutes: z.number().int().min(0).max(1440).optional(),
  externalAddress: z.string().trim().max(253).optional(),
});

export const gameStatusSchema = z.enum(['ok', 'warn', 'crit', 'off', 'busy']);

export const gameSummarySchema = z.strictObject({
  id: idSchema,
  name: gameNameSchema,
  templateId: z.string(),
  game: z.string(),
  version: z.string().nullable(),
  serverId: z.string(),
  serverName: z.string(),
  /** "mc.hoebe.at:25565" or "100.64.0.5:25565". */
  address: z.string(),
  ports: z.array(
    z.strictObject({ name: z.string(), port: z.number().int(), protocol: portProtocolSchema }),
  ),
  /** busy: setup, starting, restart, backup running. */
  status: gameStatusSchema,
  /** German, e.g. "Läuft", "Gestoppt", "Welt wird erzeugt", "Container abgestürzt". */
  statusText: z.string(),
  players: z
    .strictObject({ online: z.number().int(), max: z.number().int(), names: z.array(z.string()) })
    .nullable(),
  tps: z.number().nullable(),
  ramBytes: z.number().nullable(),
  ramLimitBytes: z.number().nullable(),
  rcon: z.boolean(),
  autoStopMinutes: z.number().int(),
  /** As set by the admin; empty: the address uses the Tailscale IP. */
  externalAddress: z.string(),
  values: z.record(z.string(), fieldValueSchema),
  lastBackupAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** M10 (api/throttle.ts): set with PUT /api/games/:id/priority. */
  priority: prioritySchema,
  allowStop: z.boolean(),
  allowStopWithPlayers: z.boolean(),
  /** Throttle of the game's container, null when not throttled. */
  throttled: throttledSchema.nullable(),
  /** Stopped by the rule set (not restarted automatically). */
  autoStopped: z.boolean(),
});
export type GameSummary = z.infer<typeof gameSummarySchema>;

export const gameListResponseSchema = z.strictObject({ games: z.array(gameSummarySchema) });
export const gameResponseSchema = z.strictObject({ game: gameSummarySchema });

// PATCH /api/games/:id/ports (step-up) { ports } -> GamePortsUpdateResponse
// Changes host ports after setup (decision 2026-11-26). Validated like on create
// (1024–65535, consecutive ranges, conflicts with other games and known ports of the
// server: 409 conflict). Rewrites compose.yml/.env and recreates a running game.
// Friends' port forwarding must then be adjusted by hand (see forwardingHint).
export const gamePortsUpdateRequestSchema = z.strictObject({
  /** New start port per template port name; names not given keep their port. */
  ports: z
    .record(z.string().regex(/^[a-z][a-z0-9]{0,15}$/), z.number().int().min(1024).max(65535))
    .refine((p) => Object.keys(p).length >= 1 && Object.keys(p).length <= 5, {
      message: '1 to 5 ports',
    }),
});
export const gamePortChangeSchema = z.strictObject({
  name: z.string(),
  protocol: portProtocolSchema,
  /** Consecutive ports (Valheim: 3). */
  count: z.number().int(),
  from: z.number().int(),
  to: z.number().int(),
  /** 127.0.0.1 only: no forwarding needed. */
  local: z.boolean(),
});
export const gamePortsUpdateResponseSchema = z.strictObject({
  game: gameSummarySchema,
  /** All host ports of the game after the change (local ones included). */
  ports: z.array(
    z.strictObject({
      name: z.string(),
      port: z.number().int(),
      protocol: portProtocolSchema,
      count: z.number().int(),
      local: z.boolean(),
    }),
  ),
  /** Only ports whose value changed. */
  changed: z.array(gamePortChangeSchema),
  /** German, e.g. "Portweiterleitung anpassen: game 25565 → 25570 (TCP)"; null if no public port changed. */
  forwardingHint: z.string().nullable(),
});
export type GamePortsUpdateResponse = z.infer<typeof gamePortsUpdateResponseSchema>;

// POST /api/games/:id/start|stop|restart|backup -> { game }
export const gameActionParamsSchema = z.strictObject({
  id: idSchema,
  action: z.enum(['start', 'stop', 'restart', 'backup']),
});

// DELETE /api/games/:id { confirmName } -> backup first, then compose down and remove the folder
export const gameDeleteRequestSchema = z.strictObject({ confirmName: gameNameSchema });

// POST /api/games/:id/rcon -> { output }
export const gameRconRequestSchema = z.strictObject({
  command: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .refine((c) => !/[\r\n\0]/.test(c), { message: 'single line only' }),
});
export const gameRconResponseSchema = z.strictObject({ output: z.string().max(64 * 1024) });

// GET /api/games/:id/backups
export const gameBackupSchema = z.strictObject({
  id: idSchema,
  fileName: z.string(),
  sizeBytes: z.number(),
  createdAt: z.iso.datetime(),
});
export const gameBackupListResponseSchema = z.strictObject({
  backups: z.array(gameBackupSchema),
});

/** Topic `game:<id>` items: setup/backup progress and console lines. */
export const gameEventSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['progress', 'console', 'ready', 'error']),
  text: z.string().max(16 * 1024),
  ts: z.iso.datetime(),
});

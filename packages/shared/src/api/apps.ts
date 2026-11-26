import { z } from 'zod';
import { appIdSchema } from '../agent-automation.js';
import { serverIdSchema } from './servers.js';

/**
 * M21 "App-Store und Stack-Vorlagen" (ROADMAP M21, SPEC 18.5). Module `apps`
 * (off by default).
 *
 * A stack template = metadata (appTemplateMetaSchema) + compose.yml with `${KEY}`
 * placeholders. Built-in templates live in templates/apps/<id>/{template.json,
 * compose.yml} (shipped with the core image); the admin can add own templates
 * (source `custom`) in the UI. The core renders a template with validated
 * parameters and installs it with compose.write + compose.up into
 * /opt/homelab/apps/<appId>/ (compose.yml, .env with mode 0600, data/ for volumes).
 *
 * Placeholders the core always sets: APP_ID, APP_DIR (= /opt/homelab/apps/<appId>),
 * BIND (bind address, see appBindSchema), TZ (HZ_TIMEZONE), PUID/PGID (1000).
 * Parameter values go into .env, never inline into compose.yml; compose.yml
 * references them as ${KEY}. Values are checked against the parameter type and
 * may not contain newlines, `$` or NUL.
 *
 * Compose safety (checked for built-in and custom templates after rendering, in
 * the core; COMPOSE_FORBIDDEN lists the rules; violations -> 400 `invalid_input`
 * with the first problems in `message`; the full list comes from the preview route): no privileged, no cap_add, no devices, no network_mode/pid/ipc/
 * userns_mode `host`, no security_opt, no build, no docker.sock, bind mounts only
 * relative below the app folder (./data/...), named volumes only without driver
 * options, every published port with host IP `${BIND}`, no `container_name`
 * outside `${APP_ID}` / `${APP_ID}-*`, at most 10 services, labels hz.role forbidden.
 * Every service gets the label `homelab.app=<appId>` added by the core.
 *
 * Install checks: module on, template arch fits the server, minRamMb fits the free RAM
 * minus the M10 reserve, host ports free on that server (inventory listeners, other
 * apps, game servers), appId unique per server. Install, update and remove are
 * audit-logged; remove needs step-up and the app name typed again.
 *
 * Routes (admin session):
 * GET    /api/apps/templates                 -> AppTemplatesResponse
 * GET    /api/apps/templates/:id             -> AppTemplateDetail
 * POST   /api/apps/templates                 AppTemplateCustomRequest -> AppTemplateDetail (201)
 * PUT    /api/apps/templates/:id             AppTemplateCustomRequest -> AppTemplateDetail (custom only)
 * DELETE /api/apps/templates/:id             -> 204 (custom only; 409 in_use)
 * POST   /api/apps/templates/:id/preview     AppInstallRequest -> AppPreviewResponse
 * GET    /api/apps                           -> AppsResponse
 * POST   /api/apps                           AppInstallRequest -> 202 InstalledApp (installing)
 * POST   /api/apps/:id/start|stop|restart|update  -> 202 InstalledApp
 * GET    /api/apps/:id/secrets   (step-up)   -> AppSecretsResponse
 * DELETE /api/apps/:id           (step-up)   AppRemoveRequest -> 202
 *
 * `:id` of an installed app is its database id (not the folder name).
 */

export const appTemplateIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/);
export const appTemplateIdParamsSchema = z.strictObject({ id: appTemplateIdSchema });
export const installedAppIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const installedAppIdParamsSchema = z.strictObject({ id: installedAppIdSchema });

export const APP_CATEGORIES = [
  'medien',
  'dateien',
  'sicherheit',
  'entwicklung',
  'smarthome',
  'netzwerk',
  'werkzeuge',
] as const;
export const appCategorySchema = z.enum(APP_CATEGORIES);
export type AppCategory = z.infer<typeof appCategorySchema>;
export const APP_CATEGORY_LABELS: Record<AppCategory, string> = {
  medien: 'Medien',
  dateien: 'Dateien und Fotos',
  sicherheit: 'Passwörter und Sicherheit',
  entwicklung: 'Entwicklung',
  smarthome: 'Smart Home',
  netzwerk: 'Netzwerk',
  werkzeuge: 'Werkzeuge',
};

/** Placeholders the core sets itself; templates may not declare them as params. */
export const APP_RESERVED_KEYS = ['APP_ID', 'APP_DIR', 'BIND', 'TZ', 'PUID', 'PGID'] as const;

/**
 * Keys Compose reads from .env itself (COMPOSE_FILE, DOCKER_HOST, …) or that the
 * agent's environment sets and that would win over .env during interpolation.
 */
export const APP_HOST_ENV_PREFIXES = ['COMPOSE_', 'DOCKER_', 'BUILDKIT_', 'HZ_', 'NODE_'] as const;
export const APP_HOST_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'PWD',
  'HOSTNAME',
  'LANG',
] as const;

export const appParamKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,39}$/)
  .refine((k) => !(APP_RESERVED_KEYS as readonly string[]).includes(k), {
    message: 'reserved key',
  })
  .refine(
    (k) =>
      !APP_HOST_ENV_PREFIXES.some((p) => k.startsWith(p)) &&
      !(APP_HOST_ENV_KEYS as readonly string[]).includes(k),
    { message: 'key of the host environment' },
  );

const textLabel = z.string().min(1).max(80);

export const appParamSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('string'),
    key: appParamKeySchema,
    label: textLabel,
    default: z.string().max(200).optional(),
    required: z.boolean().default(true),
    /** Anchored regex the value must match (checked in core and web). */
    pattern: z.string().max(200).optional(),
  }),
  /**
   * A secret. `generate: true` -> the core generates 24 random URL-safe chars when
   * empty. Stored encrypted (AAD `apps.secrets`), shown only via GET .../secrets.
   */
  z.strictObject({
    type: z.literal('password'),
    key: appParamKeySchema,
    label: textLabel,
    generate: z.boolean().default(true),
    minLength: z.number().int().min(8).max(64).default(12),
  }),
  /** A host port, published as ${BIND}:${KEY}:<container port>. */
  z.strictObject({
    type: z.literal('port'),
    key: appParamKeySchema,
    label: textLabel,
    default: z.number().int().min(1024).max(65535),
    protocol: z.enum(['tcp', 'udp']).default('tcp'),
    /** This port serves the app's web UI (link "Öffnen"). At most one per template. */
    web: z.boolean().default(false),
  }),
  z
    .strictObject({
      type: z.literal('number'),
      key: appParamKeySchema,
      label: textLabel,
      default: z.number().int(),
      min: z.number().int(),
      max: z.number().int(),
    })
    .refine((p) => p.min <= p.default && p.default <= p.max, {
      message: 'min <= default <= max',
    }),
  z.strictObject({
    type: z.literal('select'),
    key: appParamKeySchema,
    label: textLabel,
    options: z
      .array(
        z.strictObject({ value: z.string().regex(/^[A-Za-z0-9._:-]{1,60}$/), label: textLabel }),
      )
      .min(1)
      .max(20),
    default: z.string().max(60),
  }),
  z.strictObject({
    type: z.literal('bool'),
    key: appParamKeySchema,
    label: textLabel,
    default: z.boolean(),
  }),
]);
export type AppParam = z.infer<typeof appParamSchema>;

export const appArchSchema = z.enum(['amd64', 'arm64']);

/** templates/apps/<id>/template.json (built-in) and the meta part of a custom template. */
export const appTemplateMetaSchema = z
  .strictObject({
    id: appTemplateIdSchema,
    name: z.string().min(1).max(40),
    description: z.string().min(1).max(300),
    category: appCategorySchema,
    /** App version the pinned images belong to ("10.10.3"). */
    version: z.string().max(40),
    website: z
      .url({ protocol: /^https$/ })
      .max(200)
      .optional(),
    arch: z.array(appArchSchema).min(1).max(2),
    minRamMb: z.number().int().min(16).max(65_536),
    params: z.array(appParamSchema).max(30),
    /** German hints shown before install ("Braucht HTTPS: ..."), short. */
    hints: z.array(z.string().max(300)).max(6).default([]),
  })
  .refine((t) => new Set(t.params.map((p) => p.key)).size === t.params.length, {
    message: 'duplicate param key',
  })
  .refine((t) => t.params.filter((p) => p.type === 'port' && p.web).length <= 1, {
    message: 'at most one web port',
  });
export type AppTemplateMeta = z.infer<typeof appTemplateMetaSchema>;

export const appTemplateSourceSchema = z.enum(['builtin', 'custom']);

export const appTemplateSummarySchema = z.strictObject({
  id: appTemplateIdSchema,
  source: appTemplateSourceSchema,
  name: z.string().max(40),
  description: z.string().max(300),
  category: appCategorySchema,
  version: z.string().max(40),
  arch: z.array(appArchSchema),
  minRamMb: z.number().int(),
  /** Number of installations of this template. */
  installed: z.number().int().nonnegative(),
});
export type AppTemplateSummary = z.infer<typeof appTemplateSummarySchema>;

export const appTemplatesResponseSchema = z.strictObject({
  templates: z.array(appTemplateSummarySchema),
});

export const APP_COMPOSE_MAX_BYTES = 64 * 1024;

export const appTemplateDetailSchema = z.strictObject({
  source: appTemplateSourceSchema,
  meta: appTemplateMetaSchema,
  /** compose.yml with placeholders. */
  compose: z.string().max(APP_COMPOSE_MAX_BYTES),
});
export type AppTemplateDetail = z.infer<typeof appTemplateDetailSchema>;

/** Own template. id must not collide with a built-in one (409 exists). */
export const appTemplateCustomRequestSchema = z.strictObject({
  meta: appTemplateMetaSchema,
  compose: z.string().min(1).max(APP_COMPOSE_MAX_BYTES),
});
export type AppTemplateCustomRequest = z.input<typeof appTemplateCustomRequestSchema>;

/**
 * Where published ports listen:
 * - tailnet: the server's Tailscale IP (default; only the tailnet reaches the app),
 * - localhost: 127.0.0.1 (for a reverse proxy on the same server),
 * - all: 0.0.0.0 (LAN / internet). Shows a warning; the ports are added to the
 *   server's allowed ports (M11) so the port audit does not alert.
 */
export const appBindSchema = z.enum(['tailnet', 'localhost', 'all']);
export type AppBind = z.infer<typeof appBindSchema>;

export const appParamValueSchema = z.union([
  z
    .string()
    .max(200)
    .refine((v) => !/[\r\n\0$]/.test(v), { message: 'invalid characters' }),
  z.number().int(),
  z.boolean(),
]);

export const appInstallRequestSchema = z.strictObject({
  templateId: appTemplateIdSchema,
  serverId: serverIdSchema,
  appId: appIdSchema,
  /** Display name ("Jellyfin Wohnzimmer"). */
  name: z.string().trim().min(1).max(60),
  bind: appBindSchema.default('tailnet'),
  /** Missing keys take the default (or a generated password). */
  params: z.record(appParamKeySchema, appParamValueSchema).default({}),
});
export type AppInstallRequest = z.input<typeof appInstallRequestSchema>;

export const appPreviewResponseSchema = z.strictObject({
  /** Rendered compose.yml (as written to the server). */
  compose: z.string(),
  /** .env with password values replaced by "••••••". */
  env: z.string(),
  /** German problems; empty = installable. */
  problems: z.array(z.string().max(300)),
});
export type AppPreviewResponse = z.infer<typeof appPreviewResponseSchema>;

export const appStatusSchema = z.enum([
  'installing',
  'running',
  'stopped',
  'updating',
  'error',
  'removing',
]);
export type AppStatus = z.infer<typeof appStatusSchema>;

export const installedAppSchema = z.strictObject({
  id: installedAppIdSchema,
  appId: appIdSchema,
  name: z.string().max(60),
  serverId: serverIdSchema,
  serverName: z.string().max(64),
  templateId: appTemplateIdSchema,
  source: appTemplateSourceSchema,
  templateName: z.string().max(40),
  version: z.string().max(40),
  bind: appBindSchema,
  ports: z.array(
    z.strictObject({
      port: z.number().int(),
      protocol: z.enum(['tcp', 'udp']),
      label: z.string().max(80),
    }),
  ),
  /** http://<server tailnet name or ip>:<web port>, when the template has a web port. */
  url: z.string().max(300).nullable(),
  status: appStatusSchema,
  /** Non-secret parameter values. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  hasSecrets: z.boolean(),
  /** Containers of the app (label homelab.app) with their state. */
  containers: z.array(
    z.strictObject({
      name: z.string().max(128),
      state: z.string().max(32),
      health: z.string().max(16),
    }),
  ),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastError: z.string().max(300).nullable(),
});
export type InstalledApp = z.infer<typeof installedAppSchema>;

export const appsResponseSchema = z.strictObject({ apps: z.array(installedAppSchema) });
export type AppsResponse = z.infer<typeof appsResponseSchema>;

export const appSecretsResponseSchema = z.strictObject({
  values: z.record(appParamKeySchema, z.string()),
});

export const appRemoveRequestSchema = z.strictObject({
  /** Must equal the app's appId. */
  confirmName: appIdSchema,
  /** Also delete /opt/homelab/apps/<appId>/ including data/. */
  deleteData: z.boolean().default(false),
});

/** Rules of the compose safety check (German text for the UI, one per rule). */
export const COMPOSE_FORBIDDEN = [
  'privileged',
  'cap_add',
  'devices',
  'network_mode: host',
  'pid: host',
  'ipc: host',
  'userns_mode: host',
  'security_opt',
  'build',
  'docker.sock',
  'absolute bind mounts',
  'volume driver options',
  'ports without ${BIND}',
  'container_name outside ${APP_ID}',
  'label hz.role',
  'more than 10 services',
] as const;

export const APP_LIMIT_PER_SERVER = 30;
export const APP_CUSTOM_TEMPLATES_MAX = 50;

/** Replaces ${KEY} placeholders (only [A-Z][A-Z0-9_]*). Unknown keys stay as they are. */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (m, k: string) =>
    Object.hasOwn(values, k) ? (values[k] as string) : m,
  );
}

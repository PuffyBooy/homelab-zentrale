import { z } from 'zod';

/**
 * Optional modules (decision 2026-11-26). The hub must work for anyone without
 * GitHub or Home Assistant. A disabled module: its API routes answer
 * 404 { error: 'module_disabled' }, its pollers/connections/jobs stop, its live
 * topics send nothing, it is left out of overview data (wall tiles, weekly
 * report), and for `games` the share links (tailnet page and gateway API) stop.
 *
 * Fresh install: games on, storage on, github off, homeassistant off. An existing install keeps
 * GitHub/HA on if they were configured (migration 10).
 */
export const MODULES = [
  'github',
  'homeassistant',
  'games',
  'storage',
  'tasks',
  'selfheal',
  'speedtest',
  'domains',
  'apps',
] as const;
export const moduleIdSchema = z.enum(MODULES);
export type ModuleId = z.infer<typeof moduleIdSchema>;

export const modulesSchema = z.strictObject({
  github: z.boolean(),
  homeassistant: z.boolean(),
  games: z.boolean(),
  /** M13: NAS und Speicher (RAID, volumes, disks, SMART). Read only, on by default. */
  storage: z.boolean(),
  /** M20: Geplante Aufgaben pro Server (api/tasks.ts). */
  tasks: z.boolean(),
  /** M20: Selbstheilung hängender Container (api/selfheal.ts). */
  selfheal: z.boolean(),
  /** M20: Speedtest-Verlauf (api/speedtest.ts). */
  speedtest: z.boolean(),
  /** M20: Domains, DNS und Zertifikate (api/domains.ts). */
  domains: z.boolean(),
  /** M21: App-Store und Stack-Vorlagen (api/apps.ts). */
  apps: z.boolean(),
});
export type Modules = z.infer<typeof modulesSchema>;

export const MODULE_DEFAULTS: Modules = {
  github: false,
  homeassistant: false,
  games: true,
  storage: true,
  tasks: false,
  selfheal: false,
  speedtest: false,
  domains: false,
  apps: false,
};

/** Enabling these needs step-up (they hold tokens with access to outside systems). */
export const MODULES_ENABLE_STEP_UP: readonly ModuleId[] = [
  'github',
  'homeassistant',
  // M20: tasks can run shell commands; domains holds DNS tokens.
  'tasks',
  'domains',
];

// GET /api/settings/modules -> Modules
export const modulesResponseSchema = modulesSchema;
// PUT /api/settings/modules { github?, homeassistant?, games?, storage? } -> Modules
// (step-up when switching github or homeassistant on)
export const modulesUpdateRequestSchema = modulesSchema
  .partial()
  .refine((m) => Object.keys(m).length >= 1, { message: 'at least one module' });

import { z } from 'zod';

/**
 * Optional modules (decision 2026-11-26). The hub must work for anyone without
 * GitHub or Home Assistant. A disabled module: its API routes answer
 * 404 { error: 'module_disabled' }, its pollers/connections/jobs stop, its live
 * topics send nothing, it is left out of overview data (wall tiles, weekly
 * report), and for `games` the share links (tailnet page and gateway API) stop.
 *
 * Fresh install: games on, github off, homeassistant off. An existing install keeps
 * GitHub/HA on if they were configured (migration 10).
 */
export const MODULES = [
  'github',
  'homeassistant',
  'games',
  'proxmox',
  'dnsfilter',
  'fritzbox',
  'uptimekuma',
] as const;
export const moduleIdSchema = z.enum(MODULES);
export type ModuleId = z.infer<typeof moduleIdSchema>;

export const modulesSchema = z.strictObject({
  github: z.boolean(),
  homeassistant: z.boolean(),
  games: z.boolean(),
  /** M14 Anbindungen (packages/shared/src/api/integrations.ts), all off by default. */
  proxmox: z.boolean(),
  dnsfilter: z.boolean(),
  fritzbox: z.boolean(),
  uptimekuma: z.boolean(),
});
export type Modules = z.infer<typeof modulesSchema>;

export const MODULE_DEFAULTS: Modules = {
  github: false,
  homeassistant: false,
  games: true,
  proxmox: false,
  dnsfilter: false,
  fritzbox: false,
  uptimekuma: false,
};

/** Enabling these needs step-up (they hold tokens with access to outside systems). */
export const MODULES_ENABLE_STEP_UP: readonly ModuleId[] = [
  'github',
  'homeassistant',
  'proxmox',
  'dnsfilter',
  'fritzbox',
  'uptimekuma',
];

// GET /api/settings/modules -> Modules
export const modulesResponseSchema = modulesSchema;
// PUT /api/settings/modules { github?, homeassistant?, games? } -> Modules
// (step-up when switching github or homeassistant on)
export const modulesUpdateRequestSchema = modulesSchema
  .partial()
  .refine((m) => Object.keys(m).length >= 1, { message: 'at least one module' });

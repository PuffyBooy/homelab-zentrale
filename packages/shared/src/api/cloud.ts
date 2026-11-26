import { z } from 'zod';
import { gameCreateRequestSchema } from './games.js';

/**
 * M22: Cloud-Server (module `cloud`, off by default, switching on needs step-up).
 *
 * The hub orders a VM at a cloud provider, installs Docker, Tailscale and the agent on
 * it via cloud-init (M11 enrollment code), and can put a gameserver on it right away.
 * While nobody plays the VM is deallocated (only disk and IP cost money); a start of a
 * game on it (admin, share link, Discord, voice, relay) starts the VM first.
 *
 * Generic by design: `CLOUD_PROVIDERS` lists the providers, Azure is the first one.
 * Rules (core, apps/core/src/cloud):
 * - Credentials (client secret, Tailscale auth key) AES-256-GCM in the DB (AAD per
 *   field), write-only: the API only says `secretSet` / `tailscaleKeySet`.
 * - Requests only to fixed hosts (`login.microsoftonline.com`, `management.azure.com`,
 *   `prices.azure.com`), every path built from validated parts only. Overriding the
 *   hosts (tests, e2e) only with HZ_DEMO=1 and only to http://127.0.0.1:<port>.
 * - Nothing is ordered without the admin confirming the estimated price
 *   (`confirmEurPerHour` must match the core's estimate). Deleting needs step-up and
 *   the machine name. Budget: warn at 80 %, at 100 % automatic starts are refused
 *   and admin starts/orders need `overBudget: true`.
 * - The VM's network security group only lets in the game ports of its games (no SSH;
 *   admin access goes through Tailscale). The VM gets an SSH public key whose private
 *   key is never stored, and no password.
 * - Error texts are fixed German strings (CLOUD_ERRORS), never the remote body.
 */

export const CLOUD_PROVIDERS = ['azure'] as const;
export const cloudProviderSchema = z.enum(CLOUD_PROVIDERS);
export type CloudProvider = z.infer<typeof cloudProviderSchema>;

export const CLOUD_ERRORS = [
  'Zugangsdaten ungültig',
  'Keine Berechtigung in der Ressourcengruppe',
  'Ressourcengruppe nicht gefunden',
  'Größe in der Region nicht verfügbar',
  'Kontingent der Region erschöpft',
  'Azure nicht erreichbar',
  'Zeitüberschreitung',
  'Unerwartete Antwort von Azure',
  'Zugangsdaten nicht lesbar, bitte neu eintragen',
  'Agent hat sich nicht gemeldet',
] as const;
export type CloudErrorText = (typeof CLOUD_ERRORS)[number];

// ---- Azure: fixed choices -----------------------------------------------------------------

/** Regions offered (close to Central Europe). */
export const AZURE_REGIONS = [
  'germanywestcentral',
  'westeurope',
  'northeurope',
  'swedencentral',
  'switzerlandnorth',
  'francecentral',
] as const;
export const azureRegionSchema = z.enum(AZURE_REGIONS);
export type AzureRegion = z.infer<typeof azureRegionSchema>;

export const AZURE_REGION_LABELS: Record<AzureRegion, string> = {
  germanywestcentral: 'Deutschland West-Mitte (Frankfurt)',
  westeurope: 'Westeuropa (Niederlande)',
  northeurope: 'Nordeuropa (Irland)',
  swedencentral: 'Schweden Mitte',
  switzerlandnorth: 'Schweiz Nord (Zürich)',
  francecentral: 'Frankreich Mitte (Paris)',
};

export interface AzureVmSize {
  size: string;
  vcpus: number;
  ramGb: number;
  /** Fallback estimate in EUR per hour (Linux, pay as you go, germanywestcentral). */
  eurPerHour: number;
  /** Part of the Azure free account (750 h per month for 12 months). */
  freeTier: boolean;
  /** Burstable (B series): full CPU only in bursts, fine for small groups. */
  burstable: boolean;
}

/**
 * x64 sizes only (every game template runs on amd64). Prices are rough fallbacks
 * (as of 2026-11); the core asks the Azure Retail Prices API for the real ones.
 */
export const AZURE_VM_SIZES: readonly AzureVmSize[] = [
  {
    size: 'Standard_B2ats_v2',
    vcpus: 2,
    ramGb: 1,
    eurPerHour: 0.0095,
    freeTier: true,
    burstable: true,
  },
  { size: 'Standard_B2s', vcpus: 2, ramGb: 4, eurPerHour: 0.048, freeTier: false, burstable: true },
  {
    size: 'Standard_B2ms',
    vcpus: 2,
    ramGb: 8,
    eurPerHour: 0.096,
    freeTier: false,
    burstable: true,
  },
  {
    size: 'Standard_B4ms',
    vcpus: 4,
    ramGb: 16,
    eurPerHour: 0.19,
    freeTier: false,
    burstable: true,
  },
  {
    size: 'Standard_D2as_v5',
    vcpus: 2,
    ramGb: 8,
    eurPerHour: 0.1,
    freeTier: false,
    burstable: false,
  },
  {
    size: 'Standard_D4as_v5',
    vcpus: 4,
    ramGb: 16,
    eurPerHour: 0.2,
    freeTier: false,
    burstable: false,
  },
  {
    size: 'Standard_E2as_v5',
    vcpus: 2,
    ramGb: 16,
    eurPerHour: 0.135,
    freeTier: false,
    burstable: false,
  },
  {
    size: 'Standard_E4as_v5',
    vcpus: 4,
    ramGb: 32,
    eurPerHour: 0.27,
    freeTier: false,
    burstable: false,
  },
];
export const AZURE_VM_SIZE_NAMES = AZURE_VM_SIZES.map((s) => s.size) as [string, ...string[]];
export const azureVmSizeSchema = z.enum(AZURE_VM_SIZE_NAMES);

export function azureVmSize(size: string): AzureVmSize | undefined {
  return AZURE_VM_SIZES.find((s) => s.size === size);
}

export const AZURE_DISK_TYPES = ['StandardSSD_LRS', 'Premium_LRS'] as const;
export const azureDiskTypeSchema = z.enum(AZURE_DISK_TYPES);
export type AzureDiskType = z.infer<typeof azureDiskTypeSchema>;

export const AZURE_DISK_SIZES = [32, 64, 128, 256] as const;
export const azureDiskGbSchema = z.union([
  z.literal(32),
  z.literal(64),
  z.literal(128),
  z.literal(256),
]);

/** Fallback EUR per month per disk type and size (billed also while deallocated). */
export const AZURE_DISK_EUR_PER_MONTH: Record<AzureDiskType, Record<number, number>> = {
  // E4, E6, E10, E15
  StandardSSD_LRS: { 32: 2.3, 64: 4.6, 128: 9.0, 256: 17.5 },
  // P4, P6 (P6 64 GB: 2x in the free account for 12 months), P10, P15
  Premium_LRS: { 32: 5.2, 64: 10.0, 128: 19.3, 256: 37.0 },
};

/** Standard static public IPv4, billed per hour also while deallocated. */
export const AZURE_PUBLIC_IP_EUR_PER_HOUR = 0.0046;
export const HOURS_PER_MONTH = 730;

/** RAM the OS, Docker, Tailscale and the agent need next to the game (GB). */
export const CLOUD_OS_RAM_GB = 1;

/**
 * Smallest size that fits `gameRamGb` plus the OS (burstable first, then by price).
 * Minecraft Java (4 GB) gets Standard_B2ms, Terraria (1 GB) Standard_B2s.
 */
export function recommendAzureSize(gameRamGb: number): AzureVmSize | null {
  const need = gameRamGb + CLOUD_OS_RAM_GB;
  const fits = AZURE_VM_SIZES.filter((s) => s.ramGb >= need);
  if (fits.length === 0) return null;
  return [...fits].sort(
    (a, b) => Number(b.burstable) - Number(a.burstable) || a.eurPerHour - b.eurPerHour,
  )[0]!;
}

export const cloudCostSchema = z.strictObject({
  /** VM running: compute + disk + IP, per hour. */
  runningEurPerHour: z.number().nonnegative(),
  /** Deallocated: disk + IP only, per month. */
  sleepingEurPerMonth: z.number().nonnegative(),
  /** If it ran all month (730 h). */
  fullMonthEur: z.number().nonnegative(),
  /** 'live': Azure Retail Prices API, 'estimate': built-in table. */
  source: z.enum(['live', 'estimate']),
});
export type CloudCost = z.infer<typeof cloudCostSchema>;

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Cost estimate from an hourly compute price (live or fallback). */
export function estimateAzureCost(opts: {
  computeEurPerHour: number;
  diskType: AzureDiskType;
  diskGb: number;
  publicIp: boolean;
  source: CloudCost['source'];
}): CloudCost {
  const diskMonth = AZURE_DISK_EUR_PER_MONTH[opts.diskType][opts.diskGb] ?? 0;
  const ipHour = opts.publicIp ? AZURE_PUBLIC_IP_EUR_PER_HOUR : 0;
  const fixedHour = diskMonth / HOURS_PER_MONTH + ipHour;
  return {
    runningEurPerHour: round4(opts.computeEurPerHour + fixedHour),
    sleepingEurPerMonth: round2(diskMonth + ipHour * HOURS_PER_MONTH),
    fullMonthEur: round2((opts.computeEurPerHour + fixedHour) * HOURS_PER_MONTH),
    source: opts.source,
  };
}

/** A confirmed price may differ from the core's current estimate by this much (rounding). */
export const CLOUD_PRICE_TOLERANCE_EUR = 0.0005;

// ---- Azure account settings ----------------------------------------------------------------

const uuidSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, {
    message: 'GUID erwartet',
  });

/** Azure resource group name (letters, digits, . _ - ( ), not ending with a dot). */
export const azureResourceGroupSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._()-]{1,90}$/, { message: 'Ungültiger Name der Ressourcengruppe' })
  .refine((s) => !s.endsWith('.'), { message: 'Name darf nicht mit einem Punkt enden' });

/** Client secret of the app registration (write-only). */
export const azureClientSecretSchema = z
  .string()
  .min(10)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, { message: 'Ungültiges Secret' });

/**
 * Tailscale auth key (write-only, reusable, pre-approved, ideally tagged
 * `tag:homelab-cloud`). Sent only inside the VM's cloud-init.
 */
export const tailscaleAuthKeySchema = z
  .string()
  .regex(/^tskey-(auth|client)-[A-Za-z0-9_-]{8,200}$/, { message: 'Tailscale-Auth-Key erwartet' });

// PUT /api/cloud/azure (step-up when tenant, client, subscription, group, secret or key
// change). tenant/client/subscription changed without a new secret: the stored one is
// dropped (a secret is never sent for an app it was not entered for).
export const azureSettingsRequestSchema = z.strictObject({
  tenantId: uuidSchema.optional(),
  clientId: uuidSchema.optional(),
  clientSecret: azureClientSecretSchema.optional(),
  subscriptionId: uuidSchema.optional(),
  resourceGroup: azureResourceGroupSchema.optional(),
  region: azureRegionSchema.optional(),
  tailscaleAuthKey: tailscaleAuthKeySchema.optional(),
  /** Monthly budget for all cloud machines (EUR, estimate). */
  budgetEurPerMonth: z.number().min(1).max(10_000).optional(),
});
export type AzureSettingsRequest = z.infer<typeof azureSettingsRequestSchema>;

/** Fields whose change needs step-up (everything except region and budget). */
export const AZURE_STEP_UP_FIELDS = [
  'tenantId',
  'clientId',
  'clientSecret',
  'subscriptionId',
  'resourceGroup',
  'tailscaleAuthKey',
] as const satisfies readonly (keyof AzureSettingsRequest)[];

export function azureUpdateNeedsStepUp(req: AzureSettingsRequest): boolean {
  return AZURE_STEP_UP_FIELDS.some((k) => req[k] !== undefined);
}

export const CLOUD_BUDGET_DEFAULT_EUR = 20;
export const CLOUD_BUDGET_WARN_PERCENT = 80;

// GET /api/cloud/azure -> AzureSettings (no secrets)
export const azureSettingsSchema = z.strictObject({
  tenantId: z.string().nullable(),
  clientId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  resourceGroup: z.string().nullable(),
  region: azureRegionSchema,
  secretSet: z.boolean(),
  tailscaleKeySet: z.boolean(),
  budgetEurPerMonth: z.number(),
  /** off: not complete; ok: last check succeeded; error: see `error`. */
  status: z.enum(['ok', 'error', 'off']),
  error: z.enum(CLOUD_ERRORS).nullable(),
  lastOkAt: z.iso.datetime().nullable(),
});
export type AzureSettings = z.infer<typeof azureSettingsSchema>;

// POST /api/cloud/azure/test -> AzureSettings (token + read of the resource group)
// DELETE /api/cloud/azure (step-up) -> 204, refused (409) while machines exist

// GET /api/cloud/azure/prices?region=&diskType=&diskGb=&publicIp= -> prices per size
export const azurePricesQuerySchema = z.strictObject({
  region: azureRegionSchema.optional(),
  diskType: azureDiskTypeSchema.default('StandardSSD_LRS'),
  diskGb: z.coerce.number().pipe(azureDiskGbSchema).default(32),
  publicIp: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});
export const azurePricesResponseSchema = z.strictObject({
  region: azureRegionSchema,
  fetchedAt: z.iso.datetime().nullable(),
  sizes: z.array(
    z.strictObject({
      size: azureVmSizeSchema,
      vcpus: z.number().int(),
      ramGb: z.number(),
      freeTier: z.boolean(),
      burstable: z.boolean(),
      cost: cloudCostSchema,
    }),
  ),
});
export type AzurePricesResponse = z.infer<typeof azurePricesResponseSchema>;

// ---- machines ------------------------------------------------------------------------------

/** VM name in Azure and Tailscale host name: "hz-mc-freunde". */
export const cloudMachineNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/, {
    message: 'Kleinbuchstaben, Ziffern und Bindestrich, 3 bis 32 Zeichen',
  });

export const cloudMachineIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const cloudMachineIdParamsSchema = z.strictObject({ id: cloudMachineIdSchema });

/**
 * creating: Azure resources are being created; installing: VM runs, cloud-init
 * installs Docker, Tailscale and the agent (waits for the enrollment); running;
 * stopping: deallocate requested; deallocated; starting; deleting; failed (see error).
 */
export const CLOUD_MACHINE_STATES = [
  'creating',
  'installing',
  'running',
  'stopping',
  'deallocated',
  'starting',
  'deleting',
  'failed',
] as const;
export const cloudMachineStateSchema = z.enum(CLOUD_MACHINE_STATES);
export type CloudMachineState = z.infer<typeof cloudMachineStateSchema>;

export const CLOUD_MACHINE_STATE_TEXT: Record<CloudMachineState, string> = {
  creating: 'Wird bestellt',
  installing: 'Wird eingerichtet',
  running: 'Läuft',
  stopping: 'Wird schlafen gelegt',
  deallocated: 'Schläft (nur Speicherkosten)',
  starting: 'Startet',
  deleting: 'Wird gelöscht',
  failed: 'Fehler',
};

/** Deallocate after every game on the machine is stopped or asleep this long. */
export const CLOUD_IDLE_MINUTES_DEFAULT = 15;
/** A started VM whose agent does not come back within this time: failed start. */
export const CLOUD_START_TIMEOUT_MINUTES = 8;
/** A new VM whose agent does not enroll within this time: failed. */
export const CLOUD_INSTALL_TIMEOUT_MINUTES = 25;
export const CLOUD_MAX_MACHINES = 10;

/** The game set up on the machine once its agent is connected (POST /api/games without serverId). */
export const cloudPendingGameSchema = gameCreateRequestSchema.omit({ serverId: true });
export type CloudPendingGame = z.infer<typeof cloudPendingGameSchema>;

// POST /api/cloud/machines -> 202 { machine }
export const cloudMachineCreateRequestSchema = z.strictObject({
  provider: cloudProviderSchema,
  name: cloudMachineNameSchema,
  size: azureVmSizeSchema,
  region: azureRegionSchema.optional(),
  diskType: azureDiskTypeSchema.default('StandardSSD_LRS'),
  diskGb: azureDiskGbSchema.default(32),
  /** Public IPv4 for friends (port forwarding on the VM itself). Off: only via Tailscale/relay. */
  publicIp: z.boolean().default(true),
  /** Deallocate after all games are stopped/asleep this long; 0 = never. */
  idleMinutes: z.number().int().min(0).max(1440).default(CLOUD_IDLE_MINUTES_DEFAULT),
  /** The running price per hour the admin saw and confirmed (must match the estimate). */
  confirmEurPerHour: z.number().nonnegative(),
  /** Needed when the month estimate is already at or over the budget. */
  overBudget: z.boolean().default(false),
  /** Optional gameserver to create on the machine once its agent is connected. */
  game: cloudPendingGameSchema.optional(),
});
export type CloudMachineCreateRequest = z.infer<typeof cloudMachineCreateRequestSchema>;

// PUT /api/cloud/machines/:id { idleMinutes } -> { machine }
export const cloudMachineUpdateRequestSchema = z.strictObject({
  idleMinutes: z.number().int().min(0).max(1440),
});

// POST /api/cloud/machines/:id/start { overBudget? } | /stop -> 202 { machine }
export const cloudMachineStartRequestSchema = z.strictObject({
  overBudget: z.boolean().default(false),
});

// DELETE /api/cloud/machines/:id { confirmName } (step-up) -> 202 { machine }
// Refused (409) while gameservers live on it: delete or move them first.
export const cloudMachineDeleteRequestSchema = z.strictObject({
  confirmName: cloudMachineNameSchema,
});

export const cloudMachineSchema = z.strictObject({
  id: cloudMachineIdSchema,
  provider: cloudProviderSchema,
  name: z.string(),
  size: z.string(),
  vcpus: z.number().int(),
  ramGb: z.number(),
  region: azureRegionSchema,
  diskType: azureDiskTypeSchema,
  diskGb: z.number().int(),
  /** Public IPv4 once assigned (null without public IP or while unknown). */
  publicIp: z.string().nullable(),
  /** Server row of the enrolled agent (null until it connected). */
  serverId: z.string().nullable(),
  state: cloudMachineStateSchema,
  /** German, from CLOUD_MACHINE_STATE_TEXT or a progress line ("Docker wird installiert"). */
  stateText: z.string(),
  error: z.enum(CLOUD_ERRORS).nullable(),
  idleMinutes: z.number().int(),
  /** Pending game (name) until it was created, then its id. */
  pendingGameName: z.string().nullable(),
  gameIds: z.array(z.string()),
  cost: cloudCostSchema,
  /** Running hours in the current calendar month (HZ_TIMEZONE). */
  monthHours: z.number().nonnegative(),
  /** Estimated cost this month: running hours + disk/IP so far. */
  monthEur: z.number().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type CloudMachine = z.infer<typeof cloudMachineSchema>;

export const cloudMachineResponseSchema = z.strictObject({ machine: cloudMachineSchema });

export const cloudBudgetSchema = z.strictObject({
  limitEur: z.number(),
  /** Estimated cost of all machines this month so far. */
  monthEur: z.number().nonnegative(),
  /** If everything keeps its current state until the end of the month. */
  projectedEur: z.number().nonnegative(),
  percent: z.number().nonnegative(),
  /** warn from 80 %, over from 100 % (automatic starts refused). */
  state: z.enum(['ok', 'warn', 'over']),
});
export type CloudBudget = z.infer<typeof cloudBudgetSchema>;

// GET /api/cloud -> overview
export const cloudOverviewSchema = z.strictObject({
  azure: azureSettingsSchema,
  machines: z.array(cloudMachineSchema),
  budget: cloudBudgetSchema,
});
export type CloudOverview = z.infer<typeof cloudOverviewSchema>;

/** Status texts of a game whose cloud machine is not running (game summary). */
export const CLOUD_GAME_TEXT = {
  deallocated: 'Schläft (Cloud-Server aus)',
  starting: 'Cloud-Server startet, etwa 2 Minuten',
  overBudget: 'Cloud-Budget aufgebraucht',
} as const;

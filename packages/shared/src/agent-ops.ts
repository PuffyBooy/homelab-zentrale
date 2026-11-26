import { z } from 'zod';

/**
 * Agent actions of the optional operations modules (log search, vulnerability
 * scan, fail2ban). Kept apart from agent-protocol.ts so parallel milestones touch
 * that file only in one line (`...opsRpcParams`). This file must not import
 * agent-protocol.ts (it is spread into rpcParamsByAction at module load).
 *
 * All actions are read only except `fail2ban.unban`, which runs exactly
 * `fail2ban-client set <jail> unbanip <ip>` on the host with validated values.
 */

const containerRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const isoTs = z.iso.datetime();
const count = z.number().int().nonnegative();

/** Plain text, one line, no control characters. Never a regex (no ReDoS on the agent). */
export const logQuerySchema = z
  .string()
  .min(2)
  .max(200)
  .refine((q) => ![...q].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f), {
    message: 'single line, no control chars',
  });

export const LOG_SEARCH_MAX_MINUTES = 7 * 24 * 60;
/** Lines per container the agent reads at most (newest first). */
export const LOG_SEARCH_TAIL = 20_000;
export const LOG_SEARCH_MAX_MATCHES = 500;
/** Length of a returned line; longer lines are cut around the match. */
export const LOG_MATCH_MAX_CHARS = 1000;

/** fail2ban jail name (same rule as the inventory collector). */
export const jailNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
export const banIpSchema = z.union([z.ipv4(), z.ipv6()]);

/**
 * Trivy image the agent runs for `image.scan` (HZ_AGENT_TRIVY_IMAGE overrides).
 * Pinned by digest: the scanner never comes from a moving tag.
 */
export const TRIVY_IMAGE_DEFAULT =
  'aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb';
/** `repo[:tag]@sha256:<64 hex>`; the only image form the agent passes to trivy. */
export const pinnedImageRefSchema = z
  .string()
  .max(300)
  .regex(/^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]{1,128})?@sha256:[0-9a-f]{64}$/);
export const IMAGE_SCAN_MAX_VULNS = 100;

export const opsRpcParams = {
  /**
   * Searches the logs of containers on this host. Plain substring, the last
   * `sinceMinutes`, at most LOG_SEARCH_TAIL lines per container. `containers`
   * empty or missing: all containers. Result: logsSearchDataSchema.
   */
  'logs.search': z.strictObject({
    query: logQuerySchema,
    caseSensitive: z.boolean().default(false),
    sinceMinutes: z.number().int().min(5).max(LOG_SEARCH_MAX_MINUTES).default(60),
    containers: z.array(containerRef).max(200).optional(),
    maxMatches: z.number().int().min(1).max(LOG_SEARCH_MAX_MATCHES).default(200),
  }),
  /**
   * Vulnerability scan of the image a container runs. The agent resolves the
   * image digest itself (the core never names an image) and runs the pinned
   * Trivy image with `--image-src remote`: no Docker socket, read-only root,
   * cap-drop ALL, memory/pid limits, cache in the volume hz-trivy-cache.
   * Locally built images (no registry digest) are reported as not scannable.
   * Result: imageScanDataSchema.
   */
  'image.scan': z.strictObject({ id: containerRef }),
  /** Jails with banned IPs (`fail2ban-client status [jail]` on the host). Result: fail2banStatusDataSchema. */
  'fail2ban.status': z.strictObject({}),
  /** `fail2ban-client set <jail> unbanip <ip>`; the jail must exist. Result: null. */
  'fail2ban.unban': z.strictObject({ jail: jailNameSchema, ip: banIpSchema }),
} as const;

// ---- result data ----------------------------------------------------------------

export const logMatchSchema = z.strictObject({
  /** Docker container id (full or 12 chars) and name. */
  containerId: containerRef,
  containerName: z.string().max(128),
  /** Docker timestamp of the line, null if the line had none. */
  ts: isoTs.nullable(),
  stream: z.enum(['stdout', 'stderr']),
  text: z.string().max(LOG_MATCH_MAX_CHARS),
});
export type LogMatch = z.infer<typeof logMatchSchema>;

export const logsSearchDataSchema = z.strictObject({
  matches: z.array(logMatchSchema).max(LOG_SEARCH_MAX_MATCHES),
  scannedContainers: count,
  /** More matches existed than maxMatches, or a container hit LOG_SEARCH_TAIL. */
  truncated: z.boolean(),
});
export type LogsSearchData = z.infer<typeof logsSearchDataSchema>;

export const vulnSeveritySchema = z.enum(['CRITICAL', 'HIGH']);
export const vulnSchema = z.strictObject({
  id: z.string().max(64),
  pkg: z.string().max(200),
  installed: z.string().max(100),
  fixed: z.string().max(200).nullable(),
  severity: vulnSeveritySchema,
  title: z.string().max(300),
});
export type Vuln = z.infer<typeof vulnSchema>;

export const imageScanDataSchema = z.strictObject({
  /** Image as Docker shows it ("nginx:1.27"). */
  image: z.string().max(300),
  digest: z.string().max(80).nullable(),
  scannable: z.boolean(),
  /** Why not scannable: built locally / no registry digest, or the scan failed. */
  reason: z.enum(['local_image', 'scan_failed']).nullable(),
  counts: z.strictObject({ critical: count, high: count }),
  /** Critical first, then high; at most IMAGE_SCAN_MAX_VULNS. */
  vulns: z.array(vulnSchema).max(IMAGE_SCAN_MAX_VULNS),
  scannedAt: isoTs,
});
export type ImageScanData = z.infer<typeof imageScanDataSchema>;

export const fail2banJailSchema = z.strictObject({
  name: jailNameSchema,
  currentlyFailed: count,
  totalFailed: count,
  currentlyBanned: count,
  totalBanned: count,
  bannedIps: z.array(banIpSchema).max(1000),
});
export type Fail2banJail = z.infer<typeof fail2banJailSchema>;

export const fail2banStatusDataSchema = z.strictObject({
  /** false: fail2ban-client missing on the host or the service is not running. */
  installed: z.boolean(),
  jails: z.array(fail2banJailSchema).max(50),
});
export type Fail2banStatusData = z.infer<typeof fail2banStatusDataSchema>;

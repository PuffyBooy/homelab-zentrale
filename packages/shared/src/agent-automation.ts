import { z } from 'zod';

/**
 * M20/M21 agent actions (docs/ROADMAP.md): scheduled commands, speed test,
 * certificates and app folders. Merged into the allowlist of agent-protocol.ts
 * with `...automationRpcParams`, so the allowlist stays one object.
 *
 * Every path is built by the agent from a validated name; no path comes from
 * the wire.
 */

/** Folder name of an installed app: /opt/homelab/apps/<appId>/ (same rules as game folders). */
export const appIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/);
export const APPS_ROOT = '/opt/homelab/apps/';
/** Certificates are written to /opt/homelab/certs/<certName>/{fullchain,privkey}.pem. */
export const CERTS_ROOT = '/opt/homelab/certs/';

/** A DNS name with at most one leading wildcard label ("*.example.com"). Lower case. */
export const fqdnSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/);

/** Folder name of a certificate on a server ("example-com", "relay-example-com"). */
export const certNameSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])$/);

/** A single line of shell for scheduled tasks. No NUL, CR or LF. */
export const taskCommandSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine((c) => !/[\r\n\0]/.test(c), { message: 'single line only' })
  .refine((c) => c.trim().length > 0, { message: 'empty command' });

const pemCert = z
  .string()
  .max(64 * 1024)
  .regex(/^-----BEGIN CERTIFICATE-----\n[\s\S]+-----END CERTIFICATE-----\n?$/);
const pemKey = z
  .string()
  .max(16 * 1024)
  .regex(
    /^-----BEGIN (?:EC |RSA )?PRIVATE KEY-----\n[\s\S]+-----END (?:EC |RSA )?PRIVATE KEY-----\n?$/,
  );

/** Speed test limits per direction. */
export const SPEEDTEST_MAX_SECONDS = 20;
export const SPEEDTEST_MAX_BYTES = 500 * 1024 * 1024;
/** The only host the agent's speed test talks to. */
export const SPEEDTEST_HOST = 'speed.cloudflare.com';

/** Longest scheduled command (30 min); the agent kills the process group after it. */
export const TASK_MAX_TIMEOUT_SEC = 1800;
/** Output the agent returns from a command (tail, bytes). */
export const TASK_OUTPUT_MAX_BYTES = 16 * 1024;

export const automationRpcParams = {
  /**
   * M20 scheduled command. Only when the agent runs with HZ_AGENT_ALLOW_TASKS=1
   * (reported as capabilities.tasks); otherwise `not_allowed`. Runs
   * `/bin/sh -c <command>` on the host the same way the web console reaches
   * the host shell (actions/pty.ts), without a TTY, stdin closed, as root,
   * cwd /opt/homelab, a fixed minimal environment (PATH, HOME, LANG; no agent
   * token or other env of the agent). Kills the whole process group after
   * timeoutSec. At most one command per taskId at a time (`busy`), at most
   * 4 at once per agent (`busy`). Output: stdout+stderr interleaved, last
   * TASK_OUTPUT_MAX_BYTES, ANSI sequences stripped. The command is never logged
   * by the agent (only taskId, exit code, duration).
   * Result: taskExecDataSchema. Non-zero exit is ok:true with exitCode != 0.
   */
  'task.exec': z.strictObject({
    taskId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    command: taskCommandSchema,
    timeoutSec: z.number().int().min(5).max(TASK_MAX_TIMEOUT_SEC).default(300),
  }),
  /**
   * M20 speed test against https://speed.cloudflare.com only (fixed in the
   * agent, no URL from the wire, no redirects): latency = median of 10
   * `__down?bytes=0` round trips, jitter = mean abs difference; download with up
   * to 4 parallel `__down?bytes=` requests, upload with `__up` POSTs, each
   * direction stopped after maxSeconds or maxBytes. Colo from
   * /cdn-cgi/trace (only the `colo=` line). One test per agent at a time (`busy`).
   * Result: speedtestDataSchema.
   */
  'speedtest.run': z.strictObject({
    maxSeconds: z.number().int().min(3).max(SPEEDTEST_MAX_SECONDS).default(10),
    maxBytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(SPEEDTEST_MAX_BYTES)
      .default(100 * 1024 * 1024),
  }),
  /**
   * M20 certificate deploy. Writes /opt/homelab/certs/<name>/fullchain.pem (0644)
   * and privkey.pem (0600), each via O_EXCL temp file + rename, folder 0750,
   * never following symlinks. Content is never logged. Result: certWriteDataSchema.
   */
  'cert.write': z.strictObject({
    name: certNameSchema,
    fullchainPem: pemCert,
    privkeyPem: pemKey,
  }),
  /** Removes /opt/homelab/certs/<name>/ (regular files only). Missing is success. */
  'cert.remove': z.strictObject({ name: certNameSchema }),
  /**
   * M21: compose down (with --remove-orphans, never -v) and, with deleteData,
   * removal of /opt/homelab/apps/<appId>/ (no symlinks followed). Without
   * deleteData the folder stays (compose.yml, .env, data/). Missing folder is
   * success. Result: appRemoveDataSchema.
   */
  'app.remove': z.strictObject({ appId: appIdSchema, deleteData: z.boolean() }),
} as const;

export const taskExecDataSchema = z.strictObject({
  exitCode: z.number().int().nullable(),
  /** Killed after timeoutSec. */
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  output: z.string().max(TASK_OUTPUT_MAX_BYTES * 2),
  truncated: z.boolean(),
});
export type TaskExecData = z.infer<typeof taskExecDataSchema>;

export const speedtestDataSchema = z.strictObject({
  downloadMbps: z.number().finite().nonnegative(),
  uploadMbps: z.number().finite().nonnegative(),
  latencyMs: z.number().finite().nonnegative(),
  jitterMs: z.number().finite().nonnegative(),
  downloadBytes: z.number().int().nonnegative(),
  uploadBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  /** Cloudflare data center code ("VIE"), when /cdn-cgi/trace answered. */
  colo: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
});
export type SpeedtestData = z.infer<typeof speedtestDataSchema>;

export const certWriteDataSchema = z.strictObject({
  path: z.string().max(200),
});
export const appRemoveDataSchema = z.strictObject({
  removed: z.boolean(),
});

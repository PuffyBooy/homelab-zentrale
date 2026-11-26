import { z } from 'zod';
import { backupTargetStatusDataSchema, coreDbFileNameSchema } from '../agent-backup-target.js';
import { serverIdSchema } from './servers.js';

/**
 * M13b: NAS als Backup-Ziel (ROADMAP M13b, SPEC 5.4). Part of module `storage`.
 *
 * Every night at `time` (HZ_TIMEZONE) and on "Jetzt kopieren":
 * - each server in `serverIds` copies the backups of its game servers to its
 *   mounted /opt/homelab/backup-target (agent action backup.target.sync);
 * - the core takes a database snapshot (VACUUM INTO, secrets stay encrypted)
 *   and sends it to `dbServerId` (backup.target.store).
 * A target that is not mounted raises a warning and nothing is written.
 *
 * Routes (admin session; module `storage`):
 * GET  /api/storage/backup-target       -> BackupTargetResponse
 * PUT  /api/storage/backup-target       (step-up) BackupTargetSettings -> BackupTargetResponse
 * PUT: 400 invalid_input also for an unknown server id.
 * POST /api/storage/backup-target/run   -> 202 { started: true }, 409 busy (running), 409 conflict (off)
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const backupTargetSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** Servers with the share mounted at /opt/homelab/backup-target. */
  serverIds: z.array(serverIdSchema).max(20),
  /** Receives the nightly database snapshot; null: no database copy. */
  dbServerId: serverIdSchema.nullable(),
  /** Copies kept per game and of the database on the target. */
  keep: z.number().int().min(1).max(100),
  time: hhmm,
});
export type BackupTargetSettings = z.infer<typeof backupTargetSettingsSchema>;

export const BACKUP_TARGET_DEFAULTS: BackupTargetSettings = {
  enabled: false,
  serverIds: [],
  dbServerId: null,
  keep: 14,
  time: '05:00',
};

export const backupTargetErrorSchema = z.enum([
  /** Share not connected (folder missing or nothing mounted). */
  'not_mounted',
  'read_only',
  'offline',
  'no_space',
  /** Copy failed or did not match (agent reported io / bad_path, or the stream broke). */
  'failed',
]);
export type BackupTargetError = z.infer<typeof backupTargetErrorSchema>;

export const backupTargetRunSchema = z.strictObject({
  at: z.number().int().nonnegative(),
  ok: z.boolean(),
  copied: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  error: backupTargetErrorSchema.nullable(),
});
export type BackupTargetRun = z.infer<typeof backupTargetRunSchema>;

export const backupTargetServerSchema = z.strictObject({
  serverId: serverIdSchema,
  name: z.string().max(64),
  online: z.boolean(),
  /** Last answer of backup.target.status (null: never asked or offline). */
  status: backupTargetStatusDataSchema.nullable(),
  statusAt: z.number().int().nonnegative().nullable(),
  lastRun: backupTargetRunSchema.nullable(),
});
export type BackupTargetServer = z.infer<typeof backupTargetServerSchema>;

export const backupTargetResponseSchema = z.strictObject({
  settings: backupTargetSettingsSchema,
  running: z.boolean(),
  nextRunAt: z.number().int().nonnegative().nullable(),
  servers: z.array(backupTargetServerSchema),
  db: z.strictObject({
    lastRun: backupTargetRunSchema
      .extend({ fileName: coreDbFileNameSchema.nullable() })
      .strict()
      .nullable(),
  }),
});
export type BackupTargetResponse = z.infer<typeof backupTargetResponseSchema>;

/** POST /api/storage/backup-target/run (202). */
export const backupTargetRunStartedSchema = z.strictObject({ started: z.literal(true) });

export const backupTargetAlertKey = (
  part: { serverId: string; kind: 'mount' | 'sync' } | { kind: 'db' },
): string =>
  part.kind === 'db' ? 'backup-target:db' : `backup-target:${part.serverId}:${part.kind}`;
export const BACKUP_TARGET_ALERT_PREFIX = 'backup-target:';

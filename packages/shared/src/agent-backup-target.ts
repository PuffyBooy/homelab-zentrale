import { z } from 'zod';

/**
 * M13b: second copy of backups on a NAS (or any other mounted disk).
 *
 * The admin mounts a share (SMB/CIFS, NFS, a USB disk ...) on the server at
 * /opt/homelab/backup-target (docs: deploy/README.md). The NAS itself runs no
 * agent and is not changed. The agent writes ONLY when that path is its own
 * mount point in the host mount table, so a share that dropped never fills the
 * server's own disk. Layout on the target:
 *
 *   games/<gameId>/<gameId>-YYYYMMDD-HHMMSS.tar.zst   copies of game.backup archives
 *   core/homelab-zentrale-YYYYMMDD-HHMM.sqlite        nightly database snapshot
 *
 * Nothing else is ever written or deleted there: retention only removes files
 * whose names match these patterns, never follows symlinks and leaves foreign
 * files alone.
 *
 * Kept apart from agent-protocol.ts like agent-ops.ts (that file only spreads
 * `backupTargetRpcParams`). Must not import agent-protocol.ts.
 */

/** Below the homelab root (/opt/homelab/backup-target). */
export const BACKUP_TARGET_DIR = 'backup-target';
/** Largest database snapshot the agent accepts (4 GiB). */
export const CORE_DB_MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** Space that must stay free on the target after a copy. */
export const BACKUP_TARGET_RESERVE_BYTES = 64 * 1024 * 1024;
export const BACKUP_TARGET_MAX_GAMES = 200;

/** Same rule as gameFolderNameSchema (agent-protocol.ts). */
const gameId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])$/);
const count = z.number().int().nonnegative();
const keep = z.number().int().min(1).max(100);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** Same as exportFileName() of the core (local time). */
export const coreDbFileNameSchema = z.string().regex(/^homelab-zentrale-\d{8}-\d{4}\.sqlite$/);
/** Same rule as TRANSFER_CHUNK_BYTES chunks (48 KiB) for CORE_DB_MAX_BYTES. */
const MAX_DB_CHUNKS = Math.ceil(CORE_DB_MAX_BYTES / (48 * 1024));

export const backupTargetRpcParams = {
  /** Is /opt/homelab/backup-target a mount point, how full, which copies are there. Result: backupTargetStatusDataSchema. */
  'backup.target.status': z.strictObject({}),
  /**
   * Copies the game.backup archives of these games from /opt/homelab/backups/<gameId>/
   * to the target (only files not there yet or with a different size), verifies each
   * copy by reading it back (sha256), renames it into place and keeps the newest
   * `keep` per game on the target. One sync or store at a time (`busy`).
   * Result: backupTargetSyncDataSchema (state != mounted: nothing was written).
   */
  'backup.target.sync': z.strictObject({
    gameIds: z.array(gameId).max(BACKUP_TARGET_MAX_GAMES),
    keep: keep.default(14),
  }),
  /**
   * Stream, the core sends (like game.import): transfer.chunk seq 0..chunks-1, the
   * agent writes them to core/.<fileName>.<random>.partial on the target and acks;
   * on transfer.end it compares bytes and sha256, renames to core/<fileName> and
   * keeps the newest `keep`. Refused with `failed` when the target is not mounted,
   * `busy` while a sync or store runs. Last progress line: `result {json}`
   * (backupTargetStoreDataSchema).
   */
  'backup.target.store': z.strictObject({
    fileName: coreDbFileNameSchema,
    bytes: z.number().int().min(1).max(CORE_DB_MAX_BYTES),
    sha256,
    chunks: z.number().int().min(1).max(MAX_DB_CHUNKS),
    keep: keep.default(14),
  }),
} as const;

// ---- result data ----------------------------------------------------------------

/**
 * missing: the folder does not exist. not_mounted: it exists but nothing is
 * mounted there (the share is not connected). read_only: mounted read-only.
 * mounted: ready.
 */
export const backupTargetStateSchema = z.enum(['missing', 'not_mounted', 'read_only', 'mounted']);
export type BackupTargetState = z.infer<typeof backupTargetStateSchema>;

export const backupTargetStatusDataSchema = z.strictObject({
  state: backupTargetStateSchema,
  /** File system type of the mount (cifs, nfs4, ext4 ...), null when not mounted. */
  fs: z.string().max(32).nullable(),
  freeBytes: count.nullable(),
  totalBytes: count.nullable(),
  /** Copies per game on the target (at most BACKUP_TARGET_MAX_GAMES). */
  games: z
    .array(
      z.strictObject({
        gameId,
        files: count,
        bytes: count,
        /** Name of the newest copy. */
        newest: z.string().max(80).nullable(),
      }),
    )
    .max(BACKUP_TARGET_MAX_GAMES),
  core: z.strictObject({ files: count, bytes: count, newest: z.string().max(80).nullable() }),
});
export type BackupTargetStatusData = z.infer<typeof backupTargetStatusDataSchema>;

export const backupTargetSyncDataSchema = z.strictObject({
  state: backupTargetStateSchema,
  games: z
    .array(
      z.strictObject({
        gameId,
        copied: count,
        skipped: count,
        removed: count,
        bytes: count,
        /** io: read/write failed or the copy did not match; no_space; bad_path: a symlink or non-folder in the way. */
        error: z.enum(['io', 'no_space', 'bad_path']).nullable(),
      }),
    )
    .max(BACKUP_TARGET_MAX_GAMES),
  freeBytes: count.nullable(),
  totalBytes: count.nullable(),
});
export type BackupTargetSyncData = z.infer<typeof backupTargetSyncDataSchema>;

export const backupTargetStoreDataSchema = z.strictObject({
  fileName: coreDbFileNameSchema,
  bytes: count,
  sha256,
  removed: count,
});
export type BackupTargetStoreData = z.infer<typeof backupTargetStoreDataSchema>;

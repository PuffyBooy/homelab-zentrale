import { z } from 'zod';
import { MIGRATION_MAX_BYTES, sha256Schema } from '../agent-protocol.js';
import { gamePortChangeSchema, portProtocolSchema } from './games.js';
import { serverIdSchema } from './servers.js';

/**
 * M11: move a game server to another server (ROADMAP M11).
 *
 * POST /api/games/:id/migrate (session + step-up, module games) -> 202 { migrationId }
 *   400 invalid_input: target = current server. 404 not_found: game/target.
 *   409 agent_offline: source or target agent not connected. 409 busy: a
 *   migration, setup or backup of this game is running. 409 conflict: ports
 *   taken on the target, or /opt/homelab/games/<name>/ exists there.
 *   409 insufficient_ram: like a game start on the target.
 * GET /api/games/:id/migration (session) -> { migration } (the latest, or null).
 *   The web polls every MIGRATION_POLL_MS while phase is not done/failed;
 *   progress lines also go to the existing topic game:<id> (gameEventSchema).
 * GET /api/games/:id/migration/suggest?targetServerId= (session)
 *   -> MigrationSuggestResponse (free ports on the target, forwarding hint, RAM).
 * POST /api/games/:id/migration/cancel (session) -> { migration }; only before
 *   phase `start`, otherwise 409 conflict. Result: failed / cancelled.
 *
 * Phases (MIGRATION_PHASES, in order):
 *   backup    core saves via RCON and stops the source game, then the source
 *             agent builds the archive (game.export, data/ only)
 *   transfer  chunks source -> core -> target (game.import), piped, never more
 *             than MIGRATION_MAX_BYTES, sha256 compared at the end
 *   restore   target verified and extracted data/; core writes compose.yml and
 *             .env with the new ports (compose.write; secrets from the DB)
 *   start     compose.up on the target, wait until the game answers
 *             (game.status), then the game record points to the target
 *   stop_old  source already stopped; its folder stays as a fallback
 *   done | failed
 * Failure before `stop_old`: the target copy is removed (stream.cancel,
 * game.remove on the target), the source was never touched and keeps
 * running, the game stays on the source. Failure in `stop_old`: the game runs
 * on the target and the old one still runs; rollback tells the admin to stop it.
 * A core restart marks a running migration failed (`interrupted`) with the same
 * cleanup on the next connect of the target agent.
 * Audit: game.migrate (start, done, failed) with source, target, bytes.
 *
 * Data safety (decision 2026-11-26, overrides the notes above, implemented in
 * apps/core/src/games/migrate.ts): before the backup the core saves the world
 * via RCON when the template has a save command and STOPS the source game
 * (compose down), so no write after the archive is lost. `stop_old` then only
 * marks the source folder as kept. On a failure before the target start
 * succeeded, the target copy is removed (game.remove, only if the import was
 * accepted) and the source is started again if it ran before; otherwise the
 * source stays unchanged. Audit actions: game.migrate_started / _done / _failed.
 */

export const MIGRATION_POLL_MS = 2000;

export const MIGRATION_PHASES = [
  'backup',
  'transfer',
  'restore',
  'start',
  'stop_old',
  'done',
  'failed',
] as const;
export const migrationPhaseSchema = z.enum(MIGRATION_PHASES);
export type MigrationPhase = z.infer<typeof migrationPhaseSchema>;
/** Phases in which a migration is still running. */
export const migrationActivePhases: readonly MigrationPhase[] = [
  'backup',
  'transfer',
  'restore',
  'start',
  'stop_old',
];

export const migrationErrorCodeSchema = z.enum([
  'agent_offline',
  /** game.export failed on the source (stream.end != 0). */
  'export_failed',
  /** Archive larger than MIGRATION_MAX_BYTES. */
  'too_large',
  /** Bytes or sha256 differ between source and target. */
  'checksum_mismatch',
  /** Target refused an archive member (path traversal, symlink, absolute path). */
  'bad_archive',
  /** Target already has /opt/homelab/games/<name>/data. */
  'target_exists',
  /** game.import or compose.write failed on the target. */
  'restore_failed',
  /** compose.up failed or the game did not answer in time on the target. */
  'start_failed',
  /** compose.down on the source failed. Game runs on the target. */
  'stop_old_failed',
  'timeout',
  'cancelled',
  /** The core restarted during the migration. */
  'interrupted',
  /** The target no longer has enough free RAM (checked again before transfer and start). */
  'insufficient_ram',
  /** The source game could not be stopped before the backup (see "data safety" below). */
  'stop_failed',
]);
export type MigrationErrorCode = z.infer<typeof migrationErrorCodeSchema>;

export const migrationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

// POST /api/games/:id/migrate
export const gameMigrateRequestSchema = z.strictObject({
  targetServerId: serverIdSchema,
  /** Start port per template port name; names not given use the suggestion. */
  ports: z
    .record(z.string().regex(/^[a-z][a-z0-9]{0,15}$/), z.number().int().min(1024).max(65535))
    .refine((p) => Object.keys(p).length >= 1 && Object.keys(p).length <= 5, {
      message: '1 to 5 ports',
    })
    .optional(),
});
export type GameMigrateRequest = z.infer<typeof gameMigrateRequestSchema>;
export const gameMigrateResponseSchema = z.strictObject({ migrationId: migrationIdSchema });
export type GameMigrateResponse = z.infer<typeof gameMigrateResponseSchema>;

// GET /api/games/:id/migration/suggest?targetServerId=
export const migrationSuggestQuerySchema = z.strictObject({ targetServerId: serverIdSchema });
export const migrationSuggestResponseSchema = z.strictObject({
  /** Suggested start port per template port name on the target. */
  ports: z.record(z.string(), z.number().int()),
  /** Ports that differ from the current ones. */
  changed: z.array(gamePortChangeSchema),
  /** German, e.g. "Portweiterleitung am Ziel einrichten: game 25570 (TCP)"; null if none needed. */
  forwardingHint: z.string().nullable(),
  freeRamBytes: z.number().nullable(),
  ramWarning: z.string().nullable(),
});
export type MigrationSuggestResponse = z.infer<typeof migrationSuggestResponseSchema>;

export const migrationSchema = z.strictObject({
  id: migrationIdSchema,
  gameId: z.string(),
  sourceServerId: z.string(),
  sourceServerName: z.string(),
  targetServerId: z.string(),
  targetServerName: z.string(),
  phase: migrationPhaseSchema,
  /** Phase that failed, only when phase is `failed`. */
  failedPhase: migrationPhaseSchema.exclude(['done', 'failed']).nullable(),
  progress: z.strictObject({
    /** Bytes received by the target so far. */
    bytesDone: z.number().int().nonnegative().max(MIGRATION_MAX_BYTES),
    /** Known after the archive is built (transfer.begin). */
    bytesTotal: z.number().int().nonnegative().max(MIGRATION_MAX_BYTES).nullable(),
  }),
  /** sha256 of the archive, known after transfer.begin. */
  sha256: sha256Schema.nullable(),
  error: migrationErrorCodeSchema.nullable(),
  /** Fixed German text for the error, never agent output. */
  errorText: z.string().max(200).nullable(),
  /** German, e.g. "Der alte Server ist unverändert und läuft weiter." */
  rollback: z.string().max(300).nullable(),
  /** Host ports on the target. */
  ports: z.array(
    z.strictObject({
      name: z.string(),
      port: z.number().int(),
      protocol: portProtocolSchema,
      count: z.number().int(),
      local: z.boolean(),
    }),
  ),
  forwardingHint: z.string().nullable(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type Migration = z.infer<typeof migrationSchema>;

export const gameMigrationResponseSchema = z.strictObject({
  migration: migrationSchema.nullable(),
});
export type GameMigrationResponse = z.infer<typeof gameMigrationResponseSchema>;

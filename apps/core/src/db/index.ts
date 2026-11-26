import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrations as allMigrations, type Migration } from './migrations.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  sqlite: Database.Database;
  db: Db;
  /** Versions applied by this open() call. */
  applied: number[];
  close(): void;
}

/** Backups written before migrations; the newest are kept. */
export const MIGRATION_BACKUPS_KEPT = 3;
const BACKUP_NAME = /^backup-before-migration-\d+-to-\d+\.sqlite$/;

/** Stored schema version (0 for a new database). */
export function schemaVersion(sqlite: Database.Database): number {
  const table = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!table) return 0;
  const row = sqlite.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

/**
 * Consistent copy of the database (VACUUM INTO, works with WAL) to
 * `<dir>/backup-before-migration-<from>-to-<to>.sqlite`, mode 0600. Keeps the
 * newest MIGRATION_BACKUPS_KEPT backups. A core update that rolls back to the
 * old image can be paired with the database it knew.
 */
export function backupBeforeMigration(
  sqlite: Database.Database,
  dir: string,
  from: number,
  to: number,
): string {
  const file = join(dir, `backup-before-migration-${from}-to-${to}.sqlite`);
  // A failed earlier attempt with the same versions: replace it.
  if (existsSync(file)) unlinkSync(file);
  // Created empty with 0600 first (VACUUM INTO accepts an empty file), so the copy
  // is never readable by others, whatever the umask.
  closeSync(openSync(file, 'wx', 0o600));
  sqlite.prepare('VACUUM INTO ?').run(file);
  chmodSync(file, 0o600);
  // Newest first; the backup just written always stays.
  const others = readdirSync(dir)
    .filter((n) => BACKUP_NAME.test(n))
    .map((n) => join(dir, n))
    .filter((p) => p !== file)
    .map((p) => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t || b.p.localeCompare(a.p));
  for (const o of others.slice(MIGRATION_BACKUPS_KEPT - 1)) unlinkSync(o.p);
  return file;
}

export interface OpenOptions {
  /** Where backups before migrations go. Default: the folder of the database (HZ_DATA_DIR). */
  backupDir?: string;
}

/**
 * Opens (or creates) the SQLite database and applies pending migrations.
 * Pass `:memory:` for tests. File databases use WAL. Before pending migrations
 * of an existing file database, a backup is written (backupBeforeMigration).
 */
export function openDatabase(
  path: string,
  migrations: readonly Migration[] = allMigrations,
  opts: OpenOptions = {},
): DbHandle {
  const sqlite = new Database(path);
  try {
    if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('synchronous = NORMAL');
    const from = schemaVersion(sqlite);
    const to = migrations.length;
    if (path !== ':memory:' && from > 0 && from < to) {
      backupBeforeMigration(sqlite, opts.backupDir ?? dirname(path), from, to);
    }
    const applied = migrate(sqlite, migrations);
    const db = drizzle(sqlite, { schema });
    return {
      sqlite,
      db,
      applied,
      close: () => {
        if (sqlite.open) sqlite.close();
      },
    };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

/** Applies every migration newer than the stored version, each in its own transaction. */
export function migrate(sqlite: Database.Database, migrations: readonly Migration[]): number[] {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error('migrations must be numbered 1..n without gaps');
  });

  const row = sqlite.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  const current = row.v ?? 0;
  if (current > sorted.length) {
    throw new Error(
      `database schema version ${current} is newer than this build (${sorted.length})`,
    );
  }

  const insert = sqlite.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  const applied: number[] = [];
  for (const m of sorted) {
    if (m.version <= current) continue;
    sqlite.transaction(() => {
      sqlite.exec(m.sql);
      insert.run(m.version, m.name, Date.now());
    })();
    applied.push(m.version);
  }
  return applied;
}

export { schema };

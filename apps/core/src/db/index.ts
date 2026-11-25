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

/**
 * Opens (or creates) the SQLite database and applies pending migrations.
 * Pass `:memory:` for tests. File databases use WAL.
 */
export function openDatabase(
  path: string,
  migrations: readonly Migration[] = allMigrations,
): DbHandle {
  const sqlite = new Database(path);
  try {
    if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('synchronous = NORMAL');
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

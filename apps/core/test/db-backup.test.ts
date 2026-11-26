import { existsSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATION_BACKUPS_KEPT, openDatabase, schemaVersion } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
import { emptyDir } from './helpers.js';

const backups = (dir: string) =>
  readdirSync(dir)
    .filter((n) => n.startsWith('backup-before-migration-'))
    .sort();

/** A database at schema version `v` with one row to find in the backup. */
function oldDatabase(dir: string, v: number): string {
  const file = join(dir, 'hz.sqlite');
  const h = openDatabase(file, migrations.slice(0, v));
  h.sqlite
    .prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('marker', '1', 1)")
    .run();
  h.close();
  return file;
}

describe('backup before migrations', () => {
  it('copies the database before pending migrations (0600, old schema, data inside)', () => {
    const dir = emptyDir();
    const from = migrations.length - 1;
    const file = oldDatabase(dir, from);
    const h = openDatabase(file);
    expect(h.applied).toEqual([migrations.length]);
    h.close();
    const name = `backup-before-migration-${from}-to-${migrations.length}.sqlite`;
    expect(backups(dir)).toEqual([name]);
    const path = join(dir, name);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const copy = new Database(path, { readonly: true });
    expect(schemaVersion(copy)).toBe(from);
    expect(copy.prepare("SELECT value_json AS v FROM settings WHERE key = 'marker'").get()).toEqual(
      { v: '1' },
    );
    copy.close();
  });

  it('no backup for a new database or when nothing is pending', () => {
    const dir = emptyDir();
    openDatabase(join(dir, 'hz.sqlite')).close();
    expect(backups(dir)).toEqual([]);
    openDatabase(join(dir, 'hz.sqlite')).close();
    expect(backups(dir)).toEqual([]);
    expect(existsSync(join(dir, 'hz.sqlite'))).toBe(true);
  });

  it(`keeps the newest ${MIGRATION_BACKUPS_KEPT} backups, never other files`, () => {
    const dir = emptyDir();
    const old = [1, 2, 3, 4].map((i) => `backup-before-migration-${i}-to-${i + 1}.sqlite`);
    old.forEach((n, i) => {
      writeFileSync(join(dir, n), 'x');
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      utimesSync(join(dir, n), t, t);
    });
    writeFileSync(join(dir, 'backup-other.sqlite'), 'keep');
    const file = oldDatabase(dir, migrations.length - 1);
    openDatabase(file).close();
    expect(backups(dir)).toEqual(
      [
        'backup-before-migration-3-to-4.sqlite',
        'backup-before-migration-4-to-5.sqlite',
        `backup-before-migration-${migrations.length - 1}-to-${migrations.length}.sqlite`,
      ].sort(),
    );
    expect(existsSync(join(dir, 'backup-other.sqlite'))).toBe(true);
  });

  it('uses the backup dir if given', () => {
    const dir = emptyDir();
    const other = emptyDir();
    const file = oldDatabase(dir, migrations.length - 1);
    openDatabase(file, migrations, { backupDir: other }).close();
    expect(backups(dir)).toEqual([]);
    expect(backups(other)).toHaveLength(1);
  });
});

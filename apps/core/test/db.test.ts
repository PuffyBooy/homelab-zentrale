import { join } from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DbHandle } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
import * as schema from '../src/db/schema.js';
import { emptyDir } from './helpers.js';

let h: DbHandle | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

const tables = [
  schema.users,
  schema.sessions,
  schema.recoveryCodes,
  schema.auditLog,
  schema.settings,
  schema.servers,
  schema.serverState,
  schema.agentTokens,
  schema.enrollTokens,
  schema.metricsRaw,
  schema.metrics5m,
  schema.metrics1h,
  schema.containers,
  schema.alerts,
  schema.checks,
  schema.checkResults,
  schema.certStatus,
  schema.pushSubscriptions,
  schema.githubRepos,
  schema.githubBranches,
  schema.githubEtags,
  schema.deployTargets,
  schema.deploys,
  schema.gameServers,
  schema.gameBackups,
  schema.shareLinks,
  schema.shareAudit,
  schema.haEnergyMonths,
  schema.consoleSessions,
  schema.wallDevices,
  schema.pushDigestItems,
  schema.deletedGameBackups,
  schema.containerPriorities,
  schema.serverThrottle,
  schema.containerThrottles,
  schema.wichtigRestarts,
  schema.onboardingCodes,
  schema.serverAllowedPorts,
  schema.serverPortAudit,
  schema.gameMigrations,
  schema.gameSchedules,
  schema.gameNotify,
  schema.gamePlayerSessions,
  schema.gamePlayerHours,
  schema.gameMods,
  schema.whitelistRequests,
  schema.cloudMachines,
  schema.cloudUsage,
];

describe('database', () => {
  it('applies all migrations once and records the versions', () => {
    const dir = emptyDir();
    const file = join(dir, 'hz.sqlite');
    h = openDatabase(file);
    expect(h.applied).toEqual(migrations.map((m) => m.version));
    expect(h.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(h.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    h.close();
    h = openDatabase(file);
    expect(h.applied).toEqual([]);
    const versions = h.sqlite.prepare('SELECT version FROM schema_migrations').all();
    expect(versions).toEqual(migrations.map((m) => ({ version: m.version })));
  });

  it('applies only new migrations on an existing database', () => {
    const file = join(emptyDir(), 'hz.sqlite');
    openDatabase(file, migrations.slice(0, 1)).close();
    const next = [
      ...migrations,
      { version: migrations.length + 1, name: 'extra', sql: 'CREATE TABLE extra (id INTEGER)' },
    ];
    h = openDatabase(file, next);
    expect(h.applied).toEqual(next.slice(1).map((m) => m.version));
  });

  it('refuses a database from a newer build', () => {
    const file = join(emptyDir(), 'hz.sqlite');
    openDatabase(file, [
      ...migrations,
      { version: migrations.length + 1, name: 'future', sql: 'CREATE TABLE future (id INTEGER)' },
    ]).close();
    expect(() => openDatabase(file)).toThrow(/newer than this build/);
  });

  it('rolls back a failing migration', () => {
    const file = join(emptyDir(), 'hz.sqlite');
    const broken = [
      ...migrations,
      {
        version: migrations.length + 1,
        name: 'broken',
        sql: 'CREATE TABLE half (id INTEGER); THIS IS NOT SQL;',
      },
    ];
    expect(() => openDatabase(file, broken)).toThrow();
    h = openDatabase(file);
    const half = h.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='half'")
      .get();
    expect(half).toBeUndefined();
  });

  it('rejects gaps in the numbering', () => {
    expect(() => openDatabase(':memory:', [{ version: 2, name: 'gap', sql: 'SELECT 1' }])).toThrow(
      /without gaps/,
    );
  });

  it('drizzle schema matches the migrated tables', () => {
    h = openDatabase(':memory:');
    for (const table of tables) {
      const name = getTableName(table);
      const dbCols = (
        h.sqlite.prepare(`PRAGMA table_info(${name})`).all() as { name: string; notnull: number }[]
      )
        .map((c) => `${c.name}:${c.notnull}`)
        .sort();
      const drizzleCols = Object.values(getTableColumns(table))
        .map((c) => `${c.name}:${c.notNull ? 1 : 0}`)
        .sort();
      // SQLite reports INTEGER PRIMARY KEY / TEXT PRIMARY KEY as nullable=0 only if declared.
      expect(
        dbCols.map((c) => c.split(':')[0]),
        name,
      ).toEqual(drizzleCols.map((c) => c.split(':')[0]));
    }
  });

  it('migration 10: keeps configured modules on, existing wall devices keep their cookie', () => {
    const file = join(emptyDir(), 'm10.sqlite');
    const v9 = openDatabase(
      file,
      migrations.filter((m) => m.version <= 9),
    );
    v9.sqlite.exec(`
      INSERT INTO settings VALUES ('github.token', '"enc"', 0);
      INSERT INTO settings VALUES ('ha.settings', '{"url":"http://192.0.2.20:8123"}', 0);
      INSERT INTO wall_devices VALUES ('d1', 'Tablet', 'hash-paired', 0, 5);
      INSERT INTO wall_devices VALUES ('d2', 'Neu', 'hash-new', 0, NULL);`);
    v9.close();
    h = openDatabase(file);
    const modules = h.sqlite
      .prepare("SELECT value_json v FROM settings WHERE key = 'modules'")
      .get() as {
      v: string;
    };
    expect(JSON.parse(modules.v)).toEqual({ github: true, homeassistant: true, games: true });
    expect(
      h.sqlite
        .prepare('SELECT id, token_hash, session_hash, paired_at FROM wall_devices ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'd1', token_hash: null, session_hash: 'hash-paired', paired_at: 5 },
      { id: 'd2', token_hash: 'hash-new', session_hash: null, paired_at: null },
    ]);
  });

  it('migration 10 on a fresh install: games on, github and homeassistant off', () => {
    h = openDatabase(':memory:');
    const modules = h.sqlite
      .prepare("SELECT value_json v FROM settings WHERE key = 'modules'")
      .get() as {
      v: string;
    };
    expect(JSON.parse(modules.v)).toEqual({ github: false, homeassistant: false, games: true });
  });

  it('cascades user deletion to sessions and recovery codes', () => {
    h = openDatabase(':memory:');
    h.sqlite.exec(`INSERT INTO users VALUES (1,'admin','h','e',NULL,0,0);
      INSERT INTO sessions VALUES ('s','th',1,0,0,1,'',NULL);
      INSERT INTO recovery_codes VALUES (1,1,'c',0,NULL);
      DELETE FROM users;`);
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM sessions').get()).toEqual({ n: 0 });
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM recovery_codes').get()).toEqual({ n: 0 });
  });
});

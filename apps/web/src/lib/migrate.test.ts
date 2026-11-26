import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import { migration, server } from '../test-fixtures.js';
import {
  canCancelMigration,
  cancelMigration,
  changedPortLines,
  fetchMigration,
  fetchMigrationSuggest,
  isMigrationActive,
  migrateErrorText,
  migrationSentence,
  migrationStatus,
  migrationTargets,
  progressText,
  showMigration,
  startMigration,
  stepStates,
} from './migrate.js';

const GB = 1024 ** 3;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('migrate api', () => {
  it('suggest, migrate, poll and cancel on the game routes', async () => {
    const fn = vi.fn<typeof fetch>();
    fn.mockResolvedValueOnce(
      json(200, {
        ports: { game: 25570 },
        changed: [],
        forwardingHint: null,
        freeRamBytes: 8 * GB,
        ramWarning: null,
      }),
    );
    fn.mockResolvedValueOnce(json(202, { migrationId: 'mig_00000001' }));
    fn.mockResolvedValueOnce(json(200, { migration: migration() }));
    fn.mockResolvedValueOnce(
      json(200, {
        migration: migration({ phase: 'failed', failedPhase: 'transfer', error: 'cancelled' }),
      }),
    );
    vi.stubGlobal('fetch', fn);
    await fetchMigrationSuggest('game-000001', 'srv-000002');
    await expect(startMigration('game-000001', { targetServerId: 'srv-000002' })).resolves.toEqual({
      migrationId: 'mig_00000001',
    });
    await expect(fetchMigration('game-000001')).resolves.toMatchObject({ phase: 'transfer' });
    await expect(cancelMigration('game-000001')).resolves.toMatchObject({ phase: 'failed' });
    expect(fn.mock.calls.map((c) => [c[0], c[1]?.method ?? 'GET'])).toEqual([
      ['/api/games/game-000001/migration/suggest?targetServerId=srv-000002', 'GET'],
      ['/api/games/game-000001/migrate', 'POST'],
      ['/api/games/game-000001/migration', 'GET'],
      ['/api/games/game-000001/migration/cancel', 'POST'],
    ]);
    expect(fn.mock.calls[1]?.[1]?.body).toBe('{"targetServerId":"srv-000002"}');
  });
});

describe('migrate helpers', () => {
  it('targets: online servers except the current one, by name', () => {
    const list = [
      server({ id: 'srv-000001', name: 'heimserver' }),
      server({ id: 'srv-000002', name: 'pi' }),
      server({ id: 'srv-000003', name: 'oracle-a1' }),
      server({ id: 'srv-000004', name: 'alt', connected: false }),
    ];
    expect(migrationTargets(list, { serverId: 'srv-000001' }).map((s) => s.name)).toEqual([
      'oracle-a1',
      'pi',
    ]);
  });

  it('step states follow the phase; failed marks the failed step', () => {
    expect(stepStates(migration({ phase: 'restore' })).map((s) => s.state)).toEqual([
      'done',
      'done',
      'active',
      'pending',
      'pending',
    ]);
    expect(
      stepStates(migration({ phase: 'failed', failedPhase: 'start' })).map((s) => s.state),
    ).toEqual(['done', 'done', 'done', 'failed', 'pending']);
    expect(stepStates(migration({ phase: 'done' })).every((s) => s.state === 'done')).toBe(true);
  });

  it('cancel only before start', () => {
    expect(canCancelMigration(migration({ phase: 'backup' }))).toBe(true);
    expect(canCancelMigration(migration({ phase: 'restore' }))).toBe(true);
    expect(canCancelMigration(migration({ phase: 'start' }))).toBe(false);
    expect(canCancelMigration(migration({ phase: 'done' }))).toBe(false);
    expect(isMigrationActive(migration({ phase: 'stop_old' }))).toBe(true);
    expect(isMigrationActive(migration({ phase: 'failed' }))).toBe(false);
    expect(isMigrationActive(null)).toBe(false);
  });

  it('progress in de-AT', () => {
    expect(progressText({ bytesDone: 1.2 * GB, bytesTotal: 3.4 * GB })).toBe(
      '1,2 GB von 3,4 GB · 35 %',
    );
    expect(progressText({ bytesDone: 512 * 1024 ** 2, bytesTotal: null })).toBe('512 MB');
  });

  it('status and sentence', () => {
    expect(migrationStatus(migration())).toBe('busy');
    expect(migrationStatus(migration({ phase: 'done' }))).toBe('ok');
    expect(migrationStatus(migration({ phase: 'failed' }))).toBe('crit');
    expect(migrationSentence(migration(), 'survival')).toBe(
      'survival zieht von heimserver nach oracle-a1 um: Übertragen …',
    );
    expect(migrationSentence(migration({ phase: 'done' }), 'survival')).toBe(
      'survival läuft jetzt auf oracle-a1.',
    );
    expect(
      migrationSentence(migration({ phase: 'failed', failedPhase: 'transfer' }), 'survival'),
    ).toBe('Umzug nach oracle-a1 fehlgeschlagen beim Schritt „Übertragen“.');
  });

  it('changed ports as from → to', () => {
    expect(
      changedPortLines([
        { name: 'game', protocol: 'tcp', count: 1, from: 25565, to: 25570, local: false },
        { name: 'rcon', protocol: 'tcp', count: 1, from: 25575, to: 25576, local: true },
      ]),
    ).toEqual(['game 25565 → 25570/TCP', 'rcon 25575 → 25576/TCP · nur lokal']);
  });

  it('error texts of POST migrate', () => {
    expect(migrateErrorText(null)).toBeNull();
    expect(migrateErrorText(new ApiError(403, 'step_up_required'))).toBeNull();
    expect(migrateErrorText(new ApiError(409, 'agent_offline'))).toContain('offline');
    expect(migrateErrorText(new ApiError(409, 'busy'))).toContain('Umzug, Setup oder Backup');
    expect(migrateErrorText(new ApiError(409, 'conflict'))).toContain('Port belegt');
    expect(migrateErrorText(new ApiError(409, 'conflict', undefined, 'Port 25570 belegt.'))).toBe(
      'Port 25570 belegt.',
    );
  });

  it('shows a finished migration for one hour', () => {
    const now = new Date('2026-11-26T23:00:00.000Z');
    expect(showMigration(migration(), now)).toBe(true);
    expect(
      showMigration(migration({ phase: 'done', finishedAt: '2026-11-26T22:30:00.000Z' }), now),
    ).toBe(true);
    expect(
      showMigration(migration({ phase: 'done', finishedAt: '2026-11-26T21:30:00.000Z' }), now),
    ).toBe(false);
    expect(showMigration(null, now)).toBe(false);
  });
});

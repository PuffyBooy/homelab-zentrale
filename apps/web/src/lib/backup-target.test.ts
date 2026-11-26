import { describe, expect, it } from 'vitest';
import type { BackupTargetServer } from '@hz/shared';
import { runLine, targetLine, targetStatus } from './backup-target.js';
import { formatDateTime } from './format.js';

const AT = Date.UTC(2026, 10, 27, 4, 0);
const WHEN = formatDateTime(new Date(AT));

const STATUS: NonNullable<BackupTargetServer['status']> = {
  state: 'mounted',
  fs: 'cifs',
  freeBytes: 412 * 1024 ** 3,
  totalBytes: 1000 * 1024 ** 3,
  games: [{ gameId: 'mc', files: 3, bytes: 1, newest: null }],
  core: { files: 2, bytes: 1, newest: null },
};
const RUN: NonNullable<BackupTargetServer['lastRun']> = {
  at: AT,
  ok: true,
  copied: 3,
  bytes: 2.1 * 1024 ** 3,
  error: null,
};
const base: BackupTargetServer = {
  serverId: 'srv_00000001',
  name: 'heimserver',
  online: true,
  status: STATUS,
  statusAt: 1,
  lastRun: RUN,
};

describe('backup target view', () => {
  it('shows a mounted share with free space and copies', () => {
    expect(targetLine(base)).toBe('Eingebunden (cifs) · 412 GB frei · 5 Kopien');
    expect(targetStatus(base)).toBe('ok');
    expect(runLine(base.lastRun)).toBe(`Zuletzt ${WHEN}: 3 neue Kopien, 2,1 GB`);
  });

  it('warns with shape and text when the share is not mounted', () => {
    const s = { ...base, status: { ...STATUS, state: 'not_mounted' as const } };
    expect(targetLine(s)).toBe('Freigabe nicht eingebunden');
    expect(targetStatus(s)).toBe('warn');
    expect(runLine({ ...RUN, ok: false, error: 'not_mounted' })).toBe(
      `Zuletzt ${WHEN}: Freigabe nicht eingebunden`,
    );
  });

  it('offline and never run', () => {
    expect(targetStatus({ ...base, online: false })).toBe('off');
    expect(runLine(null)).toBe('Noch kein Lauf');
    expect(runLine({ ...RUN, copied: 0 })).toBe(`Zuletzt ${WHEN}: alles schon kopiert`);
  });
});

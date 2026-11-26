import { describe, expect, it } from 'vitest';
import type { PhysicalDisk, RaidArray } from '@hz/shared';
import { arrayView, diskView, raidLevelLabel } from './storage.js';

const arr = (over: Partial<RaidArray> = {}): RaidArray => ({
  name: 'md1',
  level: 'raid1',
  state: 'clean',
  devicesTotal: 2,
  devicesActive: 2,
  members: [],
  ...over,
});

const disk = (over: Partial<PhysicalDisk> = {}): PhysicalDisk => ({
  name: 'sda',
  kind: 'hdd',
  model: 'WDC WD40EFPX',
  sizeBytes: 4 * 1024 ** 4,
  tempC: 38.5,
  standby: false,
  smart: { health: 'passed', powerOnHours: 12345, readAt: '2026-11-26T10:00:00.000Z' },
  ...over,
});

describe('storage view', () => {
  it('labels RAID levels', () => {
    expect(raidLevelLabel('raid1')).toBe('RAID 1');
    expect(raidLevelLabel('raid10')).toBe('RAID 10');
    expect(raidLevelLabel('linear')).toBe('Linear');
  });

  it('arrays: text and status, Austrian numbers', () => {
    expect(arrayView(arr({ sizeBytes: 3.5 * 1024 ** 4 }))).toEqual({
      status: 'ok',
      label: 'In Ordnung',
      detail: 'RAID 1 · 2/2 Platten · 3,5 TB',
    });
    const r = arrayView(
      arr({
        state: 'degraded',
        devicesActive: 1,
        sync: { kind: 'recovery', percent: 12.6, finishMin: 210.3 },
      }),
    );
    expect(r.status).toBe('crit');
    expect(r.detail).toBe('RAID 1 · 1/2 Platten · Baut neu auf 12,6 %, noch 3 h 30 Min');
    expect(arrayView(arr({ state: 'syncing' })).status).toBe('busy');
  });

  it('disks: SMART, sectors, standby, no SMART', () => {
    expect(diskView(disk())).toMatchObject({
      status: 'ok',
      title: 'sda · WDC WD40EFPX',
      sub: '4 TB HDD · 12.345 Stunden',
      meta: '38,5 °C',
    });
    const s = disk().smart;
    if (!s) throw new Error('fixture');
    expect(diskView(disk({ smart: { ...s, health: 'failed' } })).status).toBe('crit');
    expect(diskView(disk({ smart: { ...s, reallocated: 3, pending: 1 } }))).toMatchObject({
      status: 'warn',
      label: '4 defekte Sektoren',
    });
    expect(diskView(disk({ standby: true, tempC: null }))).toMatchObject({
      status: 'off',
      meta: 'schläft',
    });
    expect(diskView(disk({ smart: null })).status).toBe('info');
  });
});

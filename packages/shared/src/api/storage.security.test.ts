import { describe, expect, it } from 'vitest';
import { inventorySchema, storageInfoSchema, type StorageInfo } from '../agent-protocol.js';
import { parseStorageAlertKey, storageAlertKey, storageProblems } from './storage.js';

const SID = 'srv_abcdefgh';

const base = (): StorageInfo => ({
  platform: { kind: 'ugreen' },
  smart: 'on',
  arrays: [
    {
      name: 'md1',
      level: 'raid1',
      state: 'clean',
      devicesTotal: 2,
      devicesActive: 2,
      members: [{ device: 'sda3', disk: 'sda', failed: false, spare: false }],
    },
  ],
  volumes: [],
  disks: [
    {
      name: 'sda',
      kind: 'hdd',
      sizeBytes: 1,
      tempC: 30,
      standby: false,
      smart: { health: 'passed', readAt: '2026-11-26T10:00:00.000Z' },
    },
    {
      name: 'nvme0n1',
      kind: 'nvme',
      sizeBytes: 1,
      tempC: 65,
      standby: false,
      smart: { health: 'passed', wearPct: 10, readAt: '2026-11-26T10:00:00.000Z' },
    },
  ],
});

describe('storage schema (security)', () => {
  it('is strict and bounded', () => {
    expect(storageInfoSchema.safeParse(base()).success).toBe(true);
    expect(storageInfoSchema.safeParse({ ...base(), extra: 1 }).success).toBe(false);
    const evil = base();
    const d = evil.disks[0];
    if (!d) throw new Error('fixture');
    for (const name of ['../sda', 'sda;id', 'loop0', 'SDA', 'sda\n']) {
      expect(storageInfoSchema.safeParse({ ...evil, disks: [{ ...d, name }] }).success, name).toBe(
        false,
      );
    }
    expect(
      storageInfoSchema.safeParse({ ...evil, disks: Array.from({ length: 65 }, () => d) }).success,
    ).toBe(false);
    expect(
      storageInfoSchema.safeParse({
        ...evil,
        arrays: [{ ...evil.arrays[0], name: 'md0; rm' }],
      }).success,
    ).toBe(false);
  });

  it('inventory accepts storage as optional field only', () => {
    const inv = {
      type: 'inventory',
      ts: '2026-11-26T10:00:00.000Z',
      system: { hostname: 'nas', os: 'UGOS Pro', kernel: '6.1', arch: 'amd64' },
      containers: [],
      updates: null,
      rebootRequired: false,
      sshFailed24h: null,
      fail2banBanned: null,
      listeningPorts: [],
    };
    expect(inventorySchema.safeParse(inv).success).toBe(true);
    expect(inventorySchema.safeParse({ ...inv, storage: base() }).success).toBe(true);
    expect(inventorySchema.safeParse({ ...inv, storage: { nope: true } }).success).toBe(false);
  });
});

describe('storageProblems', () => {
  it('healthy: nothing', () => {
    expect(storageProblems(SID, 'nas', base())).toEqual([]);
  });

  it('degraded and inactive arrays are crit, syncing is not a problem', () => {
    const s = base();
    const a = s.arrays[0];
    if (!a) throw new Error('fixture');
    s.arrays = [
      { ...a, state: 'degraded', devicesActive: 1 },
      { ...a, name: 'md2', state: 'inactive' },
      { ...a, name: 'md3', state: 'syncing', sync: { kind: 'resync', percent: 3 } },
    ];
    const p = storageProblems(SID, 'nas', s);
    expect(p.map((x) => [x.key, x.level])).toEqual([
      [storageAlertKey(SID, 'raid', 'md1'), 'crit'],
      [storageAlertKey(SID, 'raid', 'md2'), 'crit'],
    ]);
    expect(p[0]?.body).toContain('1 von 2 Platten fehlt');
  });

  it('temperature limits differ for HDD and NVMe; standby (null) is never hot', () => {
    const s = base();
    const [h, n] = s.disks;
    if (!h || !n) throw new Error('fixture');
    s.disks = [
      { ...h, tempC: 50 },
      { ...n, tempC: 69 },
    ];
    expect(storageProblems(SID, 'nas', s).map((x) => [x.key, x.level])).toEqual([
      [storageAlertKey(SID, 'temp', 'sda'), 'warn'],
    ]);
    s.disks = [
      { ...h, tempC: null, standby: true },
      { ...n, tempC: 80 },
    ];
    expect(storageProblems(SID, 'nas', s).map((x) => [x.key, x.level])).toEqual([
      [storageAlertKey(SID, 'temp', 'nvme0n1'), 'crit'],
    ]);
  });

  it('worn NVMe and media errors warn; worst first', () => {
    const s = base();
    const [h, n] = s.disks;
    if (!h?.smart || !n?.smart) throw new Error('fixture');
    s.disks = [
      { ...h, smart: { ...h.smart, health: 'failed' } },
      { ...n, smart: { ...n.smart, wearPct: 95 } },
    ];
    const p = storageProblems(SID, 'nas', s);
    expect(p.map((x) => x.level)).toEqual(['crit', 'warn']);
    expect(p[1]?.title).toContain('95 % abgenutzt');
  });

  it('alert keys round-trip and reject other keys', () => {
    expect(parseStorageAlertKey(storageAlertKey(SID, 'sectors', 'sdb'))).toEqual({
      serverId: SID,
      kind: 'sectors',
      device: 'sdb',
    });
    expect(parseStorageAlertKey(`port:${SID}:tcp:22`)).toBeNull();
    expect(parseStorageAlertKey(`storage:${SID}:shell:sda`)).toBeNull();
  });
});

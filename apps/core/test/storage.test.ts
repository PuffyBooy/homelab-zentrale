import { afterEach, describe, expect, it } from 'vitest';
import {
  storageAlertKey,
  storageListResponseSchema,
  storageServerSchema,
  type StorageInfo,
} from '@hz/shared';
import { enrollAgent, inventoryMsg, listen, until, type WsClient } from './agent-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
let agent: WsClient | undefined;
afterEach(async () => {
  agent?.close();
  agent = undefined;
  await t?.app.close();
  t = undefined;
});

async function setup(): Promise<{ cookie: string; serverId: string }> {
  t = await makeApp();
  const { cookie } = await completeSetup(t);
  const url = await listen(t);
  const e = await enrollAgent(t, url, cookie);
  agent = e.agent;
  return { cookie, serverId: e.serverId };
}

/** A two-disk UGREEN NAS with RAID 1 on md1 below /volume1. */
export function nasStorage(over: Partial<StorageInfo> = {}): StorageInfo {
  return {
    platform: { kind: 'ugreen', vendor: 'UGREEN', model: 'DXP2800' },
    smart: 'on',
    arrays: [
      {
        name: 'md1',
        level: 'raid1',
        state: 'clean',
        devicesTotal: 2,
        devicesActive: 2,
        members: [
          { device: 'sda3', disk: 'sda', failed: false, spare: false },
          { device: 'sdb3', disk: 'sdb', failed: false, spare: false },
        ],
        sizeBytes: 3_900_000_000_000,
      },
    ],
    volumes: [
      {
        mount: '/volume1',
        fs: 'btrfs',
        usedBytes: 1_200_000_000_000,
        totalBytes: 3_900_000_000_000,
        arrays: ['md1'],
        disks: ['sda', 'sdb'],
      },
    ],
    disks: ['sda', 'sdb'].map((name) => ({
      name,
      kind: 'hdd' as const,
      model: 'WDC WD40EFPX',
      sizeBytes: 4_000_787_030_016,
      tempC: 38,
      standby: false,
      smart: {
        health: 'passed' as const,
        powerOnHours: 1200,
        reallocated: 0,
        pending: 0,
        uncorrectable: 0,
        readAt: '2026-11-25T12:00:00.000Z',
      },
    })),
    ...over,
  };
}

let n = 0;
async function sendStorage(serverId: string, storage: StorageInfo | undefined): Promise<void> {
  if (!t || !agent) throw new Error('no app');
  const db = t.db;
  const marker = `host-${++n}`;
  const inv = inventoryMsg(storage ? { storage } : {});
  agent.send({ ...inv, system: { ...inv.system, hostname: marker } });
  await until(() => {
    const row = db.sqlite
      .prepare('SELECT system_json s FROM server_state WHERE server_id = ?')
      .get(serverId) as { s: string } | undefined;
    return row?.s.includes(marker) === true;
  });
}

function storageAlerts(serverId: string) {
  if (!t) throw new Error('no app');
  return t.app.hzCore.alerts
    .list({ state: 'all', limit: 500 })
    .filter((a) => a.key.startsWith(`storage:${serverId}:`));
}

async function get(cookie: string, url: string) {
  if (!t) throw new Error('no app');
  return t.app.inject({ method: 'GET', url, headers: authHeaders(cookie) });
}

describe('storage (M13)', () => {
  it('stores the snapshot and lists it; healthy NAS raises nothing', async () => {
    const { cookie, serverId } = await setup();
    expect((await get(cookie, `/api/storage/${serverId}`)).statusCode).toBe(404);
    await sendStorage(serverId, nasStorage());
    const one = storageServerSchema.parse((await get(cookie, `/api/storage/${serverId}`)).json());
    expect(one.storage.platform.kind).toBe('ugreen');
    expect(one.storage.arrays[0]?.state).toBe('clean');
    expect(one.problems).toEqual([]);
    const list = storageListResponseSchema.parse((await get(cookie, '/api/storage')).json());
    expect(list.servers.map((s) => s.serverId)).toEqual([serverId]);
    expect(storageAlerts(serverId)).toEqual([]);
  });

  it('a degraded RAID is a crit alert; rebuilt, it resolves with an OK entry', async () => {
    const { serverId } = await setup();
    const base = nasStorage();
    const arr = base.arrays[0];
    if (!arr) throw new Error('fixture');
    await sendStorage(
      serverId,
      nasStorage({
        arrays: [
          {
            ...arr,
            state: 'degraded',
            devicesActive: 1,
            members: [
              { device: 'sda3', disk: 'sda', failed: false, spare: false },
              { device: 'sdb3', disk: 'sdb', failed: true, spare: false },
            ],
          },
        ],
      }),
    );
    const key = storageAlertKey(serverId, 'raid', 'md1');
    const open = storageAlerts(serverId).filter((a) => a.state !== 'resolved');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ key, level: 'crit', source: 'server', serverId });
    expect(open[0]?.title).toContain('RAID md1');
    expect(open[0]?.body).toContain('sdb ausgefallen');

    // Same state again: no second alert.
    await sendStorage(
      serverId,
      nasStorage({ arrays: [{ ...arr, state: 'degraded', devicesActive: 1 }] }),
    );
    expect(storageAlerts(serverId).filter((a) => a.state !== 'resolved')).toHaveLength(1);

    await sendStorage(serverId, nasStorage());
    const all = storageAlerts(serverId);
    expect(all.filter((a) => a.state !== 'resolved')).toEqual([]);
    expect(all.some((a) => a.level === 'ok' && a.title.includes('wieder in Ordnung'))).toBe(true);
  });

  it('SMART failure, bad sectors and heat raise alerts per disk', async () => {
    const { serverId } = await setup();
    const s = nasStorage();
    const [a, b] = s.disks;
    if (!a?.smart || !b?.smart) throw new Error('fixture');
    await sendStorage(
      serverId,
      nasStorage({
        disks: [
          { ...a, tempC: 61, smart: { ...a.smart, health: 'failed' } },
          { ...b, smart: { ...b.smart, reallocated: 8, pending: 2 } },
        ],
      }),
    );
    const open = storageAlerts(serverId)
      .filter((x) => x.state !== 'resolved')
      .map((x) => [x.key, x.level]);
    expect(open).toEqual(
      expect.arrayContaining([
        [storageAlertKey(serverId, 'smart', 'sda'), 'crit'],
        [storageAlertKey(serverId, 'temp', 'sda'), 'crit'],
        [storageAlertKey(serverId, 'sectors', 'sdb'), 'warn'],
      ]),
    );
    expect(open).toHaveLength(3);
  });

  it('an inventory without storage (older agent) keeps the last snapshot', async () => {
    const { cookie, serverId } = await setup();
    await sendStorage(serverId, nasStorage());
    await sendStorage(serverId, undefined);
    expect((await get(cookie, `/api/storage/${serverId}`)).statusCode).toBe(200);
  });

  it('module off: 404 module_disabled and open storage alerts are resolved', async () => {
    const { cookie, serverId } = await setup();
    const s = nasStorage();
    const [a, b] = s.disks;
    if (!a || !b) throw new Error('fixture');
    await sendStorage(serverId, nasStorage({ disks: [{ ...a, tempC: 70 }, b] }));
    expect(storageAlerts(serverId).filter((x) => x.state !== 'resolved')).toHaveLength(1);
    if (!t) throw new Error('no app');
    t.app.hzCore.modules.set({ storage: false });
    expect(storageAlerts(serverId).filter((x) => x.state !== 'resolved')).toEqual([]);
    const res = await get(cookie, `/api/storage/${serverId}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'module_disabled' });
    // While off, new problems raise nothing.
    await sendStorage(serverId, nasStorage({ disks: [{ ...a, tempC: 70 }, b] }));
    expect(storageAlerts(serverId).filter((x) => x.state !== 'resolved')).toEqual([]);
    // Back on: the stored snapshot is evaluated again.
    t.app.hzCore.modules.set({ storage: true });
    expect(storageAlerts(serverId).filter((x) => x.state !== 'resolved')).toHaveLength(1);
  });
});

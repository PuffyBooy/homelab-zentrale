import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { storageInfoSchema } from '@hz/shared';
import {
  SMART_CACHE_MS,
  SmartReader,
  collectStorage,
  diskOfDevice,
  parseMdstat,
  parseProcMounts,
  parseSmartctlJson,
  pickVolumeMounts,
} from '../src/collect/storage.js';
import type { RunResult } from '../src/exec.js';

const MDSTAT_UGOS = `Personalities : [raid1] [linear] [multipath] [raid0] [raid6] [raid5] [raid4] [raid10]
md1 : active raid1 sdb3[1](F) sda3[0]
      3902163968 blocks super 1.2 [2/1] [U_]
      bitmap: 2/30 pages [8KB], 65536KB chunk

md0 : active raid1 sdb2[1] sda2[0]
      8382464 blocks super 1.2 [2/2] [UU]

md2 : active raid5 sdc1[0] sdd1[1] sde1[3]
      7813771264 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/2] [UU_]
      [==>..................]  recovery = 12.6% (493201408/3906885632) finish=210.3min speed=270400K/sec

md3 : active raid1 nvme0n1p1[0] nvme1n1p1[1]
      976630464 blocks super 1.2 [2/2] [UU]
      [=========>...........]  check = 45.2% (441600000/976630464) finish=40.0min speed=222000K/sec

md127 : inactive sdf1[0](S)
      3906885632 blocks super 1.2

md4 : active raid0 sdg1[0] sdh1[1]
      1953260544 blocks super 1.2 512k chunks

unused devices: <none>
`;

describe('mdstat', () => {
  it('parses levels, members, degraded, recovery, check, inactive and raid0', () => {
    const a = parseMdstat(MDSTAT_UGOS);
    const by = Object.fromEntries(a.map((x) => [x.name, x]));
    expect(by.md1).toMatchObject({
      level: 'raid1',
      state: 'degraded',
      devicesTotal: 2,
      devicesActive: 1,
      sizeBytes: 3902163968 * 1024,
    });
    expect(by.md1?.members).toEqual([
      { device: 'sdb3', disk: 'sdb', failed: true, spare: false },
      { device: 'sda3', disk: 'sda', failed: false, spare: false },
    ]);
    expect(by.md0?.state).toBe('clean');
    expect(by.md2).toMatchObject({
      level: 'raid5',
      state: 'degraded',
      devicesTotal: 3,
      devicesActive: 2,
    });
    expect(by.md2?.sync).toEqual({ kind: 'recovery', percent: 12.6, finishMin: 210.3 });
    // A scrub (check) is not "syncing".
    expect(by.md3).toMatchObject({ state: 'clean', sync: { kind: 'check', percent: 45.2 } });
    expect(by.md3?.members.map((m) => m.disk)).toEqual(['nvme0n1', 'nvme1n1']);
    expect(by.md127).toMatchObject({ state: 'inactive', level: 'unknown' });
    expect(by.md127?.members[0]).toMatchObject({ device: 'sdf1', spare: true });
    expect(by.md4).toMatchObject({
      level: 'raid0',
      state: 'clean',
      devicesTotal: 2,
      devicesActive: 2,
    });
  });

  it('a resync on a healthy array is "syncing"', () => {
    const a = parseMdstat(
      'md0 : active raid1 sdb1[1] sda1[0]\n      100 blocks [2/2] [UU]\n      [>....]  resync =  1.0% (1/100) finish=99.0min speed=1K/sec\n',
    );
    expect(a[0]).toMatchObject({ state: 'syncing', sync: { kind: 'resync', percent: 1 } });
  });

  it('maps member devices to disks', () => {
    expect(diskOfDevice('sda3')).toBe('sda');
    expect(diskOfDevice('sdab')).toBe('sdab');
    expect(diskOfDevice('nvme0n1p2')).toBe('nvme0n1');
    expect(diskOfDevice('dm-0')).toBeNull();
    expect(diskOfDevice('loop0')).toBeNull();
  });
});

describe('mounts', () => {
  it('keeps one data mount per device, skips docker, boot and pseudo file systems', () => {
    const text = [
      '/dev/md0 / ext4 rw 0 0',
      '/dev/mapper/ug_vg1-volume1 /volume1 btrfs rw 0 0',
      '/dev/mapper/ug_vg1-volume1 /volume1/@docker btrfs rw 0 0',
      '/dev/mapper/ug_vg1-volume1 /var/lib/docker btrfs rw 0 0',
      '/dev/sda1 /boot/efi vfat rw 0 0',
      'overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0',
      'tmpfs /run tmpfs rw 0 0',
      '/dev/md5 /volume\\0402 ext4 rw 0 0',
    ].join('\n');
    expect(pickVolumeMounts(parseProcMounts(text))).toEqual([
      { source: '/dev/md0', mount: '/', fs: 'ext4' },
      { source: '/dev/md5', mount: '/volume 2', fs: 'ext4' },
      { source: '/dev/mapper/ug_vg1-volume1', mount: '/volume1', fs: 'btrfs' },
    ]);
  });
});

const ATA_OK = JSON.stringify({
  smartctl: { exit_status: 0 },
  model_name: 'WDC WD40EFPX-68C6CN0',
  serial_number: 'WD-ABC123',
  smart_status: { passed: true },
  temperature: { current: 37 },
  power_on_time: { hours: 1234 },
  ata_smart_attributes: {
    table: [
      { id: 5, name: 'Reallocated_Sector_Ct', raw: { value: 8 } },
      { id: 197, name: 'Current_Pending_Sector', raw: { value: 1 } },
      { id: 198, name: 'Offline_Uncorrectable', raw: { value: 0 } },
      { id: 194, name: 'Temperature_Celsius', raw: { value: 37 } },
    ],
  },
});

describe('smartctl json', () => {
  it('ATA: health, attributes, temperature', () => {
    expect(parseSmartctlJson(ATA_OK)).toEqual({
      openFailed: false,
      standby: false,
      model: 'WDC WD40EFPX-68C6CN0',
      serial: 'WD-ABC123',
      tempC: 37,
      smart: { health: 'passed', powerOnHours: 1234, reallocated: 8, pending: 1, uncorrectable: 0 },
    });
  });

  it('failed health, NVMe log', () => {
    const r = parseSmartctlJson(
      JSON.stringify({
        smartctl: { exit_status: 8 },
        model_name: 'Samsung SSD 990 PRO',
        smart_status: { passed: false },
        temperature: { current: 48 },
        nvme_smart_health_information_log: { media_errors: 3, percentage_used: 92 },
      }),
    );
    expect(r.smart).toEqual({ health: 'failed', mediaErrors: 3, wearPct: 92 });
    expect(r.tempC).toBe(48);
  });

  it('standby: no values, not an open failure', () => {
    const r = parseSmartctlJson(
      JSON.stringify({
        smartctl: { exit_status: 0, messages: [{ string: 'Device is in STANDBY mode, exit(0)' }] },
      }),
    );
    expect(r).toMatchObject({ standby: true, openFailed: false, smart: null, tempC: null });
  });

  it('open failure and garbage', () => {
    const r = parseSmartctlJson(
      JSON.stringify({
        smartctl: { exit_status: 2, messages: [{ string: 'Permission denied' }] },
      }),
    );
    expect(r).toMatchObject({ openFailed: true, smart: null });
    expect(parseSmartctlJson('not json').openFailed).toBe(true);
  });
});

describe('SmartReader', () => {
  it('caches per disk and keeps the last awake values while the disk sleeps', async () => {
    let t = 1_000_000;
    const calls: string[][] = [];
    let answer = ATA_OK;
    const run = async (args: string[]): Promise<RunResult> => {
      calls.push(args);
      return { code: 0, stdout: answer, stderr: '' };
    };
    const r = new SmartReader('/host/proc/1/root', run, () => t);
    const a = await r.read('sda');
    expect(a.read.smart?.health).toBe('passed');
    expect(calls[0]).toEqual([
      '--json=c',
      '--info',
      '--health',
      '--attributes',
      '--nocheck=standby,0',
      '--device',
      'sat',
      '/host/proc/1/root/dev/sda',
    ]);
    await r.read('sda');
    expect(calls).toHaveLength(1);
    t += SMART_CACHE_MS;
    answer = JSON.stringify({
      smartctl: { exit_status: 0, messages: [{ string: 'Device is in STANDBY mode' }] },
    });
    const b = await r.read('sda');
    expect(calls).toHaveLength(2);
    expect(b.read.standby).toBe(true);
    expect(b.awake?.read.smart?.reallocated).toBe(8);
  });

  it('NVMe disks use -d nvme', async () => {
    const calls: string[][] = [];
    const r = new SmartReader('/r', async (args) => {
      calls.push(args);
      return { code: 0, stdout: '{}', stderr: '' };
    });
    await r.read('nvme0n1');
    expect(calls[0]?.slice(-2)).toEqual(['nvme', '/r/dev/nvme0n1']);
  });
});

// ---------------------------------------------------------------------------
// Full collector against a fake host tree.

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

async function put(root: string, p: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, p)), { recursive: true });
  await writeFile(path.join(root, p), content);
}

async function fakeHost(): Promise<{ hostRoot: string; hostProc: string }> {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'hz-storage-'));
  const hostRoot = path.join(tmp, 'root');
  const hostProc = path.join(tmp, 'proc');
  await put(hostProc, 'mdstat', MDSTAT_UGOS.split('\n\n').slice(0, 2).join('\n\n'));
  await put(
    hostProc,
    '1/mounts',
    '/dev/md0 / ext4 rw 0 0\n/dev/mapper/vg1-volume1 /volume1 btrfs rw 0 0\n',
  );
  await mkdir(path.join(hostRoot, 'volume1'), { recursive: true });
  // /dev/mapper/vg1-volume1 -> ../dm-0 ; dm-0 -> md1 -> sda3, sdb3
  await mkdir(path.join(hostRoot, 'dev/mapper'), { recursive: true });
  await writeFile(path.join(hostRoot, 'dev/dm-0'), '');
  await writeFile(path.join(hostRoot, 'dev/md0'), '');
  await symlink('../dm-0', path.join(hostRoot, 'dev/mapper/vg1-volume1'));
  await mkdir(path.join(hostRoot, 'sys/class/block/dm-0/slaves/md1'), { recursive: true });
  await mkdir(path.join(hostRoot, 'sys/class/block/md1/slaves/sda3'), { recursive: true });
  await mkdir(path.join(hostRoot, 'sys/class/block/md1/slaves/sdb3'), { recursive: true });
  await mkdir(path.join(hostRoot, 'sys/class/block/md0/slaves/sda2'), { recursive: true });
  for (const d of ['sda', 'sdb']) {
    await put(hostRoot, `sys/block/${d}/size`, '7814037168\n');
    await put(hostRoot, `sys/block/${d}/removable`, '0\n');
    await put(hostRoot, `sys/block/${d}/queue/rotational`, '1\n');
    await put(hostRoot, `sys/block/${d}/device/model`, 'WDC WD40EFPX-68C\n');
  }
  await put(hostRoot, 'sys/block/nvme0n1/size', '1953525168\n');
  await put(hostRoot, 'sys/block/nvme0n1/removable', '0\n');
  await put(hostRoot, 'sys/block/nvme0n1/queue/rotational', '0\n');
  await put(hostRoot, 'sys/block/nvme0n1/device/model', 'Samsung SSD 990 PRO 1TB   \n');
  await put(hostRoot, 'sys/block/nvme0n1/device/serial', 'S7XYZ\n');
  await put(hostRoot, 'sys/block/nvme0n1/device/hwmon2/temp1_input', '41850\n');
  // USB stick: removable, skipped. Loop/zram: not a disk name.
  await put(hostRoot, 'sys/block/sdc/size', '1000\n');
  await put(hostRoot, 'sys/block/sdc/removable', '1\n');
  await mkdir(path.join(hostRoot, 'sys/block/loop0'), { recursive: true });
  await mkdir(path.join(hostRoot, 'sys/block/zram0'), { recursive: true });
  await put(hostRoot, 'sys/class/dmi/id/sys_vendor', 'UGREEN\n');
  await put(hostRoot, 'sys/class/dmi/id/product_name', 'DXP2800\n');
  return { hostRoot, hostProc };
}

describe('collectStorage', () => {
  it('builds a valid snapshot of a UGREEN NAS without SMART', async () => {
    const ctx = await fakeHost();
    const s = await collectStorage(ctx, { smart: false });
    expect(storageInfoSchema.safeParse(s).success).toBe(true);
    expect(s?.platform).toEqual({ kind: 'ugreen', vendor: 'UGREEN', model: 'DXP2800' });
    expect(s?.smart).toBe('off');
    expect(s?.arrays.map((a) => [a.name, a.state])).toEqual([
      ['md1', 'degraded'],
      ['md0', 'clean'],
    ]);
    expect(s?.disks.map((d) => [d.name, d.kind, d.tempC])).toEqual([
      ['nvme0n1', 'nvme', 41.9],
      ['sda', 'hdd', null],
      ['sdb', 'hdd', null],
    ]);
    expect(s?.disks[0]).toMatchObject({ model: 'Samsung SSD 990 PRO 1TB', serial: 'S7XYZ' });
    const vol = s?.volumes.find((v) => v.mount === '/volume1');
    expect(vol).toMatchObject({ fs: 'btrfs', arrays: ['md1'], disks: ['sda', 'sdb'] });
    expect(vol?.totalBytes).toBeGreaterThan(0);
  });

  it('SMART on: values per disk; no disk opens -> unavailable', async () => {
    const ctx = await fakeHost();
    const ok = new SmartReader(ctx.hostRoot, async () => ({ code: 0, stdout: ATA_OK, stderr: '' }));
    const s = await collectStorage(ctx, { smart: true, smartReader: ok });
    expect(s?.smart).toBe('on');
    expect(s?.disks.find((d) => d.name === 'sda')).toMatchObject({
      tempC: 37,
      serial: 'WD-ABC123',
      smart: { health: 'passed', reallocated: 8 },
    });
    expect(storageInfoSchema.safeParse(s).success).toBe(true);

    const denied = new SmartReader(ctx.hostRoot, async () => ({
      code: 2,
      stdout: JSON.stringify({ smartctl: { exit_status: 2 } }),
      stderr: '',
    }));
    const u = await collectStorage(ctx, { smart: true, smartReader: denied });
    expect(u?.smart).toBe('unavailable');
    expect(u?.disks.every((d) => d.smart === null)).toBe(true);
  });

  it('a host without disks and arrays sends no storage', async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'hz-storage-'));
    expect(
      await collectStorage({ hostRoot: tmp, hostProc: tmp }, { smart: false }),
    ).toBeUndefined();
  });
});

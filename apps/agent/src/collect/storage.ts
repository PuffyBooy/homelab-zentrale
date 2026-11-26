import { readdir, readFile, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import {
  blockDeviceNameSchema,
  mdNameSchema,
  type PhysicalDisk,
  type RaidArray,
  type StorageInfo,
  type StorageVolume,
} from '@hz/shared';
import { runFile, type RunResult } from '../exec.js';
import { hostPath, type HostContext } from '../host.js';

/**
 * Storage part of `inventory` (ROADMAP M13, SPEC 5.4). Generic Linux, written
 * with a UGREEN NASync (UGOS Pro, Debian based: md RAID, LVM, ext4/btrfs on
 * /volumeN) in mind. Read only. How the host is read:
 *
 * - md RAID: <hostProc>/mdstat.
 * - volumes: <hostProc>/1/mounts (the mount table of host init), statfs through
 *   the host root, the device chain (dm -> md -> partition -> disk) from
 *   /sys/class/block/<dev>/slaves.
 * - disks: /sys/block (sd*, nvme*n*; removable ones skipped), model and size
 *   from sysfs, NVMe temperature from its hwmon (no disk access).
 * - SMART (only with HZ_AGENT_SMART=1): `smartctl` from the agent image on
 *   <hostRoot>/dev/<disk> with `--nocheck=standby,0`, so a sleeping disk is
 *   never woken up. Needs CAP_SYS_RAWIO and read access to the block devices
 *   (deploy/docker-compose.agent.smart.yml). Results are cached for
 *   SMART_CACHE_MS per disk; a sleeping disk keeps its last values.
 *
 * SATA temperatures come only from SMART (the drivetemp hwmon can wake disks).
 * Every step fails soft.
 */

export const SMART_CACHE_MS = 10 * 60_000;
const SMART_TIMEOUT_MS = 20_000;
const MAX_DISKS = 64;
const MAX_ARRAYS = 32;
const MAX_VOLUMES = 32;

/** File systems of data volumes. Everything else (tmpfs, overlay, proc ...) is skipped. */
const VOLUME_FS = new Set(['ext4', 'ext3', 'btrfs', 'xfs', 'f2fs', 'zfs']);
/** Mount points below these are not volumes of their own (boot, docker layers, snaps). */
const SKIP_MOUNT_PREFIXES = ['/boot', '/var/lib/docker', '/snap', '/run', '/proc', '/sys', '/dev'];

const clip = (s: string, n: number): string => s.replace(/\s+/g, ' ').trim().slice(0, n);

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// mdstat

/** sda3 -> sda, nvme0n1p2 -> nvme0n1, sdb -> sdb; null for anything else. */
export function diskOfDevice(dev: string): string | null {
  const m = /^(sd[a-z]{1,3})\d*$/.exec(dev) ?? /^(nvme\d{1,3}n\d{1,3})(?:p\d+)?$/.exec(dev);
  return m?.[1] ?? null;
}

/**
 * Parses /proc/mdstat. Example:
 *   md1 : active raid1 sdb3[1](F) sda3[0]
 *         3902163968 blocks super 1.2 [2/1] [U_]
 *         [==>..........]  recovery = 12.6% (493...) finish=210.3min speed=120000K/sec
 */
export function parseMdstat(text: string): RaidArray[] {
  const out: RaidArray[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < MAX_ARRAYS; i++) {
    const head = /^(md\d{1,4})\s*:\s*(\S+)\s+(.*)$/.exec(lines[i] ?? '');
    if (!head?.[1] || !head[2] || !mdNameSchema.safeParse(head[1]).success) continue;
    const name = head[1];
    const active = head[2] === 'active';
    const tokens = (head[3] ?? '').split(/\s+/).filter(Boolean);
    // "active (auto-read-only) raid1 ...", "inactive sdb[0](S)"
    while (tokens[0]?.startsWith('(')) tokens.shift();
    let level = 'unknown';
    if (active && tokens[0] && !tokens[0].includes('[')) level = tokens.shift() ?? level;
    const members: RaidArray['members'] = [];
    for (const t of tokens) {
      const m = /^([a-z0-9]{1,32})\[\d+\]((?:\([A-Z]\))*)$/.exec(t);
      if (!m?.[1]) continue;
      const flags = m[2] ?? '';
      const disk = diskOfDevice(m[1]);
      members.push({
        device: m[1],
        ...(disk ? { disk } : {}),
        failed: flags.includes('(F)'),
        spare: flags.includes('(S)'),
      });
    }
    // Detail lines until the next blank line or array.
    let sizeBytes: number | undefined;
    let total = members.filter((m) => !m.spare && !m.failed).length;
    let up = total;
    let sync: RaidArray['sync'];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (l.trim() === '' || /^md\d/.test(l)) break;
      const blocks = /^\s*(\d+)\s+blocks/.exec(l);
      if (blocks?.[1]) sizeBytes = Number(blocks[1]) * 1024;
      const nm = /\[(\d+)\/(\d+)\]/.exec(l);
      if (nm?.[1] && nm[2]) {
        total = Number(nm[1]);
        up = Number(nm[2]);
      }
      const s = /(resync|recovery|check|reshape)\s*=\s*([\d.]+)%/.exec(l);
      if (s?.[1] && s[2]) {
        const fin = /finish=([\d.]+)min/.exec(l);
        sync = {
          kind: s[1] as NonNullable<RaidArray['sync']>['kind'],
          percent: Math.min(100, Math.max(0, Number(s[2]))),
          ...(fin?.[1] ? { finishMin: Number(fin[1]) } : {}),
        };
      }
    }
    const state: RaidArray['state'] = !active
      ? 'inactive'
      : up < total
        ? 'degraded'
        : sync && sync.kind !== 'check'
          ? 'syncing'
          : 'clean';
    out.push({
      name,
      level: /^[a-z0-9]{1,16}$/.test(level) ? level : 'unknown',
      state,
      devicesTotal: Math.min(256, total),
      devicesActive: Math.min(256, up),
      members: members.slice(0, 64),
      ...(sync ? { sync } : {}),
      ...(sizeBytes !== undefined && Number.isFinite(sizeBytes) ? { sizeBytes } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// mounts and device chain

export interface MountEntry {
  source: string;
  mount: string;
  fs: string;
}

/** /proc/<pid>/mounts: octal escapes (\040) in paths are decoded. */
export function parseProcMounts(text: string): MountEntry[] {
  const dec = (s: string) =>
    s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  const out: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const [source, mount, fs] = line.split(' ');
    if (!source || !mount || !fs) continue;
    out.push({ source: dec(source), mount: dec(mount), fs });
  }
  return out;
}

/** Data volumes: block-device mounts with a data fs, one per device (shortest mount path). */
export function pickVolumeMounts(entries: readonly MountEntry[]): MountEntry[] {
  const byDev = new Map<string, MountEntry>();
  for (const e of entries) {
    if (!e.source.startsWith('/dev/') || !VOLUME_FS.has(e.fs)) continue;
    if (SKIP_MOUNT_PREFIXES.some((p) => e.mount === p || e.mount.startsWith(`${p}/`))) continue;
    const prev = byDev.get(e.source);
    if (!prev || e.mount.length < prev.mount.length) byDev.set(e.source, e);
  }
  return [...byDev.values()].sort((a, b) => a.mount.localeCompare(b.mount));
}

/** Walks /sys/class/block/<dev>/slaves down to md arrays and physical disks. */
async function deviceChain(
  ctx: Pick<HostContext, 'hostRoot'>,
  dev: string,
): Promise<{ arrays: string[]; disks: string[] }> {
  const arrays = new Set<string>();
  const disks = new Set<string>();
  const seen = new Set<string>();
  const walk = async (name: string, depth: number): Promise<void> => {
    if (depth > 8 || seen.has(name) || !/^[a-z0-9-]{1,32}$/.test(name)) return;
    seen.add(name);
    if (mdNameSchema.safeParse(name).success) arrays.add(name);
    const disk = diskOfDevice(name);
    if (disk) {
      disks.add(disk);
      return;
    }
    const slaves = await readdir(hostPath(ctx, `/sys/class/block/${name}/slaves`)).catch(
      () => [] as string[],
    );
    for (const s of slaves) await walk(s, depth + 1);
  };
  await walk(dev, 0);
  return { arrays: [...arrays].sort(), disks: [...disks].sort() };
}

/** /dev/mapper/vg-volume1 or /dev/md0 -> kernel name (dm-0, md0) through the host root. */
async function kernelName(
  ctx: Pick<HostContext, 'hostRoot'>,
  source: string,
): Promise<string | null> {
  try {
    const real = await realpath(hostPath(ctx, source));
    const base = path.basename(real);
    return /^[a-z0-9-]{1,32}$/.test(base) ? base : null;
  } catch {
    // /dev/root and similar: fall back to the name itself.
    const base = path.basename(source);
    return /^[a-z0-9-]{1,32}$/.test(base) ? base : null;
  }
}

export async function collectVolumes(
  ctx: Pick<HostContext, 'hostRoot' | 'hostProc'>,
): Promise<StorageVolume[]> {
  const text = await readText(path.join(ctx.hostProc, '1', 'mounts'));
  if (text === null) return [];
  const out: StorageVolume[] = [];
  for (const m of pickVolumeMounts(parseProcMounts(text))) {
    if (out.length >= MAX_VOLUMES) break;
    try {
      const st = await statfs(hostPath(ctx, m.mount));
      const total = st.blocks * st.bsize;
      const used = (st.blocks - st.bfree) * st.bsize;
      const name = await kernelName(ctx, m.source);
      const chain = name ? await deviceChain(ctx, name) : { arrays: [], disks: [] };
      out.push({
        mount: m.mount.slice(0, 256),
        fs: m.fs,
        usedBytes: Math.max(0, used),
        totalBytes: Math.max(0, total),
        arrays: chain.arrays.slice(0, 32),
        disks: chain.disks.filter((d) => blockDeviceNameSchema.safeParse(d).success).slice(0, 64),
      });
    } catch {
      // not readable: skip
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// disks from sysfs

export interface SysDisk {
  name: string;
  kind: PhysicalDisk['kind'];
  model?: string;
  serial?: string;
  sizeBytes: number;
  /** NVMe hwmon temperature, °C. */
  hwmonTemp: number | null;
}

async function nvmeHwmonTemp(
  ctx: Pick<HostContext, 'hostRoot'>,
  name: string,
): Promise<number | null> {
  const dev = hostPath(ctx, `/sys/block/${name}/device`);
  const candidates: string[] = [];
  for (const e of await readdir(dev).catch(() => [] as string[])) {
    if (/^hwmon\d+$/.test(e)) candidates.push(path.join(dev, e));
    if (e === 'hwmon') {
      for (const h of await readdir(path.join(dev, 'hwmon')).catch(() => [] as string[])) {
        if (/^hwmon\d+$/.test(h)) candidates.push(path.join(dev, 'hwmon', h));
      }
    }
  }
  for (const c of candidates) {
    const t = await readText(path.join(c, 'temp1_input'));
    const v = t === null ? NaN : Number(t.trim()) / 1000;
    if (Number.isFinite(v) && v > -40 && v < 150) return Math.round(v * 10) / 10;
  }
  return null;
}

export async function listSysDisks(ctx: Pick<HostContext, 'hostRoot'>): Promise<SysDisk[]> {
  const names = (await readdir(hostPath(ctx, '/sys/block')).catch(() => [] as string[]))
    .filter((n) => blockDeviceNameSchema.safeParse(n).success)
    .sort()
    .slice(0, MAX_DISKS);
  const out: SysDisk[] = [];
  for (const name of names) {
    const base = `/sys/block/${name}`;
    if ((await readText(hostPath(ctx, `${base}/removable`)))?.trim() === '1') continue;
    const sectors = Number((await readText(hostPath(ctx, `${base}/size`)))?.trim() ?? NaN);
    if (!Number.isFinite(sectors) || sectors <= 0) continue;
    const nvme = name.startsWith('nvme');
    const rotational = (await readText(hostPath(ctx, `${base}/queue/rotational`)))?.trim() === '1';
    const model = (await readText(hostPath(ctx, `${base}/device/model`))) ?? '';
    const serial = nvme ? ((await readText(hostPath(ctx, `${base}/device/serial`))) ?? '') : '';
    out.push({
      name,
      kind: nvme ? 'nvme' : rotational ? 'hdd' : 'ssd',
      ...(clip(model, 80) ? { model: clip(model, 80) } : {}),
      ...(clip(serial, 64) ? { serial: clip(serial, 64) } : {}),
      sizeBytes: sectors * 512,
      hwmonTemp: nvme ? await nvmeHwmonTemp(ctx, name) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SMART

/** Fixed smartctl arguments; `name` is checked against blockDeviceNameSchema. */
export function smartctlArgs(hostRoot: string, name: string): string[] {
  if (!blockDeviceNameSchema.safeParse(name).success) throw new Error('invalid disk name');
  const type = name.startsWith('nvme') ? 'nvme' : 'sat';
  return [
    '--json=c',
    '--info',
    '--health',
    '--attributes',
    '--nocheck=standby,0',
    '--device',
    type,
    path.join(hostRoot, 'dev', name),
  ];
}

export interface SmartRead {
  /** Device could not be opened (no rights, no device). */
  openFailed: boolean;
  standby: boolean;
  model?: string;
  serial?: string;
  tempC: number | null;
  smart: Omit<NonNullable<PhysicalDisk['smart']>, 'readAt'> | null;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/** Parses `smartctl --json` output (ATA and NVMe). */
export function parseSmartctlJson(text: string): SmartRead {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { openFailed: true, standby: false, tempC: null, smart: null };
  }
  const sc = (j.smartctl ?? {}) as { exit_status?: unknown; messages?: unknown };
  const exit = typeof sc.exit_status === 'number' ? sc.exit_status : 0;
  const messages = Array.isArray(sc.messages)
    ? sc.messages.map((m) => String((m as { string?: unknown }).string ?? ''))
    : [];
  const status = j.smart_status as { passed?: unknown } | undefined;
  const standby = status === undefined && messages.some((m) => /STANDBY|SLEEP/i.test(m));
  // Bit 1: device open failed or the device did not return an identify.
  const openFailed = !standby && (exit & 2) !== 0 && status === undefined;
  const model = typeof j.model_name === 'string' ? clip(j.model_name, 80) : undefined;
  const serial = typeof j.serial_number === 'string' ? clip(j.serial_number, 64) : undefined;
  const temp = num((j.temperature as { current?: unknown } | undefined)?.current);
  if (standby || openFailed) {
    return {
      openFailed,
      standby,
      ...(model ? { model } : {}),
      ...(serial ? { serial } : {}),
      tempC: null,
      smart: null,
    };
  }
  const smart: NonNullable<SmartRead['smart']> = {
    health: status?.passed === true ? 'passed' : status?.passed === false ? 'failed' : 'unknown',
  };
  const hours = num((j.power_on_time as { hours?: unknown } | undefined)?.hours);
  if (hours !== undefined) smart.powerOnHours = hours;
  const table = (j.ata_smart_attributes as { table?: unknown } | undefined)?.table;
  if (Array.isArray(table)) {
    for (const row of table as { id?: unknown; raw?: { value?: unknown } }[]) {
      const v = num(row.raw?.value);
      if (v === undefined) continue;
      if (row.id === 5) smart.reallocated = v;
      if (row.id === 197) smart.pending = v;
      if (row.id === 198) smart.uncorrectable = v;
    }
  }
  const nv = j.nvme_smart_health_information_log as
    { media_errors?: unknown; percentage_used?: unknown; critical_warning?: unknown } | undefined;
  if (nv) {
    const me = num(nv.media_errors);
    if (me !== undefined) smart.mediaErrors = me;
    const pu = num(nv.percentage_used);
    if (pu !== undefined) smart.wearPct = Math.min(255, pu);
  }
  return {
    openFailed: false,
    standby: false,
    ...(model ? { model } : {}),
    ...(serial ? { serial } : {}),
    tempC: temp !== undefined && temp < 150 ? temp : null,
    smart,
  };
}

export type SmartRunner = (args: string[]) => Promise<RunResult>;

const defaultRunner: SmartRunner = (args) =>
  runFile('smartctl', args, { timeoutMs: SMART_TIMEOUT_MS, maxBuffer: 1024 * 1024 });

interface CacheEntry {
  at: number;
  read: SmartRead;
  /** Last read while awake (kept while the disk sleeps). */
  awake: { at: number; read: SmartRead } | null;
}

/** Reads SMART per disk with a cache, so the disks are queried at most every 10 min. */
export class SmartReader {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly hostRoot: string,
    private readonly run: SmartRunner = defaultRunner,
    private readonly now: () => number = Date.now,
  ) {}

  async read(name: string): Promise<CacheEntry> {
    const t = this.now();
    const hit = this.cache.get(name);
    if (hit && t - hit.at < SMART_CACHE_MS) return hit;
    const r = await this.run(smartctlArgs(this.hostRoot, name));
    const read =
      r.error === 'not_found' || r.error === 'timeout' || r.error === 'spawn_failed'
        ? { openFailed: true, standby: false, tempC: null, smart: null }
        : parseSmartctlJson(r.stdout);
    const awake = read.smart ? { at: t, read } : (hit?.awake ?? null);
    const entry = { at: t, read, awake };
    this.cache.set(name, entry);
    return entry;
  }
}

// ---------------------------------------------------------------------------
// platform

export async function detectPlatform(
  ctx: Pick<HostContext, 'hostRoot'>,
): Promise<StorageInfo['platform']> {
  const vendor = clip((await readText(hostPath(ctx, '/sys/class/dmi/id/sys_vendor'))) ?? '', 64);
  const product = clip((await readText(hostPath(ctx, '/sys/class/dmi/id/product_name'))) ?? '', 80);
  const osRelease = (await readText(hostPath(ctx, '/etc/os-release'))) ?? '';
  const ugreen = /ugreen/i.test(vendor) || /ugreen|dxp\d/i.test(product) || /ugos/i.test(osRelease);
  return {
    kind: ugreen ? 'ugreen' : 'generic',
    ...(vendor ? { vendor } : {}),
    ...(product ? { model: product } : {}),
  };
}

// ---------------------------------------------------------------------------

export interface StorageOptions {
  smart: boolean;
  smartReader?: SmartReader;
}

/** Builds inventory.storage. Returns undefined when the host has neither disks nor arrays. */
export async function collectStorage(
  ctx: Pick<HostContext, 'hostRoot' | 'hostProc'>,
  opts: StorageOptions,
): Promise<StorageInfo | undefined> {
  const [mdstat, volumes, sysDisks, platform] = await Promise.all([
    readText(path.join(ctx.hostProc, 'mdstat')),
    collectVolumes(ctx).catch(() => [] as StorageVolume[]),
    listSysDisks(ctx).catch(() => [] as SysDisk[]),
    detectPlatform(ctx),
  ]);
  const arrays = mdstat ? parseMdstat(mdstat) : [];
  if (sysDisks.length === 0 && arrays.length === 0) return undefined;

  let smartState: StorageInfo['smart'] = opts.smart ? 'on' : 'off';
  let opened = 0;
  const disks: PhysicalDisk[] = [];
  for (const d of sysDisks) {
    let tempC = d.hwmonTemp;
    let standby = false;
    let smart: PhysicalDisk['smart'] = null;
    let model = d.model;
    let serial = d.serial;
    if (opts.smart && opts.smartReader) {
      const e = await opts.smartReader.read(d.name);
      if (!e.read.openFailed) opened += 1;
      standby = e.read.standby;
      model = e.read.model ?? e.awake?.read.model ?? model;
      serial = e.read.serial ?? e.awake?.read.serial ?? serial;
      if (e.read.tempC !== null) tempC = e.read.tempC;
      if (standby) tempC = null;
      const src = e.awake;
      if (src?.read.smart) smart = { ...src.read.smart, readAt: new Date(src.at).toISOString() };
    }
    disks.push({
      name: d.name,
      kind: d.kind,
      ...(model ? { model } : {}),
      ...(serial ? { serial } : {}),
      sizeBytes: d.sizeBytes,
      tempC,
      standby,
      smart,
    });
  }
  if (opts.smart && sysDisks.length > 0 && opened === 0) smartState = 'unavailable';
  return { platform, smart: smartState, arrays, volumes, disks };
}

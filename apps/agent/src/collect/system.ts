import { readdir, readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import si from 'systeminformation';
import type { Disk, Metrics, SystemInfo } from '@hz/shared';
import { hostPath, normalizeArch, type HostContext } from '../host.js';

/**
 * Metrics (docs/ARCHITECTURE.md: `metrics` every N s).
 *
 * Container accuracy (agent runs with pid: host, network_mode: host):
 * - CPU, RAM, swap, uptime: systeminformation reads /proc/stat, /proc/meminfo
 *   and /proc/uptime. These are not namespaced by Docker, so they show the host.
 * - Temperature: systeminformation reads /sys (host sysfs, read-only in Docker).
 *   Fallback: thermal zones below /sys/class/thermal.
 * - Disks: systeminformation's fsSize would only see the container's mounts.
 *   We parse the mount table of host PID 1 (/host/proc/1/mounts) and statfs each
 *   mount point through /host/proc/1/root. If that is not readable (missing
 *   CAP_SYS_PTRACE / AppArmor), we fall back to the container's own mounts,
 *   which is inaccurate (only the root fs and bind mounts).
 * - Network: /proc/net/dev of the host network namespace, physical interfaces
 *   only (no lo, veth, docker, bridges, tailscale).
 */

const SKIP_FS = new Set([
  'tmpfs',
  'devtmpfs',
  'overlay',
  'squashfs',
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'devpts',
  'mqueue',
  'debugfs',
  'tracefs',
  'securityfs',
  'pstore',
  'bpf',
  'autofs',
  'configfs',
  'fusectl',
  'hugetlbfs',
  'rpc_pipefs',
  'nsfs',
  'binfmt_misc',
  'efivarfs',
  'ramfs',
  'fuse.lxcfs',
  'fuse.snapfuse',
  'nfsd',
  'iso9660',
]);

export interface MountEntry {
  source: string;
  mount: string;
  fs: string;
}

/** Unescapes octal sequences in /proc/mounts fields (\040 = space). */
function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

/** Parses /proc/<pid>/mounts and keeps real, persistent file systems, one per device. */
export function parseMounts(text: string): MountEntry[] {
  const seen = new Set<string>();
  const out: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const [source, mount, fs] = line.split(' ');
    if (!source || !mount || !fs) continue;
    if (SKIP_FS.has(fs)) continue;
    const realDevice = source.startsWith('/dev/') || fs === 'zfs' || fs === 'btrfs';
    if (!realDevice) continue;
    if (source.startsWith('/dev/loop')) continue;
    const m = unescapeMount(mount);
    // Docker's own bind mounts of single files (/etc/hosts ...) inside containers.
    if (m.startsWith('/var/lib/docker/') || m.startsWith('/run/') || m.startsWith('/snap/'))
      continue;
    if (seen.has(source)) continue;
    seen.add(source);
    out.push({ source, mount: m, fs });
  }
  return out.slice(0, 32);
}

export interface NetCounters {
  rx: number;
  tx: number;
}

const SKIP_IFACE = /^(lo|veth|docker|br-|virbr|vnet|tailscale|wg|tun|tap|cni|flannel|kube|cali|zt)/;

/** Parses /proc/net/dev, sums physical interfaces. */
export function parseNetDev(text: string): NetCounters {
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const iface = line.slice(0, idx).trim();
    if (SKIP_IFACE.test(iface)) continue;
    const cols = line
      .slice(idx + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    const r = cols[0];
    const t = cols[8];
    if (r === undefined || t === undefined || !Number.isFinite(r) || !Number.isFinite(t)) continue;
    rx += r;
    tx += t;
  }
  return { rx, tx };
}

export function parseOsRelease(text: string): string | null {
  const vars: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) vars[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return vars.PRETTY_NAME ?? vars.NAME ?? null;
}

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

const clampPct = (n: number): number => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);
const nonNeg = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

export class SystemCollector {
  private lastNet: { at: number; c: NetCounters } | null = null;

  constructor(
    private readonly ctx: Pick<HostContext, 'hostProc' | 'hostRoot'>,
    private readonly now: () => number = Date.now,
  ) {}

  async disks(): Promise<Disk[]> {
    let text = await readText(path.join(this.ctx.hostProc, '1', 'mounts'));
    let root = this.ctx.hostRoot;
    if (text === null) {
      text = await readText('/proc/self/mounts');
      root = '/';
    }
    if (text === null) return [];
    const out: Disk[] = [];
    for (const m of parseMounts(text)) {
      try {
        const s = await statfs(path.join(root, m.mount));
        const total = s.blocks * s.bsize;
        const free = s.bfree * s.bsize;
        if (total <= 0) continue;
        out.push({
          mount: m.mount.slice(0, 256),
          fs: m.fs.slice(0, 64),
          usedBytes: nonNeg(total - free),
          totalBytes: total,
        });
      } catch {
        // Not reachable from here (e.g. permissions); skip this mount.
      }
    }
    return out;
  }

  async temperature(): Promise<number | null> {
    try {
      const t = await si.cpuTemperature();
      const best = Math.max(t.max ?? -Infinity, t.main ?? -Infinity, ...(t.cores ?? []));
      if (Number.isFinite(best) && best > 0 && best < 150) return best;
    } catch {
      // fall through
    }
    try {
      const base = '/sys/class/thermal';
      let max = -Infinity;
      for (const z of await readdir(base)) {
        if (!z.startsWith('thermal_zone')) continue;
        const raw = await readText(path.join(base, z, 'temp'));
        const v = raw === null ? NaN : Number(raw.trim()) / 1000;
        if (Number.isFinite(v) && v > max) max = v;
      }
      if (Number.isFinite(max) && max > -50 && max < 150) return Math.round(max * 10) / 10;
    } catch {
      // no thermal zones
    }
    return null;
  }

  async net(): Promise<{ rxBps: number; txBps: number }> {
    const text =
      (await readText(path.join(this.ctx.hostProc, '1', 'net', 'dev'))) ??
      (await readText('/proc/net/dev'));
    if (text === null) return { rxBps: 0, txBps: 0 };
    const c = parseNetDev(text);
    const at = this.now();
    const prev = this.lastNet;
    this.lastNet = { at, c };
    if (!prev || at <= prev.at) return { rxBps: 0, txBps: 0 };
    const dt = (at - prev.at) / 1000;
    return { rxBps: nonNeg((c.rx - prev.c.rx) / dt), txBps: nonNeg((c.tx - prev.c.tx) / dt) };
  }

  async metrics(): Promise<Metrics> {
    const [load, mem, disks, temp, net] = await Promise.all([
      si.currentLoad().catch(() => null),
      si.mem().catch(() => null),
      this.disks(),
      this.temperature(),
      this.net(),
    ]);
    return {
      type: 'metrics',
      ts: new Date(this.now()).toISOString(),
      cpu: clampPct(load?.currentLoad ?? 0),
      load1: nonNeg(os.loadavg()[0] ?? 0),
      ram: {
        // "active" excludes buffers/cache, like `free` "used".
        usedBytes: nonNeg(mem?.active ?? 0),
        totalBytes: nonNeg(mem?.total ?? 0),
      },
      swap: { usedBytes: nonNeg(mem?.swapused ?? 0), totalBytes: nonNeg(mem?.swaptotal ?? 0) },
      disks,
      temp: temp === null ? null : Math.round(temp * 10) / 10,
      net,
      uptimeS: nonNeg(os.uptime()),
    };
  }

  /** Host OS name from the host's /etc/os-release (the container's would be Debian). */
  async osName(): Promise<string> {
    const text =
      (await readText(hostPath(this.ctx, '/etc/os-release'))) ??
      (await readText(hostPath(this.ctx, '/usr/lib/os-release')));
    return ((text && parseOsRelease(text)) ?? `${os.type()} ${os.release()}`).slice(0, 120);
  }

  async systemInfo(dockerVersion: string | undefined): Promise<SystemInfo> {
    const cpu = await si.cpu().catch(() => null);
    const info: SystemInfo = {
      hostname: os.hostname().slice(0, 128),
      os: await this.osName(),
      kernel: os.release().slice(0, 120),
      arch: normalizeArch(os.arch()).slice(0, 20),
    };
    const model = cpu ? `${cpu.manufacturer} ${cpu.brand}`.trim() : '';
    if (model) info.cpuModel = model.slice(0, 160);
    const cores = cpu?.cores ?? os.cpus().length;
    if (cores > 0) info.cpuCores = cores;
    const ts = tailscaleIp(os.networkInterfaces());
    if (ts) info.tailscaleIp = ts;
    if (dockerVersion) info.dockerVersion = dockerVersion.slice(0, 40);
    return info;
  }
}

/** The 100.64.0.0/10 address of tailscale0 (host network namespace). */
export function tailscaleIp(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | undefined {
  const pick = (list: os.NetworkInterfaceInfo[] | undefined) =>
    list?.find(
      (a) => a.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address),
    )?.address;
  return pick(ifaces.tailscale0) ?? Object.values(ifaces).map(pick).find(Boolean);
}

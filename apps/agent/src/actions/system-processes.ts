import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  processesDataSchema,
  type ProcessInfo,
  type ProcessSort,
  type ProcessesData,
  type RpcParams,
} from '@hz/shared';
import { hostPath } from '../host.js';
import type { ActionContext } from './types.js';

/**
 * system.processes: top host processes by CPU or RAM, read straight from the
 * host /proc (the agent runs with `pid: host`).
 *
 * Privacy: only /proc/<pid>/stat, status and cgroup are read. The command line
 * (/proc/<pid>/cmdline) and the environment are never opened; arguments can hold
 * passwords and tokens. `name` is the kernel's comm (max 15 characters).
 *
 * CPU is the share of the whole machine over a short sample (default 500 ms):
 * delta of the process' utime+stime divided by the delta of all CPU jiffies in
 * /proc/stat, so 100 means every core busy. RAM is VmRSS. Start time uses
 * btime + starttime / USER_HZ (100 on every Linux architecture we run on).
 */

export const SAMPLE_MS = 500;
const USER_HZ = 100;
const MAX_PIDS = 20_000;

interface ProcSample {
  pid: number;
  comm: string;
  state: string;
  ticks: number;
  starttime: number;
}

/** Parses /proc/<pid>/stat. comm may contain spaces and ')' -> split at the last ')'. */
export function parseProcStat(text: string): Omit<ProcSample, 'pid'> | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const comm = text.slice(open + 1, close);
  const rest = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // rest[0] = state (field 3); utime = field 14, stime = 15, starttime = 22.
  const state = rest[0];
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const starttime = Number(rest[19]);
  if (!state || !Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return {
    comm,
    state,
    ticks: utime + stime,
    starttime: Number.isFinite(starttime) ? starttime : 0,
  };
}

/** Sum of all CPU jiffies (first "cpu" line of /proc/stat) and btime. */
export function parseProcStatTotals(text: string): { total: number; btime: number | null } {
  let total = 0;
  let btime: number | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('cpu ')) {
      // user nice system idle iowait irq softirq steal (guest is already in user).
      total = line
        .trim()
        .split(/\s+/)
        .slice(1, 9)
        .map(Number)
        .filter(Number.isFinite)
        .reduce((s, n) => s + n, 0);
    } else if (line.startsWith('btime ')) {
      const n = Number(line.slice(6).trim());
      if (Number.isFinite(n)) btime = n;
    }
  }
  return { total, btime };
}

/** VmRSS (bytes) and real uid from /proc/<pid>/status. */
export function parseProcStatus(text: string): { rssBytes: number; uid: number | null } {
  const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(text);
  const uid = /^Uid:\s+(\d+)/m.exec(text);
  return {
    rssBytes: rss?.[1] ? Number(rss[1]) * 1024 : 0,
    uid: uid?.[1] ? Number(uid[1]) : null,
  };
}

export function parseMemTotal(text: string): number {
  const m = /^MemTotal:\s+(\d+)\s+kB/m.exec(text);
  return m?.[1] ? Number(m[1]) * 1024 : 0;
}

/** uid -> user name from an /etc/passwd text. */
export function parsePasswd(text: string): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of text.split('\n')) {
    const [name, , uid] = line.split(':');
    if (!name || uid === undefined || !/^\d+$/.test(uid)) continue;
    if (!users.has(Number(uid))) users.set(Number(uid), name.slice(0, 64));
  }
  return users;
}

/** Docker container id (64 hex) from /proc/<pid>/cgroup, if the process runs in one. */
export function containerIdFromCgroup(text: string): string | null {
  for (const line of text.split('\n')) {
    const m = /(?:docker[-/]|\/containers\/)([0-9a-f]{64})(?:\.scope)?(?:\/|$)/.exec(line);
    if (m?.[1]) return m[1];
  }
  return null;
}

async function read(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function sampleAll(procDir: string): Promise<Map<number, ProcSample>> {
  const out = new Map<number, ProcSample>();
  let names: string[];
  try {
    names = await readdir(procDir);
  } catch {
    return out;
  }
  const pids = names.filter((n) => /^\d+$/.test(n)).slice(0, MAX_PIDS);
  await Promise.all(
    pids.map(async (n) => {
      const text = await read(path.join(procDir, n, 'stat'));
      const s = text ? parseProcStat(text) : null;
      if (s) out.set(Number(n), { pid: Number(n), ...s });
    }),
  );
  return out;
}

export interface ProcessOptions {
  procDir: string;
  hostRoot: string;
  sort: ProcessSort;
  limit: number;
  /** Waits between the two CPU samples (tests replace it). */
  wait?: () => Promise<void>;
  /** Docker container id (64 hex) -> name. */
  containerNames?: () => Promise<Map<string, string>>;
  now?: () => number;
}

export async function collectProcesses(o: ProcessOptions): Promise<ProcessesData> {
  const stat0 = parseProcStatTotals((await read(path.join(o.procDir, 'stat'))) ?? '');
  const first = await sampleAll(o.procDir);
  await (o.wait ?? (() => new Promise<void>((r) => setTimeout(r, SAMPLE_MS))))();
  const statText = (await read(path.join(o.procDir, 'stat'))) ?? '';
  const stat1 = parseProcStatTotals(statText);
  const second = await sampleAll(o.procDir);
  const memTotal = parseMemTotal((await read(path.join(o.procDir, 'meminfo'))) ?? '');
  const dTotal = Math.max(1, stat1.total - stat0.total);

  const rows = await Promise.all(
    [...second.values()].map(async (s) => {
      const st = parseProcStatus((await read(path.join(o.procDir, String(s.pid), 'status'))) ?? '');
      const before = first.get(s.pid);
      // A pid that appeared during the sample: no delta, report 0.
      const dTicks = before && before.starttime === s.starttime ? s.ticks - before.ticks : 0;
      const cpu = Math.min(100, Math.max(0, (dTicks / dTotal) * 100));
      return { s, cpu, rss: st.rssBytes, uid: st.uid };
    }),
  );
  rows.sort((a, b) =>
    o.sort === 'cpu'
      ? b.cpu - a.cpu || b.rss - a.rss || a.s.pid - b.s.pid
      : b.rss - a.rss || b.cpu - a.cpu || a.s.pid - b.s.pid,
  );
  const top = rows.slice(0, o.limit);

  const users = parsePasswd((await read(hostPath({ hostRoot: o.hostRoot }, '/etc/passwd'))) ?? '');
  const names = (await o.containerNames?.().catch(() => null)) ?? null;
  const now = o.now ?? Date.now;

  const list: ProcessInfo[] = await Promise.all(
    top.map(async ({ s, cpu, rss, uid }) => {
      const info: ProcessInfo = {
        pid: s.pid,
        name: s.comm.slice(0, 64),
        user: uid === null ? '?' : (users.get(uid) ?? String(uid)).slice(0, 64),
        cpu: Math.round(cpu * 10) / 10,
        memBytes: rss,
        memPct: memTotal > 0 ? Math.min(100, Math.round((rss / memTotal) * 1000) / 10) : 0,
        state: s.state.slice(0, 16),
      };
      if (stat1.btime !== null && s.starttime > 0) {
        const ms = (stat1.btime + s.starttime / USER_HZ) * 1000;
        if (ms > 0 && ms <= now() + 60_000) info.startedAt = new Date(ms).toISOString();
      }
      if (names && names.size > 0) {
        const cg = await read(path.join(o.procDir, String(s.pid), 'cgroup'));
        const id = cg ? containerIdFromCgroup(cg) : null;
        const name = id ? names.get(id) : undefined;
        if (name) info.container = name.slice(0, 128);
      }
      return info;
    }),
  );
  return processesDataSchema.parse({ total: second.size, list });
}

export async function systemProcesses(
  params: RpcParams<'system.processes'>,
  ctx: ActionContext,
): Promise<ProcessesData> {
  const docker = ctx.host.docker;
  return collectProcesses({
    procDir: ctx.host.hostProc,
    hostRoot: ctx.host.hostRoot,
    sort: params.sort,
    limit: params.limit,
    ...(docker
      ? {
          containerNames: async () => {
            const list = await docker.listContainers({ all: false });
            const m = new Map<string, string>();
            for (const c of list)
              m.set(c.Id, (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''));
            return m;
          },
        }
      : {}),
  });
}

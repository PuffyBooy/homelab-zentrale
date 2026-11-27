import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectProcesses,
  containerIdFromCgroup,
  parsePasswd,
  parseProcStat,
} from '../src/actions/system-processes.js';

const CID = 'c'.repeat(64);
const SECRET = 'hunter2-SUPERSECRET';

let base: string;
let proc: string;
let root: string;

function statLine(pid: number, comm: string, ticks: number, start = 1000) {
  // fields 3.. : state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ...
  const f = ['S', '1', '1', '1', '0', '-1', '0', '0', '0', '0', '0', String(ticks), '0'];
  f.push('0', '0', '20', '0', '1', '0', String(start), '1000', '100');
  return `${pid} (${comm}) ${f.join(' ')}\n`;
}

async function proc_(
  pid: number,
  comm: string,
  ticks: number,
  rssKb: number,
  uid: number,
  cgroup = '0::/init.scope\n',
) {
  const d = path.join(proc, String(pid));
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, 'stat'), statLine(pid, comm, ticks));
  await writeFile(
    path.join(d, 'status'),
    `Name:\t${comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nVmRSS:\t${rssKb} kB\n`,
  );
  await writeFile(path.join(d, 'cgroup'), cgroup);
  // Must never be read or returned.
  await writeFile(path.join(d, 'cmdline'), `${comm}\0--password=${SECRET}\0`);
  await writeFile(path.join(d, 'environ'), `TOKEN=${SECRET}\0`);
}

const cpuLine = (total: number) => `cpu  ${total} 0 0 0 0 0 0 0 0 0\nbtime 1700000000\n`;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'hz-ps-'));
  proc = path.join(base, 'proc');
  root = path.join(base, 'root');
  await mkdir(path.join(root, 'etc'), { recursive: true });
  await mkdir(proc, { recursive: true });
  await writeFile(
    path.join(root, 'etc', 'passwd'),
    'root:x:0:0::/root:/bin/sh\nanna:x:1000:1000::/home/anna:/bin/sh\n',
  );
  await writeFile(path.join(proc, 'meminfo'), 'MemTotal:       1000000 kB\n');
  await writeFile(path.join(proc, 'stat'), cpuLine(10_000));
  await proc_(1, 'systemd', 100, 10_000, 0);
  await proc_(200, 'java', 1000, 500_000, 1000, `0::/system.slice/docker-${CID}.scope\n`);
  await proc_(300, 'my proc) x', 2000, 1000, 4242);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Between the two samples: 1000 jiffies pass; java uses 400, "my proc" 100. */
const tick = async () => {
  await writeFile(path.join(proc, 'stat'), cpuLine(11_000));
  await writeFile(path.join(proc, '200', 'stat'), statLine(200, 'java', 1400));
  await writeFile(path.join(proc, '300', 'stat'), statLine(300, 'my proc) x', 2100));
};

describe('system.processes', () => {
  it('cpu is the share of the whole machine; sorted by cpu', async () => {
    const r = await collectProcesses({
      procDir: proc,
      hostRoot: root,
      sort: 'cpu',
      limit: 25,
      wait: tick,
    });
    expect(r.total).toBe(3);
    expect(r.list.map((p) => [p.pid, p.name, p.cpu])).toEqual([
      [200, 'java', 40],
      [300, 'my proc) x', 10],
      [1, 'systemd', 0],
    ]);
  });

  it('sorts by RAM, resolves users and containers, limits', async () => {
    const r = await collectProcesses({
      procDir: proc,
      hostRoot: root,
      sort: 'mem',
      limit: 2,
      wait: tick,
      containerNames: async () => new Map([[CID, 'minecraft']]),
    });
    expect(r.list).toHaveLength(2);
    expect(r.list[0]).toMatchObject({
      pid: 200,
      user: 'anna',
      memBytes: 500_000 * 1024,
      memPct: 50,
      container: 'minecraft',
      state: 'S',
    });
    expect(r.list[0]?.startedAt).toBe(new Date((1_700_000_000 + 10) * 1000).toISOString());
    expect(r.list[1]).toMatchObject({ pid: 1, user: 'root' });
    expect(r.list[1]?.container).toBeUndefined();
  });

  it('unknown uid falls back to the number', async () => {
    const r = await collectProcesses({
      procDir: proc,
      hostRoot: root,
      sort: 'cpu',
      limit: 1,
      wait: tick,
    });
    const all = await collectProcesses({
      procDir: proc,
      hostRoot: root,
      sort: 'cpu',
      limit: 5,
      wait: tick,
    });
    expect(r.list).toHaveLength(1);
    expect(all.list.find((p) => p.pid === 300)?.user).toBe('4242');
  });

  it('never contains command lines, arguments or the environment', async () => {
    const r = await collectProcesses({
      procDir: proc,
      hostRoot: root,
      sort: 'cpu',
      limit: 50,
      wait: tick,
      containerNames: async () => new Map([[CID, 'minecraft']]),
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('--password');
    expect(json).not.toContain('cmdline');
    for (const p of r.list) {
      const allowed = [
        'container',
        'cpu',
        'memBytes',
        'memPct',
        'name',
        'pid',
        'startedAt',
        'state',
        'user',
      ];
      for (const k of Object.keys(p)) expect(allowed).toContain(k);
      expect(p).not.toHaveProperty('command');
      expect(p).not.toHaveProperty('args');
    }
  });
});

describe('proc parsers', () => {
  it('stat with parentheses in comm', () => {
    expect(parseProcStat(statLine(5, 'a) (b', 7))).toMatchObject({
      comm: 'a) (b',
      ticks: 7,
      state: 'S',
    });
    expect(parseProcStat('garbage')).toBeNull();
  });

  it('container id from cgroup v1 and v2 lines', () => {
    expect(containerIdFromCgroup(`0::/system.slice/docker-${CID}.scope\n`)).toBe(CID);
    expect(containerIdFromCgroup(`12:memory:/docker/${CID}\n`)).toBe(CID);
    expect(containerIdFromCgroup('0::/user.slice\n')).toBeNull();
  });

  it('passwd: first entry per uid wins', () => {
    expect(parsePasswd('a:x:0:0::/:/\nb:x:0:0::/:/\nbad\n').get(0)).toBe('a');
  });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inventorySchema, metricsSchema } from '@hz/shared';
import { parseJournalUsage, parseOldKernelPackages } from '../src/actions/system-cleanup.js';
import { parsePingAvg } from '../src/actions/checks.js';
import { healthFromStatus, mapContainer } from '../src/collect/docker.js';
import { collectInventory } from '../src/collect/inventory.js';
import {
  countSshFailures,
  parseAptUpgradable,
  parseAuthLog,
  parseFail2banBanned,
  parseFail2banJails,
  parseJournalJson,
  parseProcNet,
  parseSs,
  rebootRequired,
} from '../src/collect/security.js';
import {
  SystemCollector,
  parseMounts,
  parseNetDev,
  parseOsRelease,
} from '../src/collect/system.js';
import { makeHostExec } from '../src/exec.js';

describe('apt', () => {
  it('counts upgradable and security updates', () => {
    const out = [
      'Listing... Done',
      'openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]',
      'libssl3/bookworm-security 3.0.15-1~deb12u1 arm64 [upgradable from: 3.0.11-1~deb12u2]',
      'tzdata/stable-updates 2024b-0+deb12u1 all [upgradable from: 2024a-0+deb12u1]',
      'WARNING: apt does not have a stable CLI interface.',
    ].join('\n');
    expect(parseAptUpgradable(out)).toEqual({ total: 3, security: 2 });
    expect(parseAptUpgradable('Listing... Done\n')).toEqual({ total: 0, security: 0 });
  });
});

describe('ssh failures', () => {
  it('counts per sshd pid without double counting invalid users', () => {
    const entries = [
      { pid: '1', message: 'Invalid user admin from 1.2.3.4 port 5' },
      { pid: '1', message: 'Failed password for invalid user admin from 1.2.3.4 port 5 ssh2' },
      { pid: '1', message: 'Failed password for invalid user admin from 1.2.3.4 port 5 ssh2' },
      { pid: '2', message: 'Invalid user test from 1.2.3.4 port 6' },
      { pid: '3', message: 'Failed publickey for admin from 1.2.3.4 port 7 ssh2' },
      { pid: '4', message: 'Accepted publickey for admin from 100.64.0.2 port 8 ssh2' },
    ];
    expect(countSshFailures(entries)).toBe(4);
  });

  it('parses journalctl json', () => {
    const text =
      '{"MESSAGE":"Failed password for root from 1.2.3.4","_PID":"9"}\nnoise\n{"MESSAGE":[1,2]}\n';
    expect(parseJournalJson(text)).toEqual([
      { pid: '9', message: 'Failed password for root from 1.2.3.4' },
    ]);
  });

  it('parses auth.log in both timestamp formats and keeps 24 h', () => {
    const now = Date.parse('2026-11-25T12:00:00Z');
    const text = [
      '2026-11-25T10:00:00.123456+00:00 host sshd[100]: Failed password for root from 1.2.3.4 port 1 ssh2',
      '2026-11-23T10:00:00+00:00 host sshd[101]: Failed password for root from 1.2.3.4 port 1 ssh2',
      '2026-11-25T11:00:00+00:00 host sshd-session[102]: Invalid user x from 1.2.3.4 port 1',
      '2026-11-25T11:00:00+00:00 host CRON[5]: pam_unix(cron:session): session opened',
    ].join('\n');
    const e = parseAuthLog(text, now - 86_400_000, now);
    expect(e.map((x) => x.pid)).toEqual(['100', '102']);
    const classic = `${new Date(now - 3600_000).toLocaleString('en-US', { month: 'short' })} ${new Date(now - 3600_000).getDate()} 11:00:00 host sshd[7]: Failed password for root`;
    expect(parseAuthLog(classic, now - 86_400_000 * 2, now)).toHaveLength(1);
  });
});

describe('fail2ban', () => {
  it('parses jails and banned counts, drops odd jail names', () => {
    const status = 'Status\n|- Number of jail:\t2\n`- Jail list:\tsshd, recidive, $(id)\n';
    expect(parseFail2banJails(status)).toEqual(['sshd', 'recidive']);
    expect(parseFail2banBanned('|- Currently failed:\t1\n|  `- Currently banned:\t5\n')).toBe(5);
  });
});

describe('ports', () => {
  it('parses ss output', () => {
    const text = [
      'tcp   LISTEN 0      4096       127.0.0.1:8080       0.0.0.0:*    users:(("node",pid=12,fd=20))',
      'tcp   LISTEN 0      128             [::]:22            [::]:*    users:(("sshd",pid=1,fd=4))',
      'udp   UNCONN 0      0      100.64.0.1%tailscale0:41641  0.0.0.0:*',
      'garbage',
    ].join('\n');
    expect(parseSs(text)).toEqual([
      { proto: 'tcp', address: '::', port: 22, process: 'sshd' },
      { proto: 'tcp', address: '127.0.0.1', port: 8080, process: 'node' },
      { proto: 'udp', address: '100.64.0.1', port: 41641 },
    ]);
  });

  it('parses /proc/net/tcp and udp', () => {
    const tcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1',
      '   1: 0100007F:1F91 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 2',
    ].join('\n');
    expect(parseProcNet(tcp, 'tcp', false)).toEqual([
      { proto: 'tcp', address: '127.0.0.1', port: 8080 },
    ]);
    const tcp6 = [
      'header',
      '   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 0 0 0 0 0 0',
    ].join('\n');
    expect(parseProcNet(tcp6, 'tcp', true)).toEqual([{ proto: 'tcp', address: '::', port: 22 }]);
    const udp = ['header', '  1: 00000000:14E9 00000000:0000 07 0 0 0 0 0 0'].join('\n');
    expect(parseProcNet(udp, 'udp', false)).toEqual([
      { proto: 'udp', address: '0.0.0.0', port: 5353 },
    ]);
  });
});

describe('system parsers', () => {
  it('keeps real file systems from the mount table', () => {
    const text = [
      '/dev/sda1 / ext4 rw,relatime 0 0',
      'tmpfs /run tmpfs rw 0 0',
      'overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0',
      '/dev/loop0 /snap/core/1 squashfs ro 0 0',
      '/dev/sda2 /mnt/my\\040disk ext4 rw 0 0',
      '/dev/sda1 /var/lib/docker ext4 rw 0 0',
      'proc /proc proc rw 0 0',
      '/dev/mmcblk0p1 /boot/firmware vfat rw 0 0',
    ].join('\n');
    expect(parseMounts(text)).toEqual([
      { source: '/dev/sda1', mount: '/', fs: 'ext4' },
      { source: '/dev/sda2', mount: '/mnt/my disk', fs: 'ext4' },
      { source: '/dev/mmcblk0p1', mount: '/boot/firmware', fs: 'vfat' },
    ]);
  });

  it('sums physical interfaces in /proc/net/dev', () => {
    const text = [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      '    lo: 1000 1 0 0 0 0 0 0 1000 1 0 0 0 0 0 0',
      '  eth0: 5000 1 0 0 0 0 0 0 7000 1 0 0 0 0 0 0',
      'docker0: 99 1 0 0 0 0 0 0 99 1 0 0 0 0 0 0',
      'vethab12: 99 1 0 0 0 0 0 0 99 1 0 0 0 0 0 0',
      'tailscale0: 99 1 0 0 0 0 0 0 99 1 0 0 0 0 0 0',
      ' wlan0: 1 1 0 0 0 0 0 0 2 1 0 0 0 0 0 0',
    ].join('\n');
    expect(parseNetDev(text)).toEqual({ rx: 5001, tx: 7002 });
  });

  it('reads the host os name', () => {
    expect(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n')).toBe(
      'Ubuntu 24.04.1 LTS',
    );
  });

  it('collects schema-valid metrics on this machine', async () => {
    const s = new SystemCollector({ hostProc: '/proc', hostRoot: '/' });
    const m = await s.metrics();
    expect(metricsSchema.safeParse(m).success).toBe(true);
    expect(m.ram.totalBytes).toBeGreaterThan(0);
  });

  it('collects a schema-valid inventory without docker or host commands', async () => {
    const s = new SystemCollector({ hostProc: '/proc', hostRoot: '/' });
    const inv = await collectInventory(
      { hostProc: '/proc', hostRoot: '/', docker: null, exec: makeHostExec('none') },
      s,
    );
    const parsed = inventorySchema.safeParse(inv);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(inv.updates).toBeNull();
    expect(inv.fail2banBanned).toBeNull();
  });

  it('reads reboot-required through the host root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hz-root-'));
    try {
      expect(await rebootRequired({ hostRoot: root })).toBe(false);
      await mkdir(path.join(root, 'run'));
      await writeFile(path.join(root, 'run', 'reboot-required'), '');
      expect(await rebootRequired({ hostRoot: root })).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('docker mapping', () => {
  it('maps a container and its health', () => {
    expect(healthFromStatus('Up 3 hours (healthy)')).toBe('healthy');
    expect(healthFromStatus('Up 1 second (health: starting)')).toBe('starting');
    expect(healthFromStatus('Exited (137) 2 minutes ago')).toBe('none');
    const c = mapContainer({
      Id: 'a'.repeat(64),
      Names: ['/minecraft'],
      Image: 'itzg/minecraft-server',
      ImageID: 'sha256:abc',
      Command: '',
      Created: 0,
      State: 'exited',
      Status: 'Exited (137) 2 minutes ago',
      Ports: [{ IP: '0.0.0.0', PrivatePort: 25565, PublicPort: 25565, Type: 'tcp' }],
      Labels: {
        'com.docker.compose.project': 'mc',
        'com.docker.compose.project.working_dir': '/opt/homelab/games/mc',
      },
      HostConfig: { NetworkMode: 'bridge' },
      NetworkSettings: { Networks: {} },
      Mounts: [],
    });
    expect(c).toMatchObject({
      name: 'minecraft',
      state: 'exited',
      exitCode: 137,
      composeProject: 'mc',
      composeDir: '/opt/homelab/games/mc',
      ports: [{ privatePort: 25565, publicPort: 25565, ip: '0.0.0.0', proto: 'tcp' }],
    });
  });
});

describe('cleanup parsers', () => {
  it('parses journal disk usage', () => {
    expect(parseJournalUsage('Archived and active journals take up 1.5G in the file system.')).toBe(
      Math.round(1.5 * 1024 ** 3),
    );
    expect(parseJournalUsage('Archived and active journals take up 8.0M in the file system.')).toBe(
      8 * 1024 ** 2,
    );
    expect(parseJournalUsage('nope')).toBeNull();
  });

  it('picks old kernels from the autoremove simulation, never the running one', () => {
    const sim = [
      'Reading package lists...',
      'Purg linux-image-5.15.0-88-generic [5.15.0-88.98]',
      'Purg linux-modules-5.15.0-88-generic [5.15.0-88.98]',
      'Purg linux-headers-5.15.0-88 [5.15.0-88.98]',
      'Purg linux-image-5.15.0-91-generic [5.15.0-91.101]',
      'Purg linux-headers-5.15.0-91 [5.15.0-91.101]',
      'Purg libfoo1 [1.0]',
      'Remv linux-image-6.1.0-13-arm64-unsigned [6.1.55-1]',
    ].join('\n');
    const r = parseOldKernelPackages(sim, '5.15.0-91-generic');
    expect(r.packages).toEqual([
      'linux-image-5.15.0-88-generic',
      'linux-modules-5.15.0-88-generic',
      'linux-headers-5.15.0-88',
      'linux-image-6.1.0-13-arm64-unsigned',
    ]);
    expect(r.versions).toEqual(['5.15.0-88-generic', '5.15.0-88', '6.1.0-13-arm64']);
  });

  it('parses ping rtt', () => {
    expect(parsePingAvg('rtt min/avg/max/mdev = 0.031/0.042/0.051/0.008 ms')).toBe(0.042);
    expect(parsePingAvg('100% packet loss')).toBeNull();
  });
});

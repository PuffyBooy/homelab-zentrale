import { eq } from 'drizzle-orm';
import type { Metrics } from '@hz/shared';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { toRawRow, type MetricsStore } from '../metrics/store.js';
import type { Scheduler } from '../scheduler.js';
import type { ServerService } from '../servers/service.js';

/**
 * Demo data (HZ_DEMO=1 only, never otherwise): the three servers of
 * design/reference/previews/Dashboard.html with simulated metrics, for
 * screenshots and tests. Demo servers have no agent token and count as
 * connected; RPCs to them fail with agent_offline.
 */
interface DemoServer {
  name: string;
  location: string;
  tailscaleIp: string;
  arch: string;
  os: string;
  cpu: number;
  ram: number;
  disk: number;
  temp: number | null;
  uptimeDays: number;
  ramTotal: number;
  diskTotal: number;
}

const GB = 1024 ** 3;

export const DEMO_SERVERS: readonly DemoServer[] = [
  {
    name: 'heimserver',
    location: 'Wien',
    tailscaleIp: '100.64.0.20',
    arch: 'x64',
    os: 'Ubuntu 24.04 LTS',
    cpu: 23,
    ram: 48,
    disk: 81,
    temp: 52,
    uptimeDays: 41,
    ramTotal: 32 * GB,
    diskTotal: 2000 * GB,
  },
  {
    name: 'oracle-a1',
    location: 'Frankfurt',
    tailscaleIp: '100.64.0.21',
    arch: 'arm64',
    os: 'Ubuntu 22.04 LTS',
    cpu: 64,
    ram: 92,
    disk: 37,
    temp: null,
    uptimeDays: 12,
    ramTotal: 24 * GB,
    diskTotal: 200 * GB,
  },
  {
    name: 'soundos-pi',
    location: 'Studio',
    tailscaleIp: '100.64.0.42',
    arch: 'arm64',
    os: 'Raspberry Pi OS 12',
    cpu: 8,
    ram: 31,
    disk: 22,
    temp: 47,
    uptimeDays: 6,
    ramTotal: 8 * GB,
    diskTotal: 64 * GB,
  },
];

function wave(t: number, period: number, phase: number): number {
  return Math.sin((t / period) * 2 * Math.PI + phase);
}

function clamp(v: number): number {
  return Math.min(99, Math.max(0, v));
}

export function demoMetrics(s: DemoServer, i: number, t: number, bootAt: number): Metrics {
  const cpu = clamp(s.cpu + 6 * wave(t, 600_000, i) + 2 * wave(t, 47_000, i * 2));
  // RAM stays below its warn/crit lines except where the preview shows them (oracle-a1 at 92 %).
  const ram = clamp(s.ram + 1.2 * wave(t, 900_000, i));
  return {
    type: 'metrics',
    ts: new Date(t).toISOString(),
    cpu,
    ram: { usedBytes: Math.round((ram / 100) * s.ramTotal), totalBytes: s.ramTotal },
    swap: { usedBytes: 0, totalBytes: 2 * GB },
    disks: [
      {
        mount: '/',
        fs: 'ext4',
        usedBytes: Math.round((s.disk / 100) * s.diskTotal),
        totalBytes: s.diskTotal,
      },
    ],
    temp: s.temp === null ? null : Math.round((s.temp + 2 * wave(t, 600_000, i)) * 10) / 10,
    net: {
      rxBps: Math.round(200_000 + 150_000 * (1 + wave(t, 300_000, i))),
      txBps: Math.round(80_000 + 60_000 * (1 + wave(t, 420_000, i))),
    },
    uptimeS: Math.round((t - bootAt) / 1000) + s.uptimeDays * 86_400,
  };
}

export function seedDemo(deps: {
  db: Db;
  now: Clock;
  servers: ServerService;
  metrics: MetricsStore;
  scheduler: Scheduler;
}): string[] {
  const { db, now } = deps;
  const t0 = now();
  const ids: string[] = [];
  DEMO_SERVERS.forEach((s, i) => {
    let row = db.select().from(servers).where(eq(servers.name, s.name)).get();
    if (!row) {
      row = {
        id: randomToken(16),
        name: s.name,
        location: s.location,
        arch: s.arch,
        os: s.os,
        tailscaleIp: s.tailscaleIp,
        publicIp: null,
        agentVersion: 'demo',
        capabilitiesJson: JSON.stringify({ terminal: false, docker: true }),
        thresholdsJson: '{}',
        allowTerminal: false,
        createdAt: t0,
        lastSeen: t0,
      };
      db.insert(servers).values(row).run();
      // 24 h of history, one sample per minute, so the sparklines have data.
      for (let t = t0 - 24 * 3_600_000; t < t0; t += 60_000) {
        const m = demoMetrics(s, i, t, t0);
        deps.metrics.insert(toRawRow(row.id, t, m));
      }
    }
    deps.servers.markVirtual(row.id);
    deps.servers.ingestInventory(row.id, {
      ts: new Date(t0).toISOString(),
      system: {
        hostname: s.name,
        os: s.os,
        kernel: '6.8.0-45-generic',
        arch: s.arch,
        cpuCores: 4,
        tailscaleIp: s.tailscaleIp,
      },
      containers: [],
      updates: { total: 3, security: 0 },
      rebootRequired: false,
      sshFailed24h: 0,
      fail2banBanned: null,
      listeningPorts: [{ proto: 'tcp', address: '127.0.0.1', port: 8080 }],
    });
    deps.servers.ingestMetrics(row.id, demoMetrics(s, i, t0, t0));
    ids.push(row.id);
  });
  deps.metrics.rollup5m(48 * 3_600_000);
  deps.metrics.rollup1h(48 * 3_600_000);

  deps.scheduler.every('demo.metrics', 10_000, () => {
    const t = now();
    DEMO_SERVERS.forEach((s, i) => {
      const id = ids[i];
      if (id && deps.servers.row(id)) deps.servers.ingestMetrics(id, demoMetrics(s, i, t, t0));
    });
  });
  return ids;
}

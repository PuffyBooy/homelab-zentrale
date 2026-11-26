import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ContainerInfo, Metrics } from '@hz/shared';
import type { Clock } from '../clock.js';
import type { ContainerLogs } from '../containers/logs.js';
import { containerCoreId } from '../containers/service.js';
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
    location: 'Zuhause',
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
    name: 'raspi',
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

const DAY_MS = 86_400_000;

interface DemoContainer {
  name: string;
  image: string;
  state: ContainerInfo['state'];
  health?: ContainerInfo['health'];
  exitCode?: number;
  /** Days since start (running) or since exit. */
  days: number;
  port?: number;
  compose?: { project: string; dir: string };
  cpu?: number;
  memMb?: number;
}

/**
 * Containers from design/reference/previews/Dashboard.html and ServiceRow.html
 * (homeassistant, lernplattform exit 1, uptime-kuma off, minecraft-paper) plus
 * the agent on every server.
 */
export const DEMO_CONTAINERS: Readonly<Record<string, readonly DemoContainer[]>> = {
  heimserver: [
    {
      name: 'homeassistant',
      image: 'ghcr.io/home-assistant/home-assistant:stable',
      state: 'running',
      health: 'healthy',
      days: 41,
      port: 8123,
      compose: { project: 'homeassistant', dir: '/opt/homelab/apps/homeassistant' },
      cpu: 3.2,
      memMb: 612,
    },
    {
      name: 'lernplattform',
      image: 'lernplattform:latest',
      state: 'exited',
      exitCode: 1,
      days: 0.02,
      port: 3000,
      compose: { project: 'lernplattform', dir: '/opt/homelab/apps/lernplattform' },
    },
    {
      name: 'uptime-kuma',
      image: 'louislam/uptime-kuma:1',
      state: 'exited',
      exitCode: 0,
      days: 3,
      port: 3001,
    },
    {
      name: 'homelab-agent',
      image: 'homelab-zentrale/agent:local',
      state: 'running',
      days: 41,
      cpu: 0.6,
      memMb: 48,
    },
  ],
  'oracle-a1': [
    {
      name: 'minecraft-paper',
      image: 'itzg/minecraft-server:java21',
      state: 'running',
      health: 'healthy',
      days: 12,
      port: 25565,
      compose: { project: 'minecraft-paper', dir: '/opt/homelab/games/minecraft-paper' },
      cpu: 38,
      memMb: 6144,
    },
    {
      name: 'homelab-agent',
      image: 'homelab-zentrale/agent:local',
      state: 'running',
      days: 12,
      cpu: 0.8,
      memMb: 52,
    },
  ],
  raspi: [
    {
      name: 'homelab-agent',
      image: 'homelab-zentrale/agent:local',
      state: 'running',
      days: 6,
      cpu: 1.1,
      memMb: 44,
    },
  ],
};

function demoContainerInfo(serverName: string, c: DemoContainer, t0: number): ContainerInfo {
  const dockerId = createHash('sha256').update(`${serverName}/${c.name}`).digest('hex');
  const ago = Math.round(c.days * DAY_MS);
  return {
    dockerId,
    name: c.name,
    image: c.image,
    ...(c.compose
      ? { composeProject: c.compose.project, composeService: c.name, composeDir: c.compose.dir }
      : {}),
    state: c.state,
    health: c.health ?? 'none',
    statusText: c.state === 'running' ? 'Up' : `Exited (${c.exitCode ?? 0})`,
    ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {}),
    startedAt: new Date(t0 - (c.state === 'running' ? ago : ago + DAY_MS)).toISOString(),
    ports: c.port ? [{ privatePort: c.port, publicPort: c.port, ip: '0.0.0.0', proto: 'tcp' }] : [],
    ...(c.cpu !== undefined ? { cpu: c.cpu } : {}),
    ...(c.memMb !== undefined ? { memBytes: c.memMb * 1024 * 1024 } : {}),
    restartCount: 0,
  };
}

function demoLogLines(name: string, failed: boolean): string[] {
  const lines = [`${name}: starting`, `${name}: loading configuration`, `${name}: listening`];
  if (failed)
    lines.push('Error: connect ECONNREFUSED 127.0.0.1:5432', `${name}: exited with code 1`);
  return lines;
}

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
  logs?: ContainerLogs;
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
      containers: (DEMO_CONTAINERS[s.name] ?? []).map((c) => demoContainerInfo(s.name, c, t0)),
      updates: { total: 3, security: 0 },
      rebootRequired: false,
      sshFailed24h: 0,
      fail2banBanned: null,
      listeningPorts: [{ proto: 'tcp', address: '127.0.0.1', port: 8080 }],
    });
    deps.servers.ingestMetrics(row.id, demoMetrics(s, i, t0, t0));
    ids.push(row.id);
  });
  const demoLogs = new Map<string, string[]>();
  DEMO_SERVERS.forEach((s, i) => {
    const id = ids[i];
    if (!id) return;
    for (const c of DEMO_CONTAINERS[s.name] ?? []) {
      demoLogs.set(containerCoreId(id, c.name), demoLogLines(c.name, (c.exitCode ?? 0) !== 0));
    }
  });
  deps.logs?.setDemoSource((containerId) => demoLogs.get(containerId) ?? null);
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

import type { Alert, ContainerSummary, ServerDetail, ServerSummary } from '@hz/shared';

/** Test data builders (unit tests only). */

let n = 0;
export function server(over: Partial<ServerSummary> = {}): ServerSummary {
  n++;
  return {
    id: `srv-${String(n).padStart(6, '0')}`,
    name: `server-${n}`,
    location: 'Wien',
    arch: 'x64',
    os: 'Debian 12',
    tailscaleIp: '100.64.0.1',
    publicIp: null,
    status: 'ok',
    reasons: [],
    connected: true,
    lastSeen: '2026-11-25T22:04:00.000Z',
    agentVersion: '0.2.0',
    cpu: 23.4,
    ramPct: 48.2,
    diskPct: 81,
    temp: 44,
    uptimeS: 41 * 86400,
    allowTerminal: false,
    containersRunning: 0,
    containersTotal: 0,
    ...over,
  };
}

export function detail(s: ServerSummary): ServerDetail {
  return {
    server: s,
    thresholds: {
      cpuWarn: 85,
      cpuWarnMinutes: 10,
      ramWarn: 90,
      ramCrit: 95,
      ramCritMinutes: 5,
      diskWarn: 85,
      diskCrit: 95,
      tempWarn: 75,
      offlineAfterS: 90,
    },
    system: null,
    ram: null,
    swap: null,
    disks: [],
    net: null,
    updates: null,
    rebootRequired: null,
    sshFailed24h: null,
    fail2banBanned: null,
    listeningPorts: [],
  };
}

let a = 0;
export function alert(over: Partial<Alert> = {}): Alert {
  a++;
  return {
    id: `alert-${String(a).padStart(6, '0')}`,
    key: `server:x:${a}`,
    level: 'crit',
    title: 'web-vps ist offline',
    body: 'Seit 23:02 keine Meldung. Agent und Netzwerk prüfen.',
    serverId: null,
    source: 'server',
    state: 'open',
    openedAt: '2026-11-25T22:02:00.000Z',
    ackedAt: null,
    resolvedAt: null,
    ...over,
  };
}

let c = 0;
export function container(over: Partial<ContainerSummary> = {}): ContainerSummary {
  c++;
  return {
    id: `ctr-${String(c).padStart(6, '0')}`,
    serverId: 'srv-home0001',
    serverName: 'heimserver',
    dockerId: `${String(c).padStart(12, '0')}`,
    name: `container-${c}`,
    image: 'nginx:1.27',
    composeProject: null,
    composeService: null,
    composeManaged: false,
    state: 'running',
    health: 'none',
    status: 'ok',
    statusText: 'Up 3 hours',
    exitCode: null,
    startedAt: '2026-11-25T19:04:00.000Z',
    ports: [],
    cpu: 1.2,
    memBytes: 312 * 1024 ** 2,
    restartCount: 0,
    updatedAt: '2026-11-25T22:04:00.000Z',
    ...over,
  };
}

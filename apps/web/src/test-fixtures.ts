import type { Alert, ServerDetail, ServerSummary } from '@hz/shared';

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

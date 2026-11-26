import type {
  Alert,
  CommitInfo,
  Deploy,
  DeployTarget,
  RepoSummary,
  CheckDef,
  CheckSummary,
  ContainerSummary,
  ServerDetail,
  ServerSummary,
} from '@hz/shared';

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

let k = 0;
export function check(
  over: Partial<Omit<CheckSummary, 'def'>> & { def?: Partial<CheckDef> } = {},
): CheckSummary {
  k++;
  const { def, ...rest } = over;
  const base: CheckDef = {
    kind: 'http',
    name: `site-${k}.at`,
    runFrom: 'core',
    intervalS: 60,
    enabled: true,
    serverId: null,
    url: `https://site-${k}.at/`,
    expectStatusMin: 200,
    expectStatusMax: 399,
    certCheck: true,
  };
  return {
    id: `chk-${String(k).padStart(6, '0')}`,
    def: { ...base, ...def } as CheckDef,
    status: 'ok',
    reason: null,
    lastCode: 200,
    lastMs: 312,
    lastCheckedAt: '2026-11-25T22:04:00.000Z',
    consecutiveFailures: 0,
    sslExpiresAt: '2027-01-25T22:04:00.000Z',
    domainExpiresAt: '2027-06-25T22:04:00.000Z',
    uptime24h: 100,
    uptime7d: 99.95,
    uptime30d: 99.9,
    spark: [300, 310, 320, 312],
    ...rest,
  };
}

let r = 0;
const sha = (k: number): string => k.toString(16).padStart(40, 'a');

export function commit(over: Partial<CommitInfo> = {}): CommitInfo {
  r++;
  return {
    sha: sha(r),
    message: `commit ${r}`,
    author: 'alex',
    at: '2026-11-25T20:04:00.000Z',
    ci: 'ok',
    ...over,
  };
}

export function target(over: Partial<DeployTarget> = {}): DeployTarget {
  r++;
  return {
    id: `tgt-${String(r).padStart(6, '0')}`,
    repoId: 'repo-000001',
    serverId: 'srv-home0001',
    serverName: 'heimserver',
    path: '/opt/homelab/apps/soundos',
    branch: 'main',
    method: 'compose',
    autoDeploy: false,
    keyName: null,
    publicKey: null,
    liveSha: sha(9999),
    behind: 0,
    deploying: false,
    ...over,
  };
}

export function repo(over: Partial<RepoSummary> = {}): RepoSummary {
  r++;
  const name = over.fullName ?? `PuffyBooy/repo-${r}`;
  return {
    id: `repo-${String(r).padStart(6, '0')}`,
    fullName: name,
    private: false,
    defaultBranch: 'main',
    htmlUrl: `https://github.com/${name}`,
    lastCommit: commit(),
    ci: 'ok',
    targets: [],
    updatedAt: '2026-11-25T22:03:00.000Z',
    ...over,
  };
}

export function deploy(over: Partial<Deploy> = {}): Deploy {
  r++;
  return {
    id: `dep-${String(r).padStart(6, '0')}`,
    targetId: 'tgt-000001',
    sha: sha(r),
    status: 'ok',
    trigger: 'manual',
    startedAt: '2026-11-25T22:00:00.000Z',
    finishedAt: '2026-11-25T22:00:42.000Z',
    summary: null,
    ...over,
  };
}

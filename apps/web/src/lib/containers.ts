import {
  containerActionResponseSchema,
  containerListResponseSchema,
  type ContainerAction,
  type ContainerStatus,
  type ContainerSummary,
  type PortMapping,
} from '@hz/shared';
import { api } from './api.js';
import { formatBytes, formatNumber, formatUptimeShort, plural } from './format.js';
import type { StatusSentence } from './servers.js';

export const containersKey = ['containers'] as const;

export async function fetchContainers(signal?: AbortSignal): Promise<ContainerSummary[]> {
  const res = await api('/api/containers', { schema: containerListResponseSchema, signal });
  return res.containers;
}

export function runContainerAction(
  id: string,
  action: ContainerAction,
): Promise<{ ok: true; container: ContainerSummary | null }> {
  return api(`/api/containers/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body: {},
    schema: containerActionResponseSchema,
  });
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure, unit tested)

/** Problems first: crit -> warn -> busy -> ok -> off. */
const RANK: Record<ContainerStatus, number> = { crit: 0, warn: 1, busy: 2, ok: 3, off: 4 };

export function isProblem(c: Pick<ContainerSummary, 'status'>): boolean {
  return c.status === 'crit' || c.status === 'warn';
}

export function isRunning(c: Pick<ContainerSummary, 'state'>): boolean {
  return c.state === 'running' || c.state === 'restarting';
}

/** Worst status of a list; `ok` for an empty list. */
export function worstStatus(list: readonly Pick<ContainerSummary, 'status'>[]): ContainerStatus {
  let best: ContainerStatus = 'ok';
  for (const c of list) {
    if (c.status === 'off') continue;
    if (RANK[c.status] < RANK[best]) best = c.status;
  }
  return best;
}

export function sortContainers<T extends Pick<ContainerSummary, 'status' | 'name'>>(
  list: readonly T[],
): T[] {
  return [...list].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name, 'de-AT'),
  );
}

export interface ProjectGroup {
  /** Stable key: `<serverId>/<project>` or `<serverId>/` for standalone containers. */
  key: string;
  /** Compose project, null for standalone containers. */
  project: string | null;
  status: ContainerStatus;
  containers: ContainerSummary[];
}

export interface ServerGroup {
  serverId: string;
  serverName: string;
  status: ContainerStatus;
  running: number;
  total: number;
  problems: number;
  projects: ProjectGroup[];
}

function groupRank(g: { status: ContainerStatus; problems: number }): number {
  return g.problems > 0 ? RANK[g.status] : 9;
}

/**
 * SPEC 6.1: grouped by server, inside by compose project. Groups with problems come
 * first, then by name. Standalone containers come after the projects of a server.
 */
export function groupContainers(list: readonly ContainerSummary[]): ServerGroup[] {
  const servers = new Map<string, { name: string; items: ContainerSummary[] }>();
  for (const c of list) {
    const s = servers.get(c.serverId) ?? { name: c.serverName, items: [] };
    s.items.push(c);
    servers.set(c.serverId, s);
  }
  const out: ServerGroup[] = [];
  for (const [serverId, s] of servers) {
    const projects = new Map<string, ContainerSummary[]>();
    for (const c of s.items) {
      const k = c.composeProject ?? '';
      projects.set(k, [...(projects.get(k) ?? []), c]);
    }
    const groups: ProjectGroup[] = [...projects].map(([project, items]) => ({
      key: `${serverId}/${project}`,
      project: project || null,
      status: worstStatus(items),
      containers: sortContainers(items),
    }));
    groups.sort((a, b) => {
      const pa = a.containers.filter(isProblem).length;
      const pb = b.containers.filter(isProblem).length;
      return (
        groupRank({ status: a.status, problems: pa }) -
          groupRank({ status: b.status, problems: pb }) ||
        Number(a.project === null) - Number(b.project === null) ||
        (a.project ?? '').localeCompare(b.project ?? '', 'de-AT')
      );
    });
    out.push({
      serverId,
      serverName: s.name,
      status: worstStatus(s.items),
      running: s.items.filter(isRunning).length,
      total: s.items.length,
      problems: s.items.filter(isProblem).length,
      projects: groups,
    });
  }
  return out.sort(
    (a, b) => groupRank(a) - groupRank(b) || a.serverName.localeCompare(b.serverName, 'de-AT'),
  );
}

/** Published ports as ":8123", "127.0.0.1:8080", ":19132/udp". IPv4/IPv6 duplicates merged. */
export function formatPorts(ports: readonly PortMapping[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...ports].sort((a, b) => (a.publicPort ?? 0) - (b.publicPort ?? 0))) {
    if (p.publicPort == null) continue;
    const local = p.ip === '127.0.0.1' || p.ip === '::1' ? '127.0.0.1' : '';
    const s = `${local}:${p.publicPort}${p.proto === 'tcp' ? '' : `/${p.proto}`}`;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.join(', ');
}

/** Second line of a row: image and ports, or server and ports (overview). */
export function containerSub(c: ContainerSummary, withServer = false): string {
  const ports = formatPorts(c.ports);
  const head = withServer ? c.serverName : c.image;
  return ports ? `${head} · ${ports}` : head;
}

export function uptimeOf(c: Pick<ContainerSummary, 'startedAt'>, now: Date): string {
  if (!c.startedAt) return '—';
  return formatUptimeShort((now.getTime() - new Date(c.startedAt).getTime()) / 1000);
}

/**
 * The value that counts for the status (design/reference/components/ServiceRow.md):
 * exit code when stopped, health when unhealthy, otherwise CPU, RAM and uptime.
 */
export function containerMeta(c: ContainerSummary, now: Date, full = true): string {
  if (c.state === 'exited' || c.state === 'dead') {
    return c.exitCode == null ? 'gestoppt' : `exit ${c.exitCode}`;
  }
  if (c.state === 'created') return 'nicht gestartet';
  if (c.state === 'paused') return 'pausiert';
  if (c.state === 'removing') return 'wird entfernt';
  if (c.state === 'restarting') {
    return c.restartCount ? `Neustart · ${plural(c.restartCount, 'Mal', 'Mal')}` : 'Neustart';
  }
  const parts: string[] = [];
  if (c.health === 'unhealthy') parts.push('unhealthy');
  else if (c.health === 'starting') parts.push('startet');
  if (full) {
    if (c.cpu != null) parts.push(`CPU ${formatNumber(c.cpu, c.cpu < 10 ? 1 : 0)} %`);
    if (c.memBytes != null) parts.push(`RAM ${formatBytes(c.memBytes)}`);
  }
  parts.push(uptimeOf(c, now));
  return parts.join(' · ');
}

/** "13 von 14 laufen" */
export function runningCount(list: readonly Pick<ContainerSummary, 'state'>[]): string {
  const running = list.filter(isRunning).length;
  return `${formatNumber(running, 0)} von ${formatNumber(list.length, 0)} ${running === 1 ? 'läuft' : 'laufen'}`;
}

/** Statussatz of the container page: problems first. */
export function containerSentence(list: readonly ContainerSummary[]): StatusSentence {
  if (list.length === 0) return { em: null, rest: 'Keine Container gemeldet.' };
  const bad = list.filter(isProblem);
  const running = list.filter(isRunning).length;
  const verb = running === 1 ? 'läuft' : 'laufen';
  const rest = `${formatNumber(running, 0)} von ${plural(list.length, 'Container', 'Containern')} ${verb}`;
  if (bad.length === 0) return { em: null, rest };
  const one = bad.length === 1 ? bad[0] : undefined;
  const em = one
    ? `${one.name} auf ${one.serverName} ${one.status === 'crit' ? 'ist ausgefallen' : 'hat ein Problem'}`
    : plural(bad.length, 'Problem', 'Probleme');
  return { em, rest: ` · ${rest}` };
}

/** Statussatz of the log page. */
export function containerStateText(c: ContainerSummary): StatusSentence {
  if (c.status === 'crit') {
    const why =
      c.state === 'running' ? 'unhealthy' : c.exitCode != null ? `exit ${c.exitCode}` : c.state;
    return { em: `${c.name} ist ausgefallen`, rest: ` · ${why}` };
  }
  if (c.status === 'warn') return { em: `${c.name} hat ein Problem`, rest: ` · ${c.statusText}` };
  if (c.status === 'off') return { em: null, rest: `${c.name} ist gestoppt.` };
  if (c.status === 'busy') return { em: null, rest: `${c.name} startet.` };
  return { em: null, rest: `${c.name} läuft.` };
}

export const ACTION_LABEL: Record<ContainerAction, string> = {
  start: 'Starten',
  stop: 'Stoppen',
  restart: 'Neu starten',
  update: 'Image aktualisieren',
};

/** Text while an action runs, for the live region. */
export const ACTION_PENDING: Record<ContainerAction, string> = {
  start: 'startet …',
  stop: 'stoppt …',
  restart: 'startet neu …',
  update: 'aktualisiert das Image …',
};

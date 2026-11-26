import {
  cleanupPreviewResponseSchema,
  cleanupResponseSchema,
  enrollResponseSchema,
  historyResponseSchema,
  serverDetailSchema,
  serverListResponseSchema,
  type CleanupPreviewData,
  type EnrollRequest,
  type EnrollResponse,
  type HistoryResponse,
  type ServerDetail,
  type ServerSummary,
} from '@hz/shared';
import type { ServerEntry, ServerInfo, Status } from '@hz/ui';
import { api } from './api.js';
import { formatTime, formatUptimeShort, plural } from './format.js';

export const serversKey = ['servers'] as const;
export const serverKey = (id: string) => ['server', id] as const;
export const historyKey = (id: string, range: string) => ['server', id, 'history', range] as const;

export async function fetchServers(signal?: AbortSignal): Promise<ServerSummary[]> {
  const res = await api('/api/servers', { schema: serverListResponseSchema, signal });
  return res.servers;
}

export function fetchServer(id: string, signal?: AbortSignal): Promise<ServerDetail> {
  return api(`/api/servers/${encodeURIComponent(id)}`, { schema: serverDetailSchema, signal });
}

export function fetchHistory(
  id: string,
  range: HistoryResponse['range'] = '24h',
  signal?: AbortSignal,
): Promise<HistoryResponse> {
  return api(`/api/servers/${encodeURIComponent(id)}/history?range=${range}`, {
    schema: historyResponseSchema,
    signal,
  });
}

export function enrollServer(body: EnrollRequest): Promise<EnrollResponse> {
  return api('/api/servers/enroll', { method: 'POST', body, schema: enrollResponseSchema });
}

export function cleanupPreview(id: string): Promise<CleanupPreviewData> {
  return api(`/api/servers/${encodeURIComponent(id)}/cleanup-preview`, {
    method: 'POST',
    body: {},
    schema: cleanupPreviewResponseSchema,
  });
}

export function runCleanup(id: string): Promise<{ freedBytes: number }> {
  return api(`/api/servers/${encodeURIComponent(id)}/cleanup`, {
    method: 'POST',
    body: {},
    schema: cleanupResponseSchema,
  });
}

const okSchema = { parse: (d: unknown): unknown => d };

export function rebootServer(id: string, confirmName: string): Promise<unknown> {
  return api(`/api/servers/${encodeURIComponent(id)}/reboot`, {
    method: 'POST',
    body: { confirmName },
    schema: okSchema,
  });
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure, unit tested)

const RANK: Record<ServerSummary['status'], number> = { crit: 0, warn: 1, ok: 2, off: 2 };

/** SPEC 5.1: crit -> warn -> name. Returns a new array. */
export function sortServers<T extends Pick<ServerSummary, 'status' | 'name'>>(list: T[]): T[] {
  return [...list].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name, 'de-AT'),
  );
}

/** Text in the ServerList where the bars would be, for crit servers. */
export function downNote(s: ServerSummary): string {
  const crit = s.reasons.filter((r) => r.level === 'crit').map((r) => r.text);
  if (crit.length) return crit.join(' · ');
  if (!s.connected && s.lastSeen) return `offline seit ${formatTime(new Date(s.lastSeen))}`;
  return 'nicht erreichbar';
}

function round(v: number | null): number | undefined {
  return v == null ? undefined : Math.round(v);
}

export function toServerInfo(s: ServerSummary): ServerInfo {
  return {
    id: s.id,
    name: s.name,
    where: s.location || '—',
    ip: s.tailscaleIp ?? undefined,
    status: s.status,
    cpu: round(s.cpu),
    ram: round(s.ramPct),
    disk: round(s.diskPct),
    uptime: s.uptimeS == null ? '—' : formatUptimeShort(s.uptimeS),
    note: s.status === 'crit' ? downNote(s) : undefined,
  };
}

export const ALL_SERVERS = 'all';

export function switchEntries(servers: ServerSummary[]): ServerEntry[] {
  return [
    { id: ALL_SERVERS, name: 'Alle Server' },
    ...sortServers(servers).map((s) => ({ id: s.id, name: s.name, status: s.status as Status })),
  ];
}

/** Statussatz: `em` is the problem part (shown in crit colour), `rest` follows it. */
export interface StatusSentence {
  em: string | null;
  rest: string;
}

/** Open problems that are not tied to a known server (checks, GitHub … later). */
export interface ProblemAlert {
  level: string;
  state: string;
  serverId: string | null;
}

function runningText(running: number, total: number): string {
  const verb = running === 1 ? 'läuft' : 'laufen';
  return `${running} von ${plural(total, 'Server', 'Servern')} ${verb}`;
}

/**
 * Status first (design/README.md, "Stimme und Text"):
 * "Alles läuft." · "1 Problem auf oracle-a1 · 4 von 4 Servern laufen" ·
 * "2 Probleme · 3 von 4 Servern laufen".
 */
export function statusSentence(
  servers: ServerSummary[],
  alerts: ProblemAlert[] = [],
): StatusSentence {
  if (servers.length === 0) return { em: null, rest: 'Noch nichts verbunden.' };
  const ids = new Set(servers.map((s) => s.id));
  const bad = servers.filter((s) => s.status === 'crit' || s.status === 'warn');
  const other = alerts.filter(
    (a) =>
      a.state === 'open' &&
      (a.level === 'crit' || a.level === 'warn') &&
      (a.serverId == null || !ids.has(a.serverId)),
  ).length;
  const running = servers.filter((s) => s.status !== 'crit' && s.status !== 'off').length;
  const problems = bad.length + other;
  const rest = runningText(running, servers.length);
  if (problems === 0) {
    return running === servers.length ? { em: null, rest: 'Alles läuft.' } : { em: null, rest };
  }
  const only = bad.length === 1 && other === 0 ? bad[0] : undefined;
  const em = only ? `1 Problem auf ${only.name}` : plural(problems, 'Problem', 'Probleme');
  return { em, rest: ` · ${rest}` };
}

/** Statussatz for a single server (ServerSwitch filter or detail page). */
export function serverSentence(s: ServerSummary): StatusSentence {
  if (s.status === 'ok') return { em: null, rest: `${s.name} läuft.` };
  if (s.status === 'off') return { em: null, rest: `${s.name} ist aus.` };
  const n = Math.max(1, s.reasons.length);
  const first = s.reasons[0]?.text;
  return {
    em: `${plural(n, 'Problem', 'Probleme')} auf ${s.name}`,
    rest: first ? ` · ${first}` : '',
  };
}

/** One-line text for document.title and screen readers. */
export function sentenceText(s: StatusSentence): string {
  return `${s.em ?? ''}${s.rest}`.trim();
}

export const CLEANUP_LABEL: Record<CleanupPreviewData['items'][number]['kind'], string> = {
  'apt-cache': 'apt-Cache',
  'old-kernels': 'Alte Kernel',
  journal: 'Journal über 200 MB',
  'docker-images': 'Ungenutzte Docker-Images',
  'docker-build-cache': 'Docker-Build-Cache',
};

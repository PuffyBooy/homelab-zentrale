import {
  alertListResponseSchema,
  alertResponseSchema,
  type Alert,
  type AlertLevel,
  type AlertSource,
} from '@hz/shared';
import { api } from './api.js';

/** Active alerts (open + acked), kept live by the `alerts` topic. */
export const alertsKey = ['alerts'] as const;
/** History incl. resolved alerts (alerts page), refetched on live updates. */
export const alertsAllKey = ['alerts', 'all'] as const;

export async function fetchAlerts(
  state: 'active' | 'all' = 'active',
  signal?: AbortSignal,
): Promise<Alert[]> {
  const res = await api(`/api/alerts?state=${state}&limit=200`, {
    schema: alertListResponseSchema,
    signal,
  });
  return res.alerts;
}

export type AlertStateFilter = 'active' | 'open' | 'acked' | 'resolved' | 'all';

export interface AlertFilter {
  state: AlertStateFilter;
  level?: AlertLevel | undefined;
  serverId?: string | undefined;
  source?: AlertSource | undefined;
}

/** Filtered list on the alerts page; under alertsAllKey so live updates refetch it. */
export const alertsFilterKey = (f: AlertFilter) =>
  [...alertsAllKey, f.state, f.level ?? '', f.serverId ?? '', f.source ?? ''] as const;

export function alertQuery(f: AlertFilter): string {
  const q = new URLSearchParams({ state: f.state, limit: '200' });
  if (f.level) q.set('level', f.level);
  if (f.serverId) q.set('serverId', f.serverId);
  if (f.source) q.set('source', f.source);
  return q.toString();
}

export async function fetchFilteredAlerts(f: AlertFilter, signal?: AbortSignal): Promise<Alert[]> {
  const res = await api(`/api/alerts?${alertQuery(f)}`, {
    schema: alertListResponseSchema,
    signal,
  });
  return res.alerts;
}

const LEVELS: readonly AlertLevel[] = ['ok', 'info', 'warn', 'crit'];
const SOURCES: readonly AlertSource[] = [
  'server',
  'container',
  'check',
  'github',
  'game',
  'ha',
  'system',
];
const STATES: readonly AlertStateFilter[] = ['active', 'open', 'acked', 'resolved', 'all'];

/** Reads the filter from the URL (?state=&level=&source=&server=). Unknown values fall back. */
export function filterFromParams(p: URLSearchParams, serverId?: string): AlertFilter {
  const state = p.get('state') as AlertStateFilter | null;
  const level = p.get('level') as AlertLevel | null;
  const source = p.get('source') as AlertSource | null;
  return {
    state: state && STATES.includes(state) ? state : 'active',
    level: level && LEVELS.includes(level) ? level : undefined,
    source: source && SOURCES.includes(source) ? source : undefined,
    serverId: serverId && /^[A-Za-z0-9_-]{1,64}$/.test(serverId) ? serverId : undefined,
  };
}

export const STATE_FILTER_LABEL: Record<AlertStateFilter, string> = {
  active: 'aktiv (offen + bestätigt)',
  open: 'offen',
  acked: 'bestätigt',
  resolved: 'erledigt',
  all: 'alle',
};

export const LEVEL_LABEL: Record<AlertLevel, string> = {
  crit: 'CRIT',
  warn: 'WARN',
  info: 'INFO',
  ok: 'OK',
};

export const SOURCE_LABEL: Record<AlertSource, string> = {
  server: 'Server',
  container: 'Container',
  check: 'Websites',
  github: 'GitHub',
  game: 'Gameserver',
  ha: 'Wohnung',
  system: 'Zentrale',
};

export const ALERT_LEVELS = LEVELS;
export const ALERT_SOURCES = SOURCES;
export const ALERT_STATES = STATES;

export async function ackAlert(id: string): Promise<Alert> {
  const res = await api(`/api/alerts/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
    body: {},
    schema: alertResponseSchema,
  });
  return res.alert;
}

export async function resolveAlert(id: string): Promise<Alert> {
  const res = await api(`/api/alerts/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    body: {},
    schema: alertResponseSchema,
  });
  return res.alert;
}

/** Newest first. */
export function sortAlerts(list: Alert[]): Alert[] {
  return [...list].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}

export function isActive(a: Alert): boolean {
  return a.state !== 'resolved';
}

/** Open crit alerts for the overview, optionally for one server. */
export function openCrit(list: Alert[], serverId?: string): Alert[] {
  return sortAlerts(
    list.filter(
      (a) =>
        a.level === 'crit' && a.state === 'open' && (serverId == null || a.serverId === serverId),
    ),
  );
}

export function openCount(list: Alert[]): number {
  return list.filter((a) => a.state === 'open').length;
}

import { alertListResponseSchema, alertResponseSchema, type Alert } from '@hz/shared';
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

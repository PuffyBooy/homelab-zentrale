import { kumaImportResponseSchema, kumaMonitorsResponseSchema, type KumaMonitor } from '@hz/shared';
import type { Status } from '@hz/ui';
import { api } from './api.js';
import { plural } from './format.js';

/** Uptime Kuma (SPEC 16, section on "Websites"): read monitors, import them as checks. */

export type KumaMonitors = ReturnType<typeof kumaMonitorsResponseSchema.parse>;
export type KumaImportResult = ReturnType<typeof kumaImportResponseSchema.parse>;

export const kumaMonitorsKey = ['uptimekuma', 'monitors'] as const;

export function fetchKumaMonitors(signal?: AbortSignal): Promise<KumaMonitors> {
  return api('/api/uptimekuma/monitors', { schema: kumaMonitorsResponseSchema, signal });
}

export function importKumaMonitors(
  names: readonly string[],
  pingFrom?: string,
): Promise<KumaImportResult> {
  return api('/api/uptimekuma/import', {
    method: 'POST',
    body: pingFrom ? { names, pingFrom } : { names },
    schema: kumaImportResponseSchema,
  });
}

export function kumaStatus(m: Pick<KumaMonitor, 'status'>): Status {
  switch (m.status) {
    case 'up':
      return 'ok';
    case 'down':
      return 'crit';
    case 'pending':
      return 'warn';
    case 'maintenance':
      return 'off';
    default:
      return 'info';
  }
}

export const KUMA_STATUS_TEXT: Record<KumaMonitor['status'], string> = {
  up: 'erreichbar',
  down: 'nicht erreichbar',
  pending: 'wird geprüft',
  maintenance: 'Wartung',
  unknown: 'unbekannt',
};

export const IMPORT_AS_LABEL: Record<NonNullable<KumaMonitor['importAs']>, string> = {
  http: 'HTTP',
  tcp: 'Port',
  ping: 'Ping',
};

const RANK: Record<KumaMonitor['status'], number> = {
  down: 0,
  pending: 1,
  unknown: 2,
  maintenance: 3,
  up: 4,
};

/** Problems first, then by name. */
export function sortMonitors(list: readonly KumaMonitor[]): KumaMonitor[] {
  return [...list].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || a.name.localeCompare(b.name, 'de'),
  );
}

/** Target shown under the name: URL, host:port or host. */
export function monitorTarget(m: Pick<KumaMonitor, 'url' | 'hostname' | 'port' | 'type'>): string {
  if (m.url) return m.url;
  if (m.hostname) return m.port ? `${m.hostname}:${m.port}` : m.hostname;
  return m.type;
}

/** Can be selected for import: a supported type and not imported yet. */
export function canImport(m: Pick<KumaMonitor, 'importAs' | 'checkId'>): boolean {
  return m.importAs !== null && m.checkId === null;
}

/** Ping checks run on an agent; without one they are skipped by the core. */
export function needsPingAgent(selected: readonly KumaMonitor[]): boolean {
  return selected.some((m) => m.importAs === 'ping');
}

/** "3 Checks angelegt · 1 übersprungen". */
export function importSummary(r: KumaImportResult): string {
  const parts = [plural(r.created, 'Check angelegt', 'Checks angelegt')];
  if (r.skipped.length) parts.push(`${r.skipped.length} übersprungen`);
  return parts.join(' · ');
}

import {
  cleanupResponseSchema,
  dockerDfResponseSchema,
  duResponseSchema,
  processesResponseSchema,
  servicesResponseSchema,
  type CleanupKind,
  type CleanupPreviewData,
  type DockerDfResponse,
  type DuResponse,
  type HistoryResponse,
  type ProcessSort,
  type ProcessesResponse,
  type ServiceOp,
  type ServiceUnitInfo,
  type ServicesResponse,
} from '@hz/shared';
import type { Status } from '@hz/ui';
import { api, isApiError } from './api.js';
import { errorText } from './errors.js';

/**
 * M16 "Server im Detail" (ROADMAP M16, SPEC 5.5): API calls for größte Ordner,
 * Docker-Belegung, Aufräumen mit Auswahl, Dienste, Prozesse and Herunterfahren,
 * plus the pure helpers the tiles use (unit tested).
 */

const base = (id: string): string => `/api/servers/${encodeURIComponent(id)}`;
const okSchema = { parse: (d: unknown): unknown => d };

export const duKey = (id: string, path: string) => ['server', id, 'du', path] as const;
export const dockerDfKey = (id: string) => ['server', id, 'docker-df'] as const;
export const servicesKey = (id: string) => ['server', id, 'services'] as const;
export const processesKey = (id: string, sort: ProcessSort) =>
  ['server', id, 'processes', sort] as const;

export function fetchDu(id: string, path: string, signal?: AbortSignal): Promise<DuResponse> {
  return api(`${base(id)}/du?path=${encodeURIComponent(path)}`, {
    schema: duResponseSchema,
    signal,
  });
}

export function fetchDockerDf(id: string, signal?: AbortSignal): Promise<DockerDfResponse> {
  return api(`${base(id)}/docker-df`, { schema: dockerDfResponseSchema, signal });
}

/** POST cleanup with the chosen items (never containers or volumes). */
export function runCleanupItems(
  id: string,
  items: readonly CleanupKind[],
): Promise<{ freedBytes: number }> {
  return api(`${base(id)}/cleanup`, {
    method: 'POST',
    body: { items: [...items] },
    schema: cleanupResponseSchema,
  });
}

export function fetchServices(id: string, signal?: AbortSignal): Promise<ServicesResponse> {
  return api(`${base(id)}/services`, { schema: servicesResponseSchema, signal });
}

export function serviceAction(id: string, unit: string, op: ServiceOp): Promise<unknown> {
  return api(`${base(id)}/services`, {
    method: 'POST',
    body: { unit, op },
    schema: okSchema,
  });
}

export function fetchProcesses(
  id: string,
  sort: ProcessSort,
  signal?: AbortSignal,
): Promise<ProcessesResponse> {
  return api(`${base(id)}/processes?sort=${sort}`, { schema: processesResponseSchema, signal });
}

/** Step-up comes from lib/api (the dialog asks for a code and the request repeats). */
export function shutdownServer(id: string, confirmName: string): Promise<unknown> {
  return api(`${base(id)}/shutdown`, {
    method: 'POST',
    body: { confirmName },
    schema: okSchema,
  });
}

// ---------------------------------------------------------------------------
// Verlauf

export type HistoryRange = HistoryResponse['range'];
export const HISTORY_RANGES: readonly HistoryRange[] = ['1h', '24h', '7d', '30d'];
export const HISTORY_RANGE_LABEL: Record<HistoryRange, string> = {
  '1h': '1 h',
  '24h': '24 h',
  '7d': '7 Tage',
  '30d': '30 Tage',
};

export interface SeriesStats {
  min: number;
  avg: number;
  max: number;
}

/** Min, Ø and Max of the known values; null without any. */
export function seriesStats(values: readonly (number | null | undefined)[]): SeriesStats | null {
  let n = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    n++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return n ? { min, avg: sum / n, max } : null;
}

/** "Min 3 % · Ø 12 % · Max 88 %" with the formatter of the row. */
export function statsText(s: SeriesStats | null, fmt: (v: number) => string): string {
  if (!s) return 'keine Werte';
  return `Min ${fmt(s.min)} · Ø ${fmt(s.avg)} · Max ${fmt(s.max)}`;
}

/** Known values only (a Sparkline needs numbers; gaps simply drop out). */
export function known(values: readonly (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => v != null && Number.isFinite(v));
}

// ---------------------------------------------------------------------------
// Größte Ordner

/** "/var" + "lib" -> "/var/lib"; "/" + "var" -> "/var". */
export function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

/** Breadcrumb of an absolute path: "/var/lib" -> [/, /var, /var/lib]. */
export function pathCrumbs(path: string): { label: string; path: string }[] {
  const out = [{ label: '/', path: '/' }];
  let acc = '';
  for (const seg of path.split('/').filter(Boolean)) {
    acc += `/${seg}`;
    out.push({ label: seg, path: acc });
  }
  return out;
}

/** Paths system.du never measures (same as DU_DENIED_ROOTS in @hz/shared). */
const DU_DENIED = ['/proc', '/sys', '/dev', '/run'];
export function duAllowed(path: string): boolean {
  return !DU_DENIED.some((r) => path === r || path.startsWith(`${r}/`));
}

/** Longest path the core accepts for system.du (hostDirPathSchema). */
export const DU_PATH_MAX = 256;

/**
 * Why a folder cannot be opened: null when it can. Checked before the request, so a
 * long or odd name never ends in a raw 400 from the core.
 */
export function duBlocked(path: string): 'too_long' | 'denied' | 'invalid' | null {
  if (path.length > DU_PATH_MAX) return 'too_long';
  if (!duAllowed(path)) return 'denied';
  const bad = [...path].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
  if (bad || path.split('/').some((seg) => seg === '.' || seg === '..')) return 'invalid';
  return null;
}

export function pctOfTotal(bytes: number, total: number): number {
  return total > 0 ? Math.min(100, (bytes / total) * 100) : 0;
}

/** German text for a failed du measurement. */
export function duErrorText(err: unknown): string {
  if (isApiError(err, 'rate_limited'))
    return 'Nur eine Messung alle 5 s. Gleich nochmal versuchen.';
  if (isApiError(err, 'invalid_input')) return 'Diesen Ordner misst die Zentrale nicht.';
  if (isApiError(err, 'agent_timeout')) {
    return 'Messung hat zu lange gedauert. Einen kleineren Unterordner wählen.';
  }
  if (isApiError(err, 'not_found')) return 'Ordner gibt es nicht (mehr).';
  if (isApiError(err, 'agent_error')) return 'Ordner nicht lesbar. Log des Agents prüfen.';
  return errorText(err);
}

// ---------------------------------------------------------------------------
// Aufräumen mit Auswahl

/** Sum of the selected preview items. */
export function selectedBytes(
  items: CleanupPreviewData['items'],
  selected: ReadonlySet<CleanupKind>,
): number {
  return items.reduce((sum, it) => sum + (selected.has(it.kind) ? it.bytes : 0), 0);
}

/** Selected kinds in preview order (stable request body). */
export function selectedKinds(
  items: CleanupPreviewData['items'],
  selected: ReadonlySet<CleanupKind>,
): CleanupKind[] {
  return items.map((it) => it.kind).filter((k) => selected.has(k));
}

// ---------------------------------------------------------------------------
// Dienste

export type UnitView = 'running' | 'all';

const unitRank = (u: ServiceUnitInfo): number =>
  u.active === 'failed' ? 0 : u.active === 'active' ? 1 : 2;

/** Failed first, then active, then the rest; by name inside each group. */
export function sortUnits(units: readonly ServiceUnitInfo[]): ServiceUnitInfo[] {
  return [...units].sort((a, b) => unitRank(a) - unitRank(b) || a.name.localeCompare(b.name));
}

/**
 * "Laufende": active units plus every failed one (problems always stay visible).
 * The filter matches name and description, case-insensitive.
 */
export function filterUnits(
  units: readonly ServiceUnitInfo[],
  view: UnitView,
  query: string,
): ServiceUnitInfo[] {
  const q = query.trim().toLowerCase();
  return sortUnits(units).filter(
    (u) =>
      (view === 'all' || u.active === 'active' || u.active === 'failed') &&
      (!q || u.name.toLowerCase().includes(q) || u.description.toLowerCase().includes(q)),
  );
}

/** Form and text: failed DOWN, active UP, (de)activating BOOT, everything else OFF. */
export function unitStatus(u: Pick<ServiceUnitInfo, 'active'>): Status {
  if (u.active === 'failed') return 'crit';
  if (u.active === 'active') return 'ok';
  if (u.active === 'activating' || u.active === 'deactivating' || u.active === 'reloading') {
    return 'busy';
  }
  return 'off';
}

/** Which buttons a unit gets. Never any for units that are not manageable. */
export function unitOps(u: Pick<ServiceUnitInfo, 'active' | 'manageable'>): ServiceOp[] {
  if (!u.manageable) return [];
  return u.active === 'active' ? ['restart', 'stop'] : ['start'];
}

export const SERVICE_OP_LABEL: Record<ServiceOp, string> = {
  start: 'Starten',
  stop: 'Stoppen',
  restart: 'Neu starten',
};

/** Accessible names: "nginx.service neu starten". */
export const SERVICE_OP_ARIA: Record<ServiceOp, string> = {
  start: 'starten',
  stop: 'stoppen',
  restart: 'neu starten',
};

/** "nginx.service neu gestartet." */
export function serviceDoneText(unit: string, op: ServiceOp): string {
  const verb = op === 'start' ? 'gestartet' : op === 'stop' ? 'gestoppt' : 'neu gestartet';
  return `${unit} ${verb}.`;
}

export const SERVICES_HINT =
  'Starten, Stoppen und Neustarten geht nur für Dienste, die am Server in HZ_AGENT_SERVICES stehen (z. B. HZ_AGENT_SERVICES=nginx.service,smbd.service). tailscaled, docker, ssh und systemd-* nie.';

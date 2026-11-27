import {
  updateComponentStateSchema,
  updateNowResponseSchema,
  updateServerStateSchema,
  updatesResponseSchema,
  type ImageVersion,
  type UpdateComponentState,
  type UpdatePolicy,
  type UpdateRun,
  type UpdateServerState,
  type UpdateTarget,
  type UpdatesResponse,
} from '@hz/shared';
import type { QueryClient } from '@tanstack/react-query';
import type { Status } from '@hz/ui';
import { api } from './api.js';
import { formatNumber, plural } from './format.js';

/** M17 Auto-Update (ROADMAP M17, SPEC 5.6). Data from GET /api/updates and the live topic `updates`. */

export const updatesKey = ['updates'] as const;

export function fetchUpdates(signal?: AbortSignal): Promise<UpdatesResponse> {
  return api('/api/updates', { schema: updatesResponseSchema, signal });
}

const base = (id: string): string => `/api/servers/${encodeURIComponent(id)}`;

/** Step-up when `reboot` turns on: lib/api asks for the code and repeats. */
export function saveUpdatePolicy(id: string, policy: UpdatePolicy): Promise<UpdateServerState> {
  return api(`${base(id)}/update-policy`, {
    method: 'PUT',
    body: policy,
    schema: updateServerStateSchema,
  });
}

export function checkUpdate(id: string, target: UpdateTarget): Promise<UpdateComponentState> {
  return api(`${base(id)}/update-check`, {
    method: 'POST',
    body: { target },
    schema: updateComponentStateSchema,
  });
}

export type UpdateNowTarget = UpdateTarget | 'os';

export function updateNow(id: string, target: UpdateNowTarget): Promise<{ runId: string }> {
  return api(`${base(id)}/update`, {
    method: 'POST',
    body: { target },
    schema: updateNowResponseSchema,
  });
}

/** Writes a changed server state into the cached list (after PUT, check). */
export function patchUpdateServer(qc: QueryClient, next: UpdateServerState): void {
  qc.setQueryData<UpdatesResponse>(updatesKey, (old) =>
    old
      ? { ...old, servers: old.servers.map((s) => (s.serverId === next.serverId ? next : s)) }
      : old,
  );
}

export function patchUpdateComponent(
  qc: QueryClient,
  serverId: string,
  target: UpdateTarget,
  state: UpdateComponentState,
): void {
  qc.setQueryData<UpdatesResponse>(updatesKey, (old) =>
    old
      ? {
          ...old,
          servers: old.servers.map((s) =>
            s.serverId === serverId ? { ...s, [target]: state } : s,
          ),
        }
      : old,
  );
}

/**
 * Live topic `updates`: the snapshot and every upsert is the full UpdatesResponse.
 * Invalid payloads refetch over REST instead of corrupting the cache.
 */
export function applyUpdatesPayload(qc: QueryClient, payload: unknown): void {
  const parsed = updatesResponseSchema.safeParse(payload);
  if (parsed.success) qc.setQueryData<UpdatesResponse>(updatesKey, parsed.data);
  else void qc.invalidateQueries({ queryKey: updatesKey, exact: true });
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure, unit tested)

/** Version text, else the short revision, else the short image id. */
export function versionText(v: ImageVersion | null | undefined): string {
  if (!v) return '—';
  if (v.version) return v.version;
  if (v.revision) return v.revision.slice(0, 7);
  return v.imageId.replace(/^sha256:/, '').slice(0, 12);
}

export function hasUpdate(c: UpdateComponentState | null | undefined): boolean {
  return !!c && c.available != null && c.upToDate === false;
}

/** "Update auf sha-5d6e7f8" · "aktuell" · "noch nicht geprüft". */
export function availableText(c: UpdateComponentState): string {
  if (c.upToDate == null) return 'noch nicht geprüft';
  if (hasUpdate(c)) return `Update auf ${versionText(c.available)}`;
  return 'aktuell';
}

export const RUN_TARGET_LABEL: Record<UpdateRun['target'], string> = {
  agent: 'Agent',
  core: 'Zentrale',
  os: 'OS-Pakete',
  reboot: 'Neustart',
};

export const RUN_STATUS: Record<UpdateRun['status'], { status: Status; label: string }> = {
  running: { status: 'busy', label: 'läuft' },
  updated: { status: 'ok', label: 'aktualisiert' },
  up_to_date: { status: 'ok', label: 'schon aktuell' },
  rolled_back: { status: 'warn', label: 'zurückgerollt' },
  failed: { status: 'crit', label: 'fehlgeschlagen' },
  timeout: { status: 'warn', label: 'keine Rückmeldung' },
};

/** "sha-1a2b3c4 → sha-5d6e7f8", "sha-1a2b3c4", "—". */
export function fromToText(run: Pick<UpdateRun, 'from' | 'to'>): string {
  if (run.from && run.to && run.from !== run.to) return `${run.from} → ${run.to}`;
  return run.to ?? run.from ?? '—';
}

/** Newest run of one server (runs are newest first). */
export function lastRunOf(runs: readonly UpdateRun[], serverId: string): UpdateRun | undefined {
  return runs.find((r) => r.serverId === serverId);
}

/**
 * One status per server: running BOOT, failed last run DOWN, rollback or timeout WARN,
 * an available update INFO, offline OFF, else UP.
 */
export function updateStatus(
  s: UpdateServerState,
  last: UpdateRun | undefined,
): { status: Status; label: string } {
  if (s.running) return { status: 'busy', label: `${RUN_TARGET_LABEL[s.running]} läuft` };
  if (last?.status === 'failed') return RUN_STATUS.failed;
  if (last?.status === 'rolled_back' || last?.status === 'timeout') return RUN_STATUS[last.status];
  if (!s.connected) return { status: 'off', label: 'offline' };
  if (hasUpdate(s.agent) || hasUpdate(s.core)) return { status: 'info', label: 'Update da' };
  return { status: 'ok', label: 'aktuell' };
}

/** ISO weekdays 1..7 with the labels of the brand book. */
export const ISO_WEEKDAYS: readonly { id: number; label: string; long: string }[] = [
  { id: 1, label: 'Mo', long: 'Montag' },
  { id: 2, label: 'Di', long: 'Dienstag' },
  { id: 3, label: 'Mi', long: 'Mittwoch' },
  { id: 4, label: 'Do', long: 'Donnerstag' },
  { id: 5, label: 'Fr', long: 'Freitag' },
  { id: 6, label: 'Sa', long: 'Samstag' },
  { id: 7, label: 'So', long: 'Sonntag' },
];

export function toggleIsoDay(days: readonly number[], day: number): number[] {
  const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
  return next.sort((a, b) => a - b);
}

/** "täglich", "Mo–Fr", "Sa, So", "Mo, Mi–Fr". */
export function isoDaysText(days: readonly number[]): string {
  if (days.length === 7) return 'täglich';
  const idx = [...new Set(days)].sort((a, b) => a - b);
  const label = (d: number): string => ISO_WEEKDAYS[d - 1]?.label ?? '';
  const parts: string[] = [];
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && (idx[j + 1] ?? 0) === (idx[j] ?? 0) + 1) j++;
    const a = idx[i] ?? 0;
    const b = idx[j] ?? 0;
    if (b - a >= 2) parts.push(`${label(a)}–${label(b)}`);
    else if (b > a) parts.push(label(a), label(b));
    else parts.push(label(a));
    i = j + 1;
  }
  return parts.join(', ');
}

/** "30 Min", "2 h", "1,5 h". */
export function durationText(min: number): string {
  return min < 60 ? `${formatNumber(min, 0)} Min` : `${formatNumber(min / 60, 1)} h`;
}

export const DURATION_OPTIONS = [30, 60, 90, 120, 180, 240, 360, 480] as const;

/** "Agent, Zentrale · täglich 03:00 für 2 h" · "aus". */
export function policySummary(p: UpdatePolicy, hostsCore: boolean): string {
  const parts = [
    p.agent ? 'Agent' : null,
    hostsCore && p.core ? 'Zentrale' : null,
    p.os ? 'OS-Pakete' : null,
    p.reboot ? 'Neustart' : null,
  ].filter((x): x is string => x !== null);
  if (!parts.length) return 'aus';
  const w = p.window;
  return `${parts.join(', ')} · ${isoDaysText(w.days)} ${w.start} für ${durationText(w.durationMin)}`;
}

/** "12 Pakete offen, 3 Sicherheit" · "keine offen" · "unbekannt". */
export function osText(os: UpdateServerState['os']): string {
  if (!os) return 'Paketstand unbekannt';
  if (os.total === 0) return 'keine Pakete offen';
  const sec = os.security ? `, ${formatNumber(os.security, 0)} Sicherheit` : '';
  return `${plural(os.total, 'Paket', 'Pakete')} offen${sec}`;
}

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** "3:00" -> "03:00"; null when invalid. */
export function parseStart(raw: string): string | null {
  const t = raw.trim();
  const v = /^\d:[0-5]\d$/.test(t) ? `0${t}` : t;
  return TIME_RE.test(v) ? v : null;
}

export const CORE_HOST_UNKNOWN_HINT =
  'Die Zentrale läuft auf keinem Server mit Agent. Aktualisieren mit sudo ./deploy/install.sh update';

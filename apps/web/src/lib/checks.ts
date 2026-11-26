import {
  checkDefSchema,
  checkHistoryResponseSchema,
  checkListResponseSchema,
  checkResponseSchema,
  okResponseSchema,
  type CheckDef,
  type CheckKind,
  type CheckSummary,
} from '@hz/shared';
import { api } from './api.js';
import { bucket } from './history.js';
import { formatNumber, plural } from './format.js';
import type { StatusSentence } from './servers.js';

export const checksKey = ['checks'] as const;
export type CheckRange = '24h' | '7d' | '30d';
export const CHECK_RANGES: readonly CheckRange[] = ['24h', '7d', '30d'];
export const checkHistoryKey = (id: string, range: CheckRange) =>
  ['checks', id, 'history', range] as const;

export type CheckHistoryPoint = {
  ts: string;
  ok: boolean;
  ms: number | null;
  code: number | null;
};

export async function fetchChecks(signal?: AbortSignal): Promise<CheckSummary[]> {
  const res = await api('/api/checks', { schema: checkListResponseSchema, signal });
  return res.checks;
}

export async function createCheck(def: CheckDef): Promise<CheckSummary> {
  const res = await api('/api/checks', { method: 'POST', body: def, schema: checkResponseSchema });
  return res.check;
}

export async function updateCheck(id: string, def: CheckDef): Promise<CheckSummary> {
  const res = await api(`/api/checks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: def,
    schema: checkResponseSchema,
  });
  return res.check;
}

export async function deleteCheck(id: string): Promise<void> {
  await api(`/api/checks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    schema: okResponseSchema,
  });
}

export async function runCheck(id: string): Promise<CheckSummary> {
  const res = await api(`/api/checks/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    body: {},
    schema: checkResponseSchema,
  });
  return res.check;
}

export async function fetchCheckHistory(
  id: string,
  range: CheckRange,
  signal?: AbortSignal,
): Promise<CheckHistoryPoint[]> {
  const res = await api(`/api/checks/${encodeURIComponent(id)}/history?range=${range}`, {
    schema: checkHistoryResponseSchema,
    signal,
  });
  return res.points;
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure, unit tested)

const RANK: Record<CheckSummary['status'], number> = { crit: 0, warn: 1, busy: 2, ok: 3, off: 4 };

/** Problems first: crit -> warn -> busy -> ok -> off, then by name. */
export function sortChecks<T extends Pick<CheckSummary, 'status' | 'def'>>(
  list: readonly T[],
): T[] {
  return [...list].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || a.def.name.localeCompare(b.def.name, 'de-AT'),
  );
}

export function isCheckProblem(c: Pick<CheckSummary, 'status'>): boolean {
  return c.status === 'crit' || c.status === 'warn';
}

/** ServerSwitch filter: the linked server or the agent the check runs from. */
export function checkMatchesServer(c: Pick<CheckSummary, 'def'>, serverId: string): boolean {
  return c.def.serverId === serverId || c.def.runFrom === serverId;
}

/** What is checked, as shown in the row: "example.at", "example.at/api", "127.0.0.1:25565". */
export function checkTarget(def: CheckDef): string {
  if (def.kind === 'tcp') return `${def.host}:${def.port}`;
  if (def.kind === 'ping') return def.host;
  try {
    const u = new URL(def.url);
    const path = u.pathname === '/' ? '' : u.pathname;
    // Never the query: it may carry a token (shown on the wall display too).
    return `${u.host}${path}`;
  } catch {
    return def.url;
  }
}

/** Code column of WebCheckRow: the HTTP code, or the kind for non-HTTP checks. */
export function checkCode(c: Pick<CheckSummary, 'def' | 'lastCode'>): string | number | undefined {
  if (c.def.kind === 'tcp') return 'TCP';
  if (c.def.kind === 'ping') return 'PING';
  return c.lastCode ?? undefined;
}

/** Whole days until `iso`, rounded down; negative once expired. */
export function daysUntil(iso: string | null, now: Date = new Date()): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Math.floor((t - now.getTime()) / 86_400_000);
}

/** "99,95 %": two decimals below 100, so a single failed minute shows. */
export function formatUptime(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 100) return '100 %';
  return `${formatNumber(Math.floor(v * 100) / 100, 2)} %`;
}

export function formatMs(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : `${formatNumber(Math.round(v), 0)} ms`;
}

/** "in 61 T", "heute", "seit 3 T abgelaufen". */
export function formatDays(days: number | undefined): string {
  if (days === undefined) return '—';
  if (days < 0) return `seit ${formatNumber(-days, 0)} T abgelaufen`;
  if (days === 0) return 'heute';
  return `in ${formatNumber(days, 0)} T`;
}

export const KIND_LABEL: Record<CheckKind, string> = {
  http: 'HTTP(S)',
  tcp: 'TCP',
  ping: 'Ping',
};

/** "Zentrale" or the server name for the runFrom value. */
export function runFromName(
  runFrom: string,
  servers: readonly { id: string; name: string }[],
): string {
  if (runFrom === 'core') return 'Zentrale';
  return servers.find((s) => s.id === runFrom)?.name ?? 'unbekannter Server';
}

/** Sub line of a row: reason first (status first), then where it runs and the uptime. */
export function checkSubline(
  c: CheckSummary,
  servers: readonly { id: string; name: string }[],
  now: Date = new Date(),
): string {
  const parts: string[] = [];
  if (!c.def.enabled) parts.push('pausiert');
  else if (c.status !== 'ok' && c.reason) parts.push(c.reason);
  if (c.def.name !== checkTarget(c.def)) parts.push(c.def.name);
  parts.push(`von ${runFromName(c.def.runFrom, servers)}`);
  parts.push(`24 h ${formatUptime(c.uptime24h)}`);
  const domain = daysUntil(c.domainExpiresAt, now);
  if (domain !== undefined && domain < 30) parts.push(`Domain ${formatDays(domain)}`);
  return parts.join(' · ');
}

/** At most this many bars in a row sparkline. */
export const ROW_SPARK_BARS = 24;

export function rowSpark(c: Pick<CheckSummary, 'spark'>): number[] {
  return bucket(c.spark, ROW_SPARK_BARS);
}

/** Statussatz for the websites page. Problems first. */
export function checksSentence(list: readonly CheckSummary[]): StatusSentence {
  if (list.length === 0) return { em: null, rest: 'Noch keine Checks.' };
  const active = list.filter((c) => c.def.enabled && c.status !== 'off');
  const crit = active.filter((c) => c.status === 'crit');
  const warn = active.filter((c) => c.status === 'warn');
  const okCount = active.filter((c) => c.status !== 'crit').length;
  const rest = `${okCount} von ${plural(active.length, 'Check', 'Checks')} erreichbar`;
  const only = crit.length === 1 && warn.length === 0 ? crit[0] : undefined;
  if (only) return { em: `${checkTarget(only.def)} ist nicht erreichbar`, rest: ` · ${rest}` };
  const problems = crit.length + warn.length;
  if (problems === 0) {
    return active.length ? { em: null, rest: 'Alles erreichbar.' } : { em: null, rest };
  }
  return { em: plural(problems, 'Problem', 'Probleme'), rest: ` · ${rest}` };
}

/** Statussatz for one check (detail page). */
export function checkSentence(c: CheckSummary): StatusSentence {
  const t = checkTarget(c.def);
  if (!c.def.enabled || c.status === 'off') return { em: null, rest: `${t} ist pausiert.` };
  if (c.status === 'crit')
    return { em: `${t} ist nicht erreichbar`, rest: c.reason ? ` · ${c.reason}` : '' };
  if (c.status === 'warn') return { em: `${t}: ${c.reason ?? 'Warnung'}`, rest: '' };
  if (c.status === 'busy' || !c.lastCheckedAt) return { em: null, rest: `${t} wird geprüft.` };
  return { em: null, rest: `${t} ist erreichbar.` };
}

export interface HistoryStats {
  /** Uptime in percent over the points, null without points. */
  uptime: number | null;
  avgMs: number | null;
  maxMs: number | null;
  failures: number;
  /** Response times, bucketed for the sparkline. */
  spark: number[];
}

export const DETAIL_SPARK_BARS = 48;

export function historyStats(points: readonly CheckHistoryPoint[]): HistoryStats {
  if (!points.length) return { uptime: null, avgMs: null, maxMs: null, failures: 0, spark: [] };
  const failures = points.filter((p) => !p.ok).length;
  const ms = points.map((p) => p.ms).filter((v): v is number => v != null);
  return {
    uptime: ((points.length - failures) / points.length) * 100,
    avgMs: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null,
    maxMs: ms.length ? Math.max(...ms) : null,
    failures,
    spark: bucket(ms, DETAIL_SPARK_BARS),
  };
}

/** Failed points as outage spans (consecutive failures merged), newest first. */
export interface Outage {
  from: string;
  to: string;
  count: number;
  code: number | null;
}

export function outages(points: readonly CheckHistoryPoint[], max = 10): Outage[] {
  const out: Outage[] = [];
  let cur: Outage | null = null;
  for (const p of points) {
    if (!p.ok) {
      if (cur) {
        cur.to = p.ts;
        cur.count++;
        cur.code = p.code ?? cur.code;
      } else cur = { from: p.ts, to: p.ts, count: 1, code: p.code };
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.reverse().slice(0, max);
}

// ---------------------------------------------------------------------------
// Form (strings in the inputs, validated with the shared zod schema)

export interface CheckForm {
  kind: CheckKind;
  name: string;
  runFrom: string;
  intervalS: string;
  enabled: boolean;
  serverId: string;
  url: string;
  expectStatusMin: string;
  expectStatusMax: string;
  contains: string;
  certCheck: boolean;
  host: string;
  port: string;
}

export type CheckFormField = keyof CheckForm;
export type CheckFormErrors = Partial<Record<CheckFormField, string>>;

export function emptyCheckForm(kind: CheckKind = 'http'): CheckForm {
  return {
    kind,
    name: '',
    runFrom: 'core',
    intervalS: '60',
    enabled: true,
    serverId: '',
    url: 'https://',
    expectStatusMin: '200',
    expectStatusMax: '399',
    contains: '',
    certCheck: true,
    host: '',
    port: '',
  };
}

export function checkToForm(def: CheckDef): CheckForm {
  const f = emptyCheckForm(def.kind);
  f.name = def.name;
  f.runFrom = def.runFrom;
  f.intervalS = String(def.intervalS);
  f.enabled = def.enabled;
  f.serverId = def.serverId ?? '';
  if (def.kind === 'http') {
    f.url = def.url;
    f.expectStatusMin = String(def.expectStatusMin);
    f.expectStatusMax = String(def.expectStatusMax);
    f.contains = def.contains ?? '';
    f.certCheck = def.certCheck;
  } else {
    f.host = def.host;
    if (def.kind === 'tcp') f.port = String(def.port);
  }
  return f;
}

/** Name proposal from the target when the name field is left empty. */
export function defaultName(f: CheckForm): string {
  if (f.kind === 'http') {
    try {
      return new URL(f.url.trim()).host;
    } catch {
      return '';
    }
  }
  if (f.kind === 'tcp') return f.port.trim() ? `${f.host.trim()}:${f.port.trim()}` : f.host.trim();
  return f.host.trim();
}

function num(s: string): number | string {
  const t = s.trim();
  return /^\d+$/.test(t) ? Number(t) : t;
}

const FIELD_TEXT: Partial<Record<CheckFormField, string>> = {
  name: 'Name fehlt oder ist länger als 80 Zeichen.',
  url: 'Gültige URL mit http:// oder https:// eintragen.',
  host: 'Hostname oder IP eintragen, ohne Leerzeichen und Schema.',
  port: 'Port zwischen 1 und 65535.',
  intervalS: 'Intervall zwischen 30 und 3600 s.',
  expectStatusMin: 'Statuscode zwischen 100 und 599.',
  expectStatusMax: 'Statuscode zwischen 100 und 599.',
  contains: 'Höchstens 200 Zeichen.',
  runFrom: 'Ping läuft über einen Agent. Server wählen.',
  serverId: 'Server ungültig.',
};

export type FormResult = { ok: true; def: CheckDef } | { ok: false; errors: CheckFormErrors };

function hasUserinfo(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}

/** Builds the request body for POST/PUT and validates it with checkDefSchema. */
export function formToDef(f: CheckForm): FormResult {
  const base = {
    name: f.name.trim() || defaultName(f),
    runFrom: f.runFrom,
    intervalS: num(f.intervalS),
    enabled: f.enabled,
    serverId: f.serverId || null,
  };
  let raw: Record<string, unknown>;
  if (f.kind === 'http') {
    raw = {
      kind: 'http',
      ...base,
      url: f.url.trim(),
      expectStatusMin: num(f.expectStatusMin),
      expectStatusMax: num(f.expectStatusMax),
      certCheck: f.certCheck,
      ...(f.contains.trim() ? { contains: f.contains.trim() } : {}),
    };
  } else if (f.kind === 'tcp') {
    raw = { kind: 'tcp', ...base, host: f.host.trim(), port: num(f.port) };
  } else {
    raw = { kind: 'ping', ...base, host: f.host.trim() };
  }
  if (f.kind === 'http' && hasUserinfo(f.url.trim())) {
    // Credentials in the URL would end up in the DB and in logs; the core rejects them.
    return { ok: false, errors: { url: 'URL ohne Benutzer und Passwort eintragen.' } };
  }
  const parsed = checkDefSchema.safeParse(raw);
  const errors: CheckFormErrors = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key !== 'string') continue;
      const text = FIELD_TEXT[key as CheckFormField];
      if (text && !errors[key as CheckFormField]) errors[key as CheckFormField] = text;
    }
    if (!Object.keys(errors).length) errors.name = 'Eingabe ungültig. Felder prüfen.';
    return { ok: false, errors };
  }
  const def = parsed.data;
  if (def.kind === 'http' && def.expectStatusMin > def.expectStatusMax) {
    return { ok: false, errors: { expectStatusMax: 'Bis-Wert muss mindestens Von-Wert sein.' } };
  }
  return { ok: true, def };
}

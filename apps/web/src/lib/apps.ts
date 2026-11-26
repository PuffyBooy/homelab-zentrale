import {
  APP_CATEGORIES,
  APP_CATEGORY_LABELS,
  APP_COMPOSE_MAX_BYTES,
  appIdSchema,
  appPreviewResponseSchema,
  appSecretsResponseSchema,
  appTemplateDetailSchema,
  appTemplateMetaSchema,
  appTemplatesResponseSchema,
  appsResponseSchema,
  installedAppSchema,
  type AppBind,
  type AppCategory,
  type AppInstallRequest,
  type AppParam,
  type AppPreviewResponse,
  type AppStatus,
  type AppTemplateCustomRequest,
  type AppTemplateDetail,
  type AppTemplateMeta,
  type AppTemplateSummary,
  type InstalledApp,
  type ServerSummary,
} from '@hz/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Status } from '@hz/ui';
import { api, isApiError } from './api.js';
import { formatBytes, plural } from './format.js';
import { dockerArch } from './gameFeatures.js';

/** M21 "App-Store und Stack-Vorlagen" (packages/shared/src/api/apps.ts). */

export { APP_CATEGORIES, APP_CATEGORY_LABELS };
export type { AppTemplateDetail, AppTemplateSummary, InstalledApp };

export const appTemplatesKey = ['apps', 'templates'] as const;
export const appTemplateKey = (id: string) => ['apps', 'templates', id] as const;
export const appsKey = ['apps', 'installed'] as const;

const enc = encodeURIComponent;
const noBody = { parse: (d: unknown): unknown => d };
type Out<S> = S extends { parse(data: unknown): infer T } ? T : never;
export type AppSecrets = Out<typeof appSecretsResponseSchema>;
export type AppAction = 'start' | 'stop' | 'restart' | 'update';

export async function fetchAppTemplates(signal?: AbortSignal): Promise<AppTemplateSummary[]> {
  const res = await api('/api/apps/templates', { schema: appTemplatesResponseSchema, signal });
  return res.templates;
}

export function fetchAppTemplate(id: string, signal?: AbortSignal): Promise<AppTemplateDetail> {
  return api(`/api/apps/templates/${enc(id)}`, { schema: appTemplateDetailSchema, signal });
}

export function createAppTemplate(body: AppTemplateCustomRequest): Promise<AppTemplateDetail> {
  return api('/api/apps/templates', { method: 'POST', body, schema: appTemplateDetailSchema });
}

export function updateAppTemplate(
  id: string,
  body: AppTemplateCustomRequest,
): Promise<AppTemplateDetail> {
  return api(`/api/apps/templates/${enc(id)}`, {
    method: 'PUT',
    body,
    schema: appTemplateDetailSchema,
  });
}

export async function deleteAppTemplate(id: string): Promise<void> {
  await api(`/api/apps/templates/${enc(id)}`, { method: 'DELETE', schema: noBody });
}

export function previewApp(body: AppInstallRequest): Promise<AppPreviewResponse> {
  return api(`/api/apps/templates/${enc(body.templateId)}/preview`, {
    method: 'POST',
    body,
    schema: appPreviewResponseSchema,
  });
}

export async function fetchApps(signal?: AbortSignal): Promise<InstalledApp[]> {
  const res = await api('/api/apps', { schema: appsResponseSchema, signal });
  return res.apps;
}

/** 202: the app is `installing`. */
export function installApp(body: AppInstallRequest): Promise<InstalledApp> {
  return api('/api/apps', { method: 'POST', body, schema: installedAppSchema });
}

export function appAction(id: string, action: AppAction): Promise<InstalledApp> {
  return api(`/api/apps/${enc(id)}/${action}`, {
    method: 'POST',
    body: {},
    schema: installedAppSchema,
  });
}

/** Step-up. */
export function fetchAppSecrets(id: string): Promise<AppSecrets> {
  return api(`/api/apps/${enc(id)}/secrets`, { schema: appSecretsResponseSchema });
}

/** Step-up and the appId typed again. */
export async function removeApp(
  id: string,
  confirmName: string,
  deleteData: boolean,
): Promise<void> {
  await api(`/api/apps/${enc(id)}`, {
    method: 'DELETE',
    body: { confirmName, deleteData },
    schema: noBody,
  });
}

// ---------------------------------------------------------------------------
// Errors

/**
 * Text for app errors. An unsafe template is 400 invalid_input with the problems in
 * `message` (errorText shows it); the full list comes from the preview route.
 */
export function appErrorText(err: unknown, fallback: (e: unknown) => string): string {
  if (isApiError(err, 'exists')) return 'Kennung schon vergeben.';
  if (isApiError(err, 'in_use')) return 'Vorlage ist noch installiert. Zuerst die Apps entfernen.';
  if (isApiError(err, 'confirm_mismatch')) return 'Name stimmt nicht.';
  if (isApiError(err, 'forbidden')) return 'Abgelehnt: Container der Zentrale (hz.role) sind tabu.';
  return fallback(err);
}

// ---------------------------------------------------------------------------
// Texts (pure, unit tested)

export const APP_STATUS: Record<AppStatus, Status> = {
  installing: 'busy',
  running: 'ok',
  stopped: 'off',
  updating: 'busy',
  error: 'crit',
  removing: 'busy',
};

export const APP_STATUS_TEXT: Record<AppStatus, string> = {
  installing: 'wird installiert',
  running: 'läuft',
  stopped: 'gestoppt',
  updating: 'wird aktualisiert',
  error: 'Fehler',
  removing: 'wird entfernt',
};

/** Running but a container is unhealthy or not running: warn. */
export function appStatus(a: Pick<InstalledApp, 'status' | 'containers'>): Status {
  const base = APP_STATUS[a.status];
  if (a.status !== 'running') return base;
  const bad = a.containers.some((c) => c.state !== 'running' || c.health === 'unhealthy');
  return bad ? 'warn' : 'ok';
}

export function appStatusText(a: Pick<InstalledApp, 'status' | 'containers'>): string {
  if (a.status === 'running' && appStatus(a) === 'warn') {
    const bad = a.containers.filter((c) => c.state !== 'running' || c.health === 'unhealthy');
    return `läuft · ${plural(bad.length, 'Container', 'Container')} mit Problem`;
  }
  return APP_STATUS_TEXT[a.status];
}

export const BIND_OPTIONS: readonly { value: AppBind; label: string }[] = [
  { value: 'tailnet', label: 'Nur Tailnet (Standard)' },
  { value: 'localhost', label: 'Nur dieser Server (127.0.0.1, für Reverse Proxy)' },
  { value: 'all', label: 'Alle Netze (0.0.0.0, LAN und Internet)' },
];

export const BIND_SHORT: Record<AppBind, string> = {
  tailnet: 'Tailnet',
  localhost: '127.0.0.1',
  all: '0.0.0.0',
};

/** "8096/tcp Web, 7359/udp Suche". */
export function portsText(ports: InstalledApp['ports']): string {
  if (ports.length === 0) return 'keine Ports';
  return ports.map((p) => `${p.port}/${p.protocol}${p.label ? ` ${p.label}` : ''}`).join(', ');
}

/** "amd64, arm64 · ab 512 MB RAM". */
export function templateMeta(t: Pick<AppTemplateSummary, 'arch' | 'minRamMb' | 'version'>): string {
  return `${t.version ? `${t.version} · ` : ''}${t.arch.join(', ')} · ab ${formatBytes(t.minRamMb * 1024 * 1024)} RAM`;
}

/** Search over name, id, description and category; grouped in the fixed category order. */
export function groupTemplates(
  list: readonly AppTemplateSummary[],
  query: string,
): { category: AppCategory; label: string; templates: AppTemplateSummary[] }[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = list.filter((t) => {
    const hay =
      `${t.name} ${t.id} ${t.description} ${APP_CATEGORY_LABELS[t.category]}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return APP_CATEGORIES.map((category) => ({
    category,
    label: APP_CATEGORY_LABELS[category],
    templates: hits
      .filter((t) => t.category === category)
      .sort((a, b) => a.name.localeCompare(b.name, 'de')),
  })).filter((g) => g.templates.length > 0);
}

/** Statussatz of the apps page. */
export function appsSentence(apps: readonly InstalledApp[] | undefined): {
  em: string | null;
  rest: string;
} {
  if (!apps) return { em: null, rest: 'Apps' };
  if (apps.length === 0) return { em: null, rest: 'Noch keine Apps installiert.' };
  const bad = apps.filter((a) => appStatus(a) === 'crit' || appStatus(a) === 'warn');
  const running = apps.filter((a) => a.status === 'running').length;
  const rest = `${running} von ${plural(apps.length, 'App', 'Apps')} laufen`;
  const one = bad.length === 1 ? bad[0] : undefined;
  if (one)
    return { em: `${one.name} auf ${one.serverName}: ${appStatusText(one)}`, rest: ` · ${rest}` };
  if (bad.length) return { em: plural(bad.length, 'Problem', 'Probleme'), rest: ` · ${rest}` };
  return { em: null, rest: `${rest}.` };
}

/** Problems first, then by name. */
export function sortApps(apps: readonly InstalledApp[]): InstalledApp[] {
  const rank = (a: InstalledApp): number => {
    const s = appStatus(a);
    return s === 'crit' ? 0 : s === 'warn' ? 1 : s === 'busy' ? 2 : 3;
  };
  return [...apps].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'de'));
}

/** Server option for a template: wrong architecture or offline cannot be chosen. */
export function serverChoice(
  s: Pick<ServerSummary, 'id' | 'name' | 'arch' | 'connected'>,
  tpl: Pick<AppTemplateMeta, 'arch'>,
): { value: string; label: string; disabled: boolean } {
  const arch = dockerArch(s.arch);
  if (arch && !tpl.arch.includes(arch)) {
    return { value: s.id, label: `${s.name} · läuft nicht auf ${arch}`, disabled: true };
  }
  if (!s.connected) return { value: s.id, label: `${s.name} · offline`, disabled: true };
  return { value: s.id, label: arch ? `${s.name} · ${arch}` : s.name, disabled: false };
}

/** "jellyfin", or "jellyfin-2" when that folder is taken on the server. */
export function suggestAppId(
  templateId: string,
  serverId: string,
  apps: readonly Pick<InstalledApp, 'appId' | 'serverId'>[],
): string {
  const taken = new Set(apps.filter((a) => a.serverId === serverId).map((a) => a.appId));
  const base = templateId.slice(0, 29);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const id = `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Install form

export type ParamValue = string | boolean;

export interface InstallDraft {
  serverId: string;
  appId: string;
  name: string;
  bind: AppBind;
  params: Record<string, ParamValue>;
}

export type InstallErrors = Partial<Record<'serverId' | 'appId' | 'name', string>> & {
  params?: Record<string, string>;
};

/** Defaults of the template as form values. Passwords start empty (generated). */
export function paramDefaults(params: readonly AppParam[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const p of params) {
    switch (p.type) {
      case 'bool':
        out[p.key] = p.default;
        break;
      case 'password':
        out[p.key] = '';
        break;
      case 'string':
        out[p.key] = p.default ?? '';
        break;
      default:
        out[p.key] = String(p.default);
    }
  }
  return out;
}

const BAD_CHARS = /[\r\n\0$]/;

function anchored(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    return null;
  }
}

/** Checks one value; returns the German error or null and the value to send (undefined = omit). */
export function checkParam(
  p: AppParam,
  raw: ParamValue | undefined,
): { error: string | null; value?: string | number | boolean } {
  if (p.type === 'bool') return { error: null, value: raw === true };
  const v = typeof raw === 'string' ? raw : '';
  if (BAD_CHARS.test(v)) return { error: 'Ohne $ und ohne Zeilenumbruch.' };
  switch (p.type) {
    case 'string': {
      if (!v) return p.required ? { error: 'Pflichtfeld.' } : { error: null };
      if (v.length > 200) return { error: 'Höchstens 200 Zeichen.' };
      if (p.pattern) {
        const re = anchored(p.pattern);
        if (re && !re.test(v)) return { error: 'Format passt nicht.' };
      }
      return { error: null, value: v };
    }
    case 'password':
      if (!v) return p.generate ? { error: null } : { error: `Mindestens ${p.minLength} Zeichen.` };
      if (v.length < p.minLength) return { error: `Mindestens ${p.minLength} Zeichen.` };
      if (v.length > 200) return { error: 'Höchstens 200 Zeichen.' };
      return { error: null, value: v };
    case 'port': {
      const n = Number(v.trim());
      if (!Number.isInteger(n) || n < 1024 || n > 65535) return { error: '1024 bis 65535' };
      return { error: null, value: n };
    }
    case 'number': {
      const n = Number(v.trim());
      if (!v.trim() || !Number.isInteger(n) || n < p.min || n > p.max) {
        return { error: `${p.min} bis ${p.max}` };
      }
      return { error: null, value: n };
    }
    case 'select':
      if (!p.options.some((o) => o.value === v)) return { error: 'Auswahl treffen.' };
      return { error: null, value: v };
  }
}

export function draftToInstall(
  d: InstallDraft,
  tpl: Pick<AppTemplateDetail, 'meta'>,
): { ok: true; body: AppInstallRequest } | { ok: false; errors: InstallErrors } {
  const errors: InstallErrors = {};
  if (!d.serverId) errors.serverId = 'Server wählen.';
  if (!appIdSchema.safeParse(d.appId).success) {
    errors.appId = 'Kleinbuchstaben, Ziffern und -, 2 bis 32 Zeichen, z. B. jellyfin';
  }
  const name = d.name.trim();
  if (!name || name.length > 60) errors.name = '1 bis 60 Zeichen.';
  const params: Record<string, string | number | boolean> = {};
  const paramErrors: Record<string, string> = {};
  for (const p of tpl.meta.params) {
    const r = checkParam(p, d.params[p.key]);
    if (r.error) paramErrors[p.key] = r.error;
    else if (r.value !== undefined) params[p.key] = r.value;
  }
  if (Object.keys(paramErrors).length) errors.params = paramErrors;
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      templateId: tpl.meta.id,
      serverId: d.serverId,
      appId: d.appId,
      name,
      bind: d.bind,
      params,
    },
  };
}

// ---------------------------------------------------------------------------
// Own templates (editor)

export interface TemplateDraft {
  id: string;
  name: string;
  description: string;
  category: AppCategory;
  version: string;
  website: string;
  amd64: boolean;
  arm64: boolean;
  minRamMb: string;
  /** One hint per line. */
  hints: string;
  /** JSON array of parameters. */
  params: string;
  compose: string;
}

export const EXAMPLE_PARAMS = `[
  { "type": "port", "key": "WEB_PORT", "label": "Web-Port", "default": 8080, "web": true }
]`;

export const EXAMPLE_COMPOSE = `services:
  web:
    image: nginx:1.27.3
    container_name: \${APP_ID}
    restart: unless-stopped
    ports:
      - "\${BIND}:\${WEB_PORT}:80"
    volumes:
      - ./data/html:/usr/share/nginx/html:ro
`;

export function emptyTemplateDraft(): TemplateDraft {
  return {
    id: '',
    name: '',
    description: '',
    category: 'werkzeuge',
    version: '',
    website: '',
    amd64: true,
    arm64: true,
    minRamMb: '128',
    hints: '',
    params: EXAMPLE_PARAMS,
    compose: EXAMPLE_COMPOSE,
  };
}

export function templateToDraft(t: AppTemplateDetail): TemplateDraft {
  const m = t.meta;
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    category: m.category,
    version: m.version,
    website: m.website ?? '',
    amd64: m.arch.includes('amd64'),
    arm64: m.arch.includes('arm64'),
    minRamMb: String(m.minRamMb),
    hints: m.hints.join('\n'),
    params: JSON.stringify(m.params, null, 2),
    compose: t.compose,
  };
}

export type TemplateField = keyof Omit<TemplateDraft, 'amd64' | 'arm64'> | 'arch';
export type TemplateErrors = Partial<Record<TemplateField, string>>;

const FIELD_TEXT: Partial<Record<TemplateField, string>> = {
  id: 'Kleinbuchstaben, Ziffern und -, 2 bis 40 Zeichen.',
  name: '1 bis 40 Zeichen.',
  description: '1 bis 300 Zeichen.',
  version: 'Höchstens 40 Zeichen.',
  website: 'https-Adresse, höchstens 200 Zeichen.',
  arch: 'Mindestens eine Architektur.',
  minRamMb: '16 bis 65536 MB.',
  hints: 'Höchstens 6 Zeilen mit je 300 Zeichen.',
  params: 'Parameter ungültig.',
};

const PARAM_TYPES_TEXT = 'string, password, port, number, select oder bool';

function paramIssue(path: readonly PropertyKey[], message: string, list: unknown): string {
  const i = typeof path[1] === 'number' ? path[1] : undefined;
  if (i === undefined) {
    if (message.includes('duplicate')) return 'Jeder Schlüssel nur einmal.';
    if (message.includes('web port')) return 'Höchstens ein Port mit "web": true.';
    return 'Höchstens 30 Parameter als JSON-Liste.';
  }
  const item = Array.isArray(list) ? (list[i] as { key?: unknown } | undefined) : undefined;
  const key = typeof item?.key === 'string' ? ` (${item.key})` : '';
  const field = typeof path[2] === 'string' ? path[2] : undefined;
  const what =
    field === 'key'
      ? 'Schlüssel in GROSSBUCHSTABEN, nicht APP_ID, APP_DIR, BIND, TZ, PUID, PGID'
      : field === 'type' || field === undefined
        ? `Typ ist ${PARAM_TYPES_TEXT}`
        : `Feld „${field}“ prüfen`;
  return `Parameter ${i + 1}${key}: ${what}.`;
}

/** Validates the editor like the core does for the meta part; compose is checked by the core. */
export function draftToTemplate(
  d: TemplateDraft,
): { ok: true; body: AppTemplateCustomRequest } | { ok: false; errors: TemplateErrors } {
  const errors: TemplateErrors = {};
  let params: unknown;
  try {
    params = JSON.parse(d.params || '[]');
  } catch {
    errors.params = 'Kein gültiges JSON. Beispiel siehe Hinweis.';
  }
  const ram = Number(d.minRamMb.trim());
  const hints = d.hints
    .split('\n')
    .map((h) => h.trim())
    .filter(Boolean);
  const arch = [...(d.amd64 ? ['amd64' as const] : []), ...(d.arm64 ? ['arm64' as const] : [])];
  const meta = {
    id: d.id.trim(),
    name: d.name.trim(),
    description: d.description.trim(),
    category: d.category,
    version: d.version.trim(),
    ...(d.website.trim() ? { website: d.website.trim() } : {}),
    arch,
    minRamMb: Number.isInteger(ram) ? ram : -1,
    params: Array.isArray(params) ? params : [],
    hints,
  };
  const res = appTemplateMetaSchema.safeParse(meta);
  if (!res.success) {
    for (const issue of res.error.issues) {
      const top = issue.path[0];
      const field: TemplateField | undefined =
        top === undefined
          ? 'params'
          : typeof top === 'string' && top in FIELD_TEXT
            ? (top as TemplateField)
            : undefined;
      if (!field || errors[field]) continue;
      errors[field] =
        field === 'params'
          ? paramIssue(issue.path, issue.message, params)
          : (FIELD_TEXT[field] ?? 'Eingabe prüfen.');
    }
  }
  if (!errors.params && params !== undefined && !Array.isArray(params)) {
    errors.params = 'Parameter als JSON-Liste [ … ].';
  }
  const bytes = new TextEncoder().encode(d.compose).length;
  if (!d.compose.trim()) errors.compose = 'compose.yml eintragen.';
  else if (bytes > APP_COMPOSE_MAX_BYTES) errors.compose = 'Höchstens 64 KB.';
  if (Object.keys(errors).length || !res.success) {
    return {
      ok: false,
      errors: Object.keys(errors).length ? errors : { params: 'Eingabe prüfen.' },
    };
  }
  return { ok: true, body: { meta: res.data, compose: d.compose } };
}

/** Installed apps; polled faster while one installs, updates or is removed. */
export function useApps(enabled = true): UseQueryResult<InstalledApp[]> {
  return useQuery({
    queryKey: appsKey,
    queryFn: ({ signal }) => fetchApps(signal),
    enabled,
    refetchInterval: (q) =>
      q.state.data?.some((a) => APP_STATUS[a.status] === 'busy') ? 3_000 : 30_000,
  });
}

export function useAppTemplates(enabled = true): UseQueryResult<AppTemplateSummary[]> {
  return useQuery({
    queryKey: appTemplatesKey,
    queryFn: ({ signal }) => fetchAppTemplates(signal),
    enabled,
    staleTime: 60_000,
  });
}

import {
  errorResponseSchema,
  okResponseSchema,
  serverUpdateResponseSchema,
  thresholdsSchema,
  totpStartResponseSchema,
  type ServerDetail,
  type SetupStartResponse,
  type ServerUpdateRequest,
  type Thresholds,
} from '@hz/shared';
import { api, ApiError, requestStepUp } from './api.js';

/** Settings (SPEC 13) calls that are not owned by another area. */

const enc = encodeURIComponent;

export function changePassword(currentPassword: string, newPassword: string): Promise<unknown> {
  return api('/api/auth/password', {
    method: 'POST',
    body: { currentPassword, newPassword },
    schema: okResponseSchema,
  });
}

export function updateServer(id: string, body: ServerUpdateRequest): Promise<ServerDetail> {
  return api(`/api/servers/${enc(id)}`, {
    method: 'PATCH',
    body,
    schema: serverUpdateResponseSchema,
  });
}

export async function revokeAgent(id: string): Promise<void> {
  await api(`/api/servers/${enc(id)}/revoke-agent`, {
    method: 'POST',
    body: {},
    schema: okResponseSchema,
  });
}

export async function deleteServer(id: string): Promise<void> {
  await api(`/api/servers/${enc(id)}`, { method: 'DELETE', schema: okResponseSchema });
}

// ---- thresholds form ----------------------------------------------------------------

export type ThresholdKey = keyof Thresholds;

export interface ThresholdField {
  key: ThresholdKey;
  label: string;
  unit: '%' | '°C' | 'Min' | 's';
  min: number;
  max: number;
}

export const THRESHOLD_FIELDS: readonly ThresholdField[] = [
  { key: 'cpuWarn', label: 'CPU Warnung ab', unit: '%', min: 1, max: 100 },
  { key: 'cpuWarnMinutes', label: 'CPU Warnung nach', unit: 'Min', min: 1, max: 120 },
  { key: 'ramWarn', label: 'RAM Warnung ab', unit: '%', min: 1, max: 100 },
  { key: 'ramCrit', label: 'RAM kritisch ab', unit: '%', min: 1, max: 100 },
  { key: 'ramCritMinutes', label: 'RAM kritisch nach', unit: 'Min', min: 1, max: 120 },
  { key: 'diskWarn', label: 'Disk Warnung ab', unit: '%', min: 1, max: 100 },
  { key: 'diskCrit', label: 'Disk kritisch ab', unit: '%', min: 1, max: 100 },
  { key: 'tempWarn', label: 'Temperatur Warnung ab', unit: '°C', min: 20, max: 120 },
  { key: 'offlineAfterS', label: 'DOWN ohne Meldung nach', unit: 's', min: 30, max: 600 },
];

export type ThresholdDraft = Record<ThresholdKey, string>;

export function thresholdDraft(t: Thresholds): ThresholdDraft {
  const out = {} as ThresholdDraft;
  for (const f of THRESHOLD_FIELDS) out[f.key] = String(t[f.key]).replace('.', ',');
  return out;
}

/** Parses the form (comma as decimal sign). Returns errors per field or the values. */
export function parseThresholds(
  draft: ThresholdDraft,
): { ok: true; value: Thresholds } | { ok: false; errors: Partial<Record<ThresholdKey, string>> } {
  const errors: Partial<Record<ThresholdKey, string>> = {};
  const raw: Partial<Record<ThresholdKey, number>> = {};
  for (const f of THRESHOLD_FIELDS) {
    const text = draft[f.key].trim().replace(',', '.');
    const n = Number(text);
    const whole = f.unit === 'Min' || f.unit === 's';
    if (!text || !Number.isFinite(n) || (whole && !Number.isInteger(n))) {
      errors[f.key] = whole ? 'Ganze Zahl eingeben.' : 'Zahl eingeben.';
    } else if (n < f.min || n > f.max) {
      errors[f.key] = `Erlaubt: ${f.min} bis ${f.max} ${f.unit}.`;
    } else raw[f.key] = n;
  }
  if (raw.ramWarn !== undefined && raw.ramCrit !== undefined && raw.ramWarn > raw.ramCrit) {
    errors.ramWarn = 'Warnung muss unter kritisch liegen.';
  }
  if (raw.diskWarn !== undefined && raw.diskCrit !== undefined && raw.diskWarn > raw.diskCrit) {
    errors.diskWarn = 'Warnung muss unter kritisch liegen.';
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: thresholdsSchema.parse(raw) };
}

/** Only the keys that changed (PATCH sends nothing else). */
export function changedThresholds(before: Thresholds, after: Thresholds): Partial<Thresholds> {
  const out: Partial<Thresholds> = {};
  for (const f of THRESHOLD_FIELDS) {
    if (before[f.key] !== after[f.key]) out[f.key] = after[f.key];
  }
  return out;
}

// ---- backup of the hub (POST /api/settings/export) ----------------------------------

/** "homelab-zentrale-20261126-2304.sqlite" from Content-Disposition, else a safe default. */
export function exportFileName(header: string | null, now: Date = new Date()): string {
  const m = header ? /filename="?([A-Za-z0-9._-]+)"?(?:;|$)/.exec(header) : null;
  const name = m?.[1];
  if (name && /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9]+)*$/.test(name)) return name;
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `homelab-zentrale-${stamp}.sqlite`;
}

async function errorOf(res: Response): Promise<ApiError> {
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  const parsed = errorResponseSchema.safeParse(data);
  return new ApiError(
    res.status,
    parsed.success ? parsed.data.error : 'internal',
    parsed.success ? parsed.data.retryAfter : undefined,
    parsed.success ? parsed.data.message : undefined,
  );
}

/** Downloads the SQLite snapshot. Asks for step-up once if needed. */
export async function exportDatabase(retried = false): Promise<{ name: string; bytes: number }> {
  let res: Response;
  try {
    res = await fetch('/api/settings/export', {
      method: 'POST',
      headers: { Accept: 'application/octet-stream', 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (!res.ok) {
    const err = await errorOf(res);
    if (err.error === 'step_up_required' && !retried && (await requestStepUp())) {
      return exportDatabase(true);
    }
    throw err;
  }
  const blob = await res.blob();
  const name = exportFileName(res.headers.get('Content-Disposition'));
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { name, bytes: blob.size };
}

// ---- TOTP re-setup (both step-up) ----------------------------------------------------

export function startTotpSetup(): Promise<SetupStartResponse> {
  return api('/api/auth/totp/start', {
    method: 'POST',
    body: {},
    schema: totpStartResponseSchema,
  });
}

export function confirmTotpSetup(code: string): Promise<unknown> {
  return api('/api/auth/totp/confirm', {
    method: 'POST',
    body: { code },
    schema: okResponseSchema,
  });
}

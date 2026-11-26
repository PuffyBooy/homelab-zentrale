import {
  SELFHEAL_MODE_LABELS,
  selfhealResponseSchema,
  selfhealRuleSchema,
  selfhealSettingsSchema,
  type SelfhealEvent,
  type SelfhealMode,
  type SelfhealPhase,
  type SelfhealReason,
  type SelfhealResponse,
  type SelfhealRule,
  type SelfhealRuleRequest,
  type SelfhealSettings,
  type SelfhealState,
} from '@hz/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Status } from '@hz/ui';
import { api } from './api.js';
import { formatNumber, plural } from './format.js';

/** M20 "Selbstheilung" (packages/shared/src/api/selfheal.ts). */

export { SELFHEAL_MODE_LABELS };
export type { SelfhealEvent, SelfhealResponse, SelfhealRule, SelfhealSettings, SelfhealState };

export const selfhealKey = ['selfheal'] as const;

const enc = encodeURIComponent;
const noBody = { parse: (d: unknown): unknown => d };

export function fetchSelfheal(signal?: AbortSignal): Promise<SelfhealResponse> {
  return api('/api/selfheal', { schema: selfhealResponseSchema, signal });
}

export function saveSelfhealSettings(body: SelfhealSettings): Promise<SelfhealSettings> {
  return api('/api/selfheal/settings', { method: 'PUT', body, schema: selfhealSettingsSchema });
}

export function saveSelfhealRule(
  serverId: string,
  container: string,
  body: SelfhealRuleRequest,
): Promise<SelfhealRule> {
  return api(`/api/selfheal/rules/${enc(serverId)}/${enc(container)}`, {
    method: 'PUT',
    body,
    schema: selfhealRuleSchema,
  });
}

/** Back to the default mode. */
export async function deleteSelfhealRule(serverId: string, container: string): Promise<void> {
  await api(`/api/selfheal/rules/${enc(serverId)}/${enc(container)}`, {
    method: 'DELETE',
    schema: noBody,
  });
}

/** gave_up -> watching. */
export async function resetSelfheal(serverId: string, container: string): Promise<void> {
  await api(`/api/selfheal/reset/${enc(serverId)}/${enc(container)}`, {
    method: 'POST',
    body: {},
    schema: noBody,
  });
}

// ---------------------------------------------------------------------------
// Texts (pure, unit tested)

export const SELFHEAL_MODES: readonly SelfhealMode[] = ['off', 'unhealthy', 'unhealthy_or_exited'];

export const PHASE_STATUS: Record<SelfhealPhase, Status> = {
  watching: 'warn',
  restarting: 'busy',
  gave_up: 'crit',
};

export const PHASE_TEXT: Record<SelfhealPhase, string> = {
  watching: 'beobachtet',
  restarting: 'startet neu',
  gave_up: 'aufgegeben',
};

export const REASON_TEXT: Record<SelfhealReason, string> = {
  unhealthy: 'unhealthy',
  exited: 'abgestürzt',
  check_down: 'Website DOWN',
};

export const EVENT_TEXT: Record<SelfhealEvent['action'], string> = {
  restart: 'neu gestartet',
  restart_failed: 'Neustart fehlgeschlagen',
  gave_up: 'aufgegeben',
  recovered: 'wieder gesund',
  reset: 'zurückgesetzt',
};

export const EVENT_STATUS: Record<SelfhealEvent['action'], Status> = {
  restart: 'info',
  restart_failed: 'warn',
  gave_up: 'crit',
  recovered: 'ok',
  reset: 'off',
};

/** "2 von 3 Neustarts in 30 Min". */
export function attemptsText(
  attempts: number,
  s: Pick<SelfhealSettings, 'maxRestarts' | 'windowMinutes'>,
): string {
  return `${formatNumber(attempts, 0)} von ${plural(s.maxRestarts, 'Neustart', 'Neustarts')} in ${formatNumber(s.windowMinutes, 0)} Min`;
}

/** "heimserver · nextcloud: neu gestartet (unhealthy) · Versuch 2". */
export function eventText(e: SelfhealEvent): string {
  const why = e.action === 'reset' || e.action === 'recovered' ? '' : ` (${REASON_TEXT[e.reason]})`;
  const attempt =
    e.action === 'restart' || e.action === 'restart_failed' ? ` · Versuch ${e.attempt}` : '';
  return `${EVENT_TEXT[e.action]}${why}${attempt}`;
}

/** Problems first: aufgegeben, then restarting, then watching. */
export function sortStates(list: readonly SelfhealState[]): SelfhealState[] {
  const rank: Record<SelfhealPhase, number> = { gave_up: 0, restarting: 1, watching: 2 };
  return [...list].sort(
    (a, b) =>
      rank[a.phase] - rank[b.phase] ||
      a.serverName.localeCompare(b.serverName, 'de') ||
      a.container.localeCompare(b.container, 'de'),
  );
}

/** Statussatz of the section. */
export function selfhealSentence(r: Pick<SelfhealResponse, 'state'>): {
  em: string | null;
  rest: string;
} {
  const gaveUp = r.state.filter((s) => s.phase === 'gave_up');
  const one = gaveUp.length === 1 ? gaveUp[0] : undefined;
  if (one) return { em: `${one.container} auf ${one.serverName} aufgegeben`, rest: '' };
  if (gaveUp.length)
    return { em: `${plural(gaveUp.length, 'Container', 'Container')} aufgegeben`, rest: '' };
  const busy = r.state.filter((s) => s.phase === 'restarting').length;
  if (busy)
    return { em: null, rest: `${plural(busy, 'Container startet', 'Container starten')} neu.` };
  return { em: null, rest: 'Selbstheilung wacht.' };
}

// ---------------------------------------------------------------------------
// Settings form

export type SettingsField = Exclude<keyof SelfhealSettings, 'defaultMode'>;
export type SettingsDraft = { defaultMode: SelfhealMode } & Record<SettingsField, string>;
export type SettingsErrors = Partial<Record<SettingsField, string>>;

export const SETTINGS_FIELDS: readonly {
  key: SettingsField;
  label: string;
  min: number;
  max: number;
  unit: string;
}[] = [
  { key: 'maxRestarts', label: 'Höchstens Neustarts', min: 1, max: 10, unit: '' },
  { key: 'windowMinutes', label: 'in Min', min: 10, max: 1440, unit: 'Min' },
  { key: 'minGapSeconds', label: 'Abstand mindestens in s', min: 30, max: 3600, unit: 's' },
  {
    key: 'unhealthyGraceSeconds',
    label: 'Schonfrist „unhealthy“ in s',
    min: 30,
    max: 1800,
    unit: 's',
  },
  { key: 'checkDownMinutes', label: 'Website DOWN seit Min', min: 1, max: 60, unit: 'Min' },
];

export function settingsToDraft(s: SelfhealSettings): SettingsDraft {
  return {
    defaultMode: s.defaultMode,
    maxRestarts: String(s.maxRestarts),
    windowMinutes: String(s.windowMinutes),
    minGapSeconds: String(s.minGapSeconds),
    unhealthyGraceSeconds: String(s.unhealthyGraceSeconds),
    checkDownMinutes: String(s.checkDownMinutes),
  };
}

export function draftToSettings(
  d: SettingsDraft,
): { ok: true; settings: SelfhealSettings } | { ok: false; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  const out: Partial<Record<SettingsField, number>> = {};
  for (const f of SETTINGS_FIELDS) {
    const n = Number(d[f.key].trim());
    if (!d[f.key].trim() || !Number.isInteger(n) || n < f.min || n > f.max) {
      errors[f.key] = `${formatNumber(f.min, 0)} bis ${formatNumber(f.max, 0)}`;
    } else out[f.key] = n;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      defaultMode: d.defaultMode,
      maxRestarts: out.maxRestarts ?? 3,
      windowMinutes: out.windowMinutes ?? 30,
      minGapSeconds: out.minGapSeconds ?? 120,
      unhealthyGraceSeconds: out.unhealthyGraceSeconds ?? 120,
      checkDownMinutes: out.checkDownMinutes ?? 3,
    },
  };
}

/** Settings, rules, state and events. Polled, no live topic. */
export function useSelfheal(enabled = true): UseQueryResult<SelfhealResponse> {
  return useQuery({
    queryKey: selfhealKey,
    queryFn: ({ signal }) => fetchSelfheal(signal),
    enabled,
    refetchInterval: 15_000,
  });
}

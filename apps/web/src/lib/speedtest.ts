import {
  SPEEDTEST_INTERVALS,
  SPEEDTEST_KEEP_DAYS,
  SPEEDTEST_SLOW_STREAK,
  speedtestResponseSchema,
  speedtestSettingsSchema,
  type SpeedtestResponse,
  type SpeedtestResult,
  type SpeedtestSettings,
} from '@hz/shared';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from './api.js';
import { formatBytes, formatNumber, formatWhen } from './format.js';

/** M20 "Speedtest-Verlauf" (packages/shared/src/api/speedtest.ts). */

export { SPEEDTEST_INTERVALS, SPEEDTEST_KEEP_DAYS, SPEEDTEST_SLOW_STREAK };
export type { SpeedtestResponse, SpeedtestResult, SpeedtestSettings };

export type SpeedtestDays = 7 | 30 | 90;
export const SPEEDTEST_RANGES: readonly SpeedtestDays[] = [7, 30, 90];

export const speedtestKey = (days: SpeedtestDays) => ['speedtest', days] as const;
export const speedtestAllKey = ['speedtest'] as const;

const MB = 1024 * 1024;

export function fetchSpeedtest(
  days: SpeedtestDays,
  signal?: AbortSignal,
): Promise<SpeedtestResponse> {
  return api(`/api/speedtest?days=${days}`, { schema: speedtestResponseSchema, signal });
}

export function saveSpeedtestSettings(
  body: Partial<SpeedtestSettings>,
): Promise<SpeedtestSettings> {
  return api('/api/speedtest/settings', {
    method: 'PUT',
    body,
    schema: speedtestSettingsSchema,
  });
}

/** 202 { startedAt }; 409 busy / no_server, 429 within 5 Min of the last start. */
export async function runSpeedtest(): Promise<void> {
  await api('/api/speedtest/run', {
    method: 'POST',
    body: {},
    schema: { parse: (d: unknown): unknown => d },
  });
}

// ---------------------------------------------------------------------------
// Texts (pure, unit tested)

/** "93,4 Mbit/s", "312 Mbit/s", "1,25 Gbit/s", "—". */
export function formatMbps(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1000) return `${formatNumber(v / 1000, 2)} Gbit/s`;
  return `${formatNumber(v, v >= 100 ? 0 : 1)} Mbit/s`;
}

/** Number part of formatMbps for Metric (value + unit). */
export function mbpsParts(v: number | null | undefined): { value: string; unit: string } {
  if (v == null || !Number.isFinite(v)) return { value: '—', unit: '' };
  if (v >= 1000) return { value: formatNumber(v / 1000, 2), unit: 'Gbit/s' };
  return { value: formatNumber(v, v >= 100 ? 0 : 1), unit: 'Mbit/s' };
}

/** "12 ms", "4,2 ms". */
export function formatMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${formatNumber(v, v >= 10 ? 0 : 1)} ms`;
}

export function intervalLabel(h: number): string {
  return h === 1 ? 'jede Stunde' : `alle ${h} Std`;
}

/** "bis zu 200 MB pro Messung · bei alle 6 Std bis zu 23,4 GB im Monat". */
export function trafficText(s: Pick<SpeedtestSettings, 'maxMb' | 'intervalHours'>): string {
  const perTest = 2 * s.maxMb * MB;
  const perMonth = perTest * (24 / s.intervalHours) * 30;
  return `bis zu ${formatBytes(perTest)} pro Messung · ${intervalLabel(s.intervalHours)} bis zu ${formatBytes(perMonth)} im Monat`;
}

/** At most `max` bars: averages neighbouring ok results; failed results are left out. */
export function downloadBars(
  results: readonly SpeedtestResult[],
  pick: (r: SpeedtestResult) => number | null = (r) => r.downloadMbps,
  max = 60,
): number[] {
  const values = results
    .filter((r) => r.ok)
    .map(pick)
    .filter((v): v is number => v != null);
  if (values.length <= max) return values;
  const size = values.length / max;
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    const chunk = values.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    out.push(chunk.reduce((a, b) => a + b, 0) / Math.max(1, chunk.length));
  }
  return out;
}

/** True when the result is below one of the set thresholds. */
export function isSlow(
  r: SpeedtestResult,
  s: Pick<SpeedtestSettings, 'minDownMbps' | 'minUpMbps'>,
): boolean {
  if (!r.ok) return false;
  if (s.minDownMbps != null && r.downloadMbps != null && r.downloadMbps < s.minDownMbps)
    return true;
  return s.minUpMbps != null && r.uploadMbps != null && r.uploadMbps < s.minUpMbps;
}

/** Statussatz: last result first. */
export function speedtestSentence(r: SpeedtestResponse | undefined): {
  em: string | null;
  rest: string;
} {
  if (!r) return { em: null, rest: 'Speedtest' };
  if (!r.settings.serverId) return { em: null, rest: 'Speedtest: kein Server gewählt.' };
  const last = r.results[r.results.length - 1];
  if (!last) return { em: null, rest: 'Noch keine Messung.' };
  if (!last.ok)
    return { em: `Letzte Messung fehlgeschlagen`, rest: last.error ? ` · ${last.error}` : '' };
  const text = `${formatMbps(last.downloadMbps)} Download, ${formatMbps(last.uploadMbps)} Upload`;
  if (isSlow(last, r.settings)) {
    const want = r.settings.minDownMbps;
    return {
      em: `Internet langsam: ${formatMbps(last.downloadMbps)}${want != null ? ` statt ${formatNumber(want, 1)}` : ''}`,
      rest: '',
    };
  }
  return { em: null, rest: `${text}.` };
}

/** "23:04 · von Hand" for the table. */
export function resultWhen(r: SpeedtestResult, now: Date): string {
  return formatWhen(new Date(r.at), now);
}

/** Parses a threshold field: empty = no threshold. */
export function parseThreshold(raw: string): { ok: true; value: number | null } | { ok: false } {
  const t = raw.trim().replace(',', '.');
  if (!t) return { ok: true, value: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > 100_000) return { ok: false };
  return { ok: true, value: n };
}

/** History of the chosen range; polled faster while a test runs. */
export function useSpeedtest(
  days: SpeedtestDays,
  enabled = true,
): UseQueryResult<SpeedtestResponse> {
  return useQuery({
    queryKey: speedtestKey(days),
    queryFn: ({ signal }) => fetchSpeedtest(days, signal),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.running ? 3_000 : 60_000),
  });
}

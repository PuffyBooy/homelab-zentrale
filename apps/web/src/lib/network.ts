import {
  DNS_PAUSE_MINUTES,
  dnsFilterStatusSchema,
  fritzStatusSchema,
  okResponseSchema,
  type DnsFilterStatus,
  type FritzDevice,
  type FritzStatus,
} from '@hz/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Status } from '@hz/ui';
import { api } from './api.js';
import { useIntegrationSettings } from './integrations.js';
import { formatGrouped, formatNumber, formatPercent, formatTime, plural } from './format.js';
import type { StatusSentence } from './servers.js';

/**
 * Page "Netzwerk" (SPEC 16): FRITZ!Box over TR-064 and the DNS filter (Pi-hole v6 or
 * AdGuard Home). Routes from packages/shared/src/api/integrations.ts.
 */

export const fritzStatusKey = ['fritzbox', 'status'] as const;
export const dnsFilterStatusKey = ['dnsfilter', 'status'] as const;

export const NETWORK_REFRESH_MS = 15_000;

export function fetchFritzStatus(signal?: AbortSignal): Promise<FritzStatus> {
  return api('/api/fritzbox/status', { schema: fritzStatusSchema, signal });
}

export function fetchDnsFilterStatus(signal?: AbortSignal): Promise<DnsFilterStatus> {
  return api('/api/dnsfilter/status', { schema: dnsFilterStatusSchema, signal });
}

/** Step-up: api() asks for the code and retries once. */
export async function rebootFritzBox(): Promise<void> {
  await api('/api/fritzbox/reboot', {
    method: 'POST',
    body: { confirm: true },
    schema: okResponseSchema,
  });
}

export type PauseMinutes = (typeof DNS_PAUSE_MINUTES)[number];

/** `minutes` pauses blocking (never without an end), null turns it back on. */
export function setDnsBlocking(minutes: PauseMinutes | null): Promise<DnsFilterStatus> {
  return api('/api/dnsfilter/blocking', {
    method: 'POST',
    body: minutes === null ? { enabled: true } : { enabled: false, minutes },
    schema: dnsFilterStatusSchema,
  });
}

export function useFritzStatus(enabled = true): UseQueryResult<FritzStatus> {
  return useQuery({
    queryKey: fritzStatusKey,
    queryFn: ({ signal }) => fetchFritzStatus(signal),
    enabled,
    refetchInterval: NETWORK_REFRESH_MS,
    staleTime: 10_000,
  });
}

export function useDnsFilterStatus(enabled = true): UseQueryResult<DnsFilterStatus> {
  return useQuery({
    queryKey: dnsFilterStatusKey,
    queryFn: ({ signal }) => fetchDnsFilterStatus(signal),
    enabled,
    refetchInterval: NETWORK_REFRESH_MS,
    staleTime: 10_000,
  });
}

/**
 * Settings and status of FRITZ!Box and DNS filter; a status is only read once the
 * integration is set up. `enabled` false reads nothing (other pages).
 */
export function useNetworkView(modules: { fritzbox: boolean; dnsfilter: boolean }, enabled = true) {
  const fritzSettings = useIntegrationSettings('fritzbox', enabled && modules.fritzbox);
  const dnsSettings = useIntegrationSettings('dnsfilter', enabled && modules.dnsfilter);
  const fritzReady = enabled && modules.fritzbox && fritzSettings.configured === true;
  const dnsReady = enabled && modules.dnsfilter && dnsSettings.configured === true;
  const fritz = useFritzStatus(fritzReady);
  const dns = useDnsFilterStatus(dnsReady);
  return {
    fritzSettings,
    dnsSettings,
    fritz,
    dns,
    fritzReady,
    dnsReady,
    /** Data of switched-on, set-up integrations only. */
    fritzData: fritzReady ? fritz.data : undefined,
    dnsData: dnsReady ? dns.data : undefined,
  };
}

// ---------------------------------------------------------------------------
// FRITZ!Box

/** Number part of a line speed: "250", "40,5", "1.000" (bits per second in), or "—". */
export function mbitValue(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return '—';
  const mbit = bps / 1_000_000;
  const digits = mbit >= 100 ? 0 : 1;
  return formatGrouped(Number(mbit.toFixed(digits)), 0, digits);
}

/** "250 Mbit/s", "40,5 Mbit/s", "1.000 Mbit/s" from bits per second. */
export function formatMbit(bps: number | null | undefined): string {
  const v = mbitValue(bps);
  return v === '—' ? v : `${v} Mbit/s`;
}

export type InternetState = 'up' | 'down' | 'unknown';

/** Unknown while the box is not reachable (then the last link state is not trusted). */
export function internetState(f: FritzStatus | undefined): InternetState {
  if (!f || f.error || !f.internet) return 'unknown';
  return f.internet.connected ? 'up' : 'down';
}

export function internetStatus(state: InternetState): Status {
  if (state === 'up') return 'ok';
  if (state === 'down') return 'crit';
  return 'warn';
}

export const INTERNET_TEXT: Record<InternetState, string> = {
  up: 'Internet verbunden',
  down: 'Internet getrennt',
  unknown: 'Internet-Status unbekannt',
};

export const INTERFACE_LABEL: Record<FritzDevice['interface'], string> = {
  lan: 'LAN',
  wlan: 'WLAN',
  other: 'andere',
};

/** Active first, then by name. */
export function sortDevices(list: readonly FritzDevice[]): FritzDevice[] {
  return [...list].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      a.name.localeCompare(b.name, 'de', { numeric: true }) ||
      (a.ip ?? '').localeCompare(b.ip ?? '', 'de', { numeric: true }),
  );
}

export type DeviceFilter = 'active' | 'all';

export function filterDevices(list: readonly FritzDevice[], f: DeviceFilter): FritzDevice[] {
  const sorted = sortDevices(list);
  return f === 'active' ? sorted.filter((d) => d.active) : sorted;
}

// ---------------------------------------------------------------------------
// DNS filter

export type BlockingState = 'on' | 'paused' | 'off' | 'unknown';

export function blockingState(d: DnsFilterStatus | undefined): BlockingState {
  if (!d || d.error || d.blocking === null) return 'unknown';
  if (d.blocking) return 'on';
  return d.pausedUntil ? 'paused' : 'off';
}

/** Paused or off: the filter does not protect right now, so "hier schauen" (warn). */
export function blockingStatus(state: BlockingState): Status {
  return state === 'on' ? 'ok' : 'warn';
}

/** "blockt", "pausiert bis 23:04", "blockt nicht", "Status unbekannt". */
export function blockingText(d: DnsFilterStatus | undefined): string {
  const state = blockingState(d);
  if (state === 'on') return 'blockt';
  if (state === 'paused' && d?.pausedUntil)
    return `pausiert bis ${formatTime(new Date(d.pausedUntil))}`;
  if (state === 'off') return 'blockt nicht';
  return 'Status unbekannt';
}

/** "12.345" or "—". */
export function formatCount(n: number | null | undefined): string {
  return n == null ? '—' : formatGrouped(n, 0, 0);
}

/** "8,4 %" (one decimal below 10, whole percent above), or "—". */
export function formatBlockedPct(p: number | null | undefined): string {
  if (p == null) return '—';
  return p < 10 ? `${formatNumber(p, 1)} %` : formatPercent(p);
}

export const PAUSE_MINUTES: readonly PauseMinutes[] = DNS_PAUSE_MINUTES;

// ---------------------------------------------------------------------------
// Statussatz (page) and the overview tile

export interface NetworkData {
  fritz?: FritzStatus | undefined;
  dns?: DnsFilterStatus | undefined;
  fritzOn: boolean;
  dnsOn: boolean;
}

/** Problems first: internet down, box or filter unreachable, blocking paused. */
export function networkSentence(d: NetworkData): StatusSentence {
  const problems: string[] = [];
  const fine: string[] = [];
  if (d.fritzOn && d.fritz) {
    const s = internetState(d.fritz);
    if (s === 'down') problems.push('Internet getrennt');
    else if (d.fritz.error) problems.push(`FRITZ!Box nicht erreichbar: ${d.fritz.error}`);
    else if (s === 'up') fine.push('Internet verbunden');
  }
  if (d.dnsOn && d.dns) {
    const b = blockingState(d.dns);
    if (d.dns.error) problems.push(`DNS-Filter nicht erreichbar: ${d.dns.error}`);
    else if (b === 'paused' || b === 'off') problems.push(`DNS-Filter ${blockingText(d.dns)}`);
    else if (b === 'on') {
      fine.push(
        d.dns.percentBlocked != null
          ? `${formatBlockedPct(d.dns.percentBlocked)} blockiert heute`
          : 'DNS-Filter blockt',
      );
    }
  }
  const [first, ...rest] = problems;
  if (first) {
    const tail = [...rest, ...fine];
    return { em: first, rest: tail.length ? ` · ${tail.join(' · ')}` : '' };
  }
  if (fine.length) return { em: null, rest: `${fine.join(' · ')}.` };
  return { em: null, rest: 'Netzwerk' };
}

/** Sub line under the Statussatz: device count when known. */
export function networkSub(d: NetworkData): string {
  const parts = ['Netzwerk'];
  if (d.fritzOn && d.fritz && !d.fritz.error) {
    const active = d.fritz.devices.filter((x) => x.active).length;
    parts.push(`${plural(active, 'Gerät', 'Geräte')} aktiv`);
  }
  if (d.dnsOn && d.dns?.variant)
    parts.push(d.dns.variant === 'pihole' ? 'Pi-hole' : 'AdGuard Home');
  parts.push(`alle ${NETWORK_REFRESH_MS / 1000} s aktualisiert`);
  return parts.join(' · ');
}

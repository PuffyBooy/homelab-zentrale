import {
  WOL_DEFAULTS,
  macSchema,
  wolBroadcastSchema,
  wolConfigSchema,
  wolWakeResponseSchema,
  type WolConfig,
} from '@hz/shared';
import { api, isApiError } from './api.js';
import { errorText } from './errors.js';

/** Wake-on-LAN per server (SPEC 16, server detail). Core feature, no module. */

export const wolKey = (serverId: string) => ['server', serverId, 'wol'] as const;

const enc = encodeURIComponent;

export function fetchWol(serverId: string, signal?: AbortSignal): Promise<WolConfig> {
  return api(`/api/servers/${enc(serverId)}/wol`, { schema: wolConfigSchema, signal });
}

export interface WolBody {
  mac: string | null;
  broadcast: string;
  port: 7 | 9;
  via: string;
}

export function saveWol(serverId: string, body: WolBody): Promise<WolConfig> {
  return api(`/api/servers/${enc(serverId)}/wol`, {
    method: 'PUT',
    body,
    schema: wolConfigSchema,
  });
}

export function wakeServer(serverId: string): Promise<{ ok: true; via: string }> {
  return api(`/api/servers/${enc(serverId)}/wake`, {
    method: 'POST',
    schema: wolWakeResponseSchema,
  });
}

export interface WolForm {
  mac: string;
  broadcast: string;
  port: '7' | '9';
  via: string;
}

export function wolToForm(c: WolConfig | undefined): WolForm {
  return {
    mac: c?.mac ?? '',
    broadcast: c?.broadcast ?? WOL_DEFAULTS.broadcast,
    port: String(c?.port ?? WOL_DEFAULTS.port) as '7' | '9',
    via: c?.via ?? WOL_DEFAULTS.via,
  };
}

export type WolErrors = Partial<Record<'mac' | 'broadcast', string>>;

/** Validates with the shared schemas; an empty MAC removes Wake-on-LAN. */
export function buildWolBody(f: WolForm): { body: WolBody | null; errors: WolErrors } {
  const errors: WolErrors = {};
  let mac: string | null = null;
  if (f.mac.trim()) {
    const m = macSchema.safeParse(f.mac);
    if (m.success) mac = m.data;
    else errors.mac = m.error.issues[0]?.message ?? 'MAC-Adresse wie AA:BB:CC:DD:EE:FF';
  }
  const b = wolBroadcastSchema.safeParse(f.broadcast || WOL_DEFAULTS.broadcast);
  if (!b.success) errors.broadcast = '255.255.255.255 oder eine private IPv4-Adresse.';
  if (Object.keys(errors).length || !b.success) return { body: null, errors };
  return {
    body: { mac, broadcast: b.data, port: f.port === '7' ? 7 : 9, via: f.via || 'core' },
    errors,
  };
}

/** 429: at most 6 per minute; 409: the sending agent is offline. */
export function wakeErrorText(err: unknown): string {
  if (isApiError(err, 'rate_limited')) return 'Zu oft, kurz warten.';
  if (isApiError(err, 'agent_offline') || (isApiError(err) && err.status === 409 && !err.hint))
    return 'Sender-Agent offline. Anderen Sender wählen oder die Zentrale senden lassen.';
  return errorText(err);
}

/** "AA:BB:CC:DD:EE:FF über die Zentrale" for the detail line. */
export function viaText(via: string, names: ReadonlyMap<string, string>): string {
  return via === 'core' ? 'die Zentrale' : (names.get(via) ?? 'einen Agent');
}

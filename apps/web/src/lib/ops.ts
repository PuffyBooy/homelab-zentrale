import {
  discordBotStateSchema,
  fail2banResponseSchema,
  fail2banServerSchema,
  logSearchResponseSchema,
  snowflakeSchema,
  voiceStateSchema,
  voiceStatusEntitySchema,
  voiceSwitchEntitySchema,
  vulnScanStateSchema,
  type DiscordBotState,
  type Fail2banResponse,
  type Fail2banServer,
  type LogSearchRequest,
  type LogSearchResponse,
  type VoiceState,
  type VulnScanResult,
  type VulnScanSettings,
  type VulnScanState,
} from '@hz/shared';
import type { Status } from '@hz/ui';
import { api, isApiError } from './api.js';
import { errorText } from './errors.js';
import { formatNumber } from './format.js';

/** Operations modules (api/ops.ts): log search, vulnerability scan, fail2ban, Discord, voice. */

export const vulnscanKey = ['vulnscan'] as const;
export const fail2banKey = ['fail2ban'] as const;
export const discordBotKey = ['discord-bot'] as const;
export const voiceKey = ['voice'] as const;

// ---- API ------------------------------------------------------------------------

export function searchLogs(body: LogSearchRequest): Promise<LogSearchResponse> {
  return api('/api/logsearch', { method: 'POST', body, schema: logSearchResponseSchema });
}

export function fetchVulnscan(signal?: AbortSignal): Promise<VulnScanState> {
  return api('/api/vulnscan', { schema: vulnScanStateSchema, signal });
}

export function runVulnscan(): Promise<VulnScanState> {
  return api('/api/vulnscan/run', { method: 'POST', schema: vulnScanStateSchema });
}

export function saveVulnscanSettings(body: VulnScanSettings): Promise<VulnScanState> {
  return api('/api/vulnscan/settings', { method: 'PUT', body, schema: vulnScanStateSchema });
}

export function fetchFail2ban(signal?: AbortSignal): Promise<Fail2banResponse> {
  return api('/api/fail2ban', { schema: fail2banResponseSchema, signal });
}

export interface UnbanTarget {
  serverId: string;
  jail: string;
  ip: string;
}

export function unbanIp(body: UnbanTarget): Promise<Fail2banServer> {
  return api('/api/fail2ban/unban', { method: 'POST', body, schema: fail2banServerSchema });
}

export function fetchDiscordBot(signal?: AbortSignal): Promise<DiscordBotState> {
  return api('/api/discord-bot', { schema: discordBotStateSchema, signal });
}

export interface DiscordBotPatch {
  /** Missing: keep the stored token; null: delete it. */
  token?: string | null;
  applicationId: string | null;
  guildId: string | null;
}

/** Needs step-up; api() asks for the code and retries once. */
export function saveDiscordBot(body: DiscordBotPatch): Promise<DiscordBotState> {
  return api('/api/discord-bot', { method: 'PUT', body, schema: discordBotStateSchema });
}

export function saveDiscordBinding(
  shareId: string,
  discordUserId: string | null,
): Promise<DiscordBotState> {
  return api(`/api/discord-bot/bindings/${encodeURIComponent(shareId)}`, {
    method: 'PUT',
    body: { discordUserId },
    schema: discordBotStateSchema,
  });
}

export function fetchVoice(signal?: AbortSignal): Promise<VoiceState> {
  return api('/api/voice', { schema: voiceStateSchema, signal });
}

export interface VoiceGamePatch {
  switchEntity: string | null;
  statusEntity: string | null;
  allowStop: boolean;
}

/** Step-up when the switch entity changes; api() asks and retries. */
export function saveVoiceGame(gameId: string, body: VoiceGamePatch): Promise<VoiceState> {
  return api(`/api/voice/games/${encodeURIComponent(gameId)}`, {
    method: 'PUT',
    body,
    schema: voiceStateSchema,
  });
}

/** The user closed the step-up dialog: no error line for that. */
export function shownError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return errorText(err);
}

// ---- log search -----------------------------------------------------------------

export const LOG_QUERY_MIN = 2;

export const SINCE_OPTIONS: readonly { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 Min' },
  { minutes: 60, label: '1 Std' },
  { minutes: 360, label: '6 Std' },
  { minutes: 1440, label: '24 Std' },
  { minutes: 10080, label: '7 Tage' },
];

const CONTAINER_FILTER_RE = /^[A-Za-z0-9_.-]*$/;

export interface LogSearchDraft {
  query: string;
  sinceMinutes: number;
  /** Empty: all servers. */
  serverIds: string[];
  container: string;
  caseSensitive: boolean;
}

export type LogSearchCheck =
  { ok: true; body: LogSearchRequest } | { ok: false; field: 'query' | 'container'; error: string };

/** Client-side check with the same rules as logSearchRequestSchema. */
export function logSearchBody(d: LogSearchDraft): LogSearchCheck {
  const query = d.query.trim();
  if (query.length < LOG_QUERY_MIN)
    return { ok: false, field: 'query', error: 'Mindestens 2 Zeichen.' };
  if (query.length > 200) return { ok: false, field: 'query', error: 'Höchstens 200 Zeichen.' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(query))
    return { ok: false, field: 'query', error: 'Nur eine Zeile, ohne Steuerzeichen.' };
  const container = d.container.trim();
  if (container.length > 128 || !CONTAINER_FILTER_RE.test(container))
    return {
      ok: false,
      field: 'container',
      error: 'Nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich.',
    };
  const body: LogSearchRequest = {
    query,
    caseSensitive: d.caseSensitive,
    sinceMinutes: d.sinceMinutes,
    maxMatches: 200,
  };
  if (d.serverIds.length) body.serverIds = d.serverIds;
  if (container) body.container = container;
  return { ok: true, body };
}

export function logSearchErrorText(err: unknown): string {
  if (isApiError(err, 'rate_limited')) return 'Zu viele Suchen, kurz warten.';
  return errorText(err);
}

export type LogServerState = LogSearchResponse['servers'][number]['state'];

export const LOG_SERVER_STATE: Record<LogServerState, { status: Status; label: string }> = {
  ok: { status: 'ok', label: 'durchsucht' },
  offline: { status: 'crit', label: 'offline' },
  unsupported: { status: 'warn', label: 'Agent zu alt' },
  failed: { status: 'crit', label: 'Fehler' },
  no_containers: { status: 'off', label: 'keine Container' },
};

export interface TextSegment {
  text: string;
  match: boolean;
}

/**
 * Splits a log line into plain and matching parts for <mark>. Plain-text search, never a
 * regex from the input (the query is escaped). The parts are rendered as React text, so
 * markup in a log line stays text.
 */
export function highlightSegments(
  text: string,
  query: string,
  caseSensitive: boolean,
): TextSegment[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
  const out: TextSegment[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push({ text: text.slice(last, m.index), match: false });
    out.push({ text: m[0], match: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), match: false });
  return out.length ? out : [{ text, match: false }];
}

// ---- vulnerability scan ---------------------------------------------------------

export interface VulnRowStatus {
  status: Status;
  label: string;
}

export function vulnStatus(r: VulnScanResult): VulnRowStatus {
  const s = r.scan;
  if (!s.scannable) {
    return s.reason === 'local_image'
      ? { status: 'off', label: 'nicht prüfbar (lokal gebaut)' }
      : { status: 'warn', label: 'Scan fehlgeschlagen' };
  }
  if (s.counts.critical > 0) return { status: 'crit', label: 'CRIT' };
  if (s.counts.high > 0) return { status: 'warn', label: 'HIGH' };
  return { status: 'ok', label: 'OK' };
}

export const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function vulnscanSentence(state: VulnScanState): string {
  const crit = state.results.filter((r) => r.scan.counts.critical > 0).length;
  const high = state.results.filter(
    (r) => r.scan.counts.critical === 0 && r.scan.counts.high > 0,
  ).length;
  if (crit) return `${formatNumber(crit, 0)} mit kritischen Lücken`;
  if (high) return `${formatNumber(high, 0)} mit hohen Lücken`;
  return state.results.length ? 'keine kritischen Lücken' : 'noch kein Ergebnis';
}

// ---- fail2ban -------------------------------------------------------------------

export const FAIL2BAN_STATE: Record<Fail2banServer['state'], { status: Status; label: string }> = {
  ok: { status: 'ok', label: 'aktiv' },
  not_installed: { status: 'off', label: 'nicht installiert' },
  offline: { status: 'crit', label: 'offline' },
  unsupported: { status: 'warn', label: 'Agent zu alt' },
  failed: { status: 'crit', label: 'Fehler' },
};

// ---- Discord --------------------------------------------------------------------

export const DISCORD_STATUS: Record<DiscordBotState['status'], Status> = {
  off: 'off',
  unconfigured: 'off',
  connecting: 'busy',
  online: 'ok',
  error: 'crit',
};

export const DISCORD_STATUS_TAG: Record<DiscordBotState['status'], string> = {
  off: 'OFF',
  unconfigured: 'OFF',
  connecting: 'BOOT',
  online: 'UP',
  error: 'DOWN',
};

export const DISCORD_TOKEN_RE = /^[A-Za-z0-9._-]{50,120}$/;

export function isSnowflake(v: string): boolean {
  return snowflakeSchema.safeParse(v).success;
}

/** Invite link for the bot, only for a valid application id. */
export function discordInviteUrl(applicationId: string): string | null {
  const id = applicationId.trim();
  if (!isSnowflake(id)) return null;
  return `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot%20applications.commands`;
}

export const SHARE_STATE_TEXT: Record<'active' | 'expired' | 'revoked', string> = {
  active: 'aktiv',
  expired: 'abgelaufen',
  revoked: 'widerrufen',
};

export const DISCORD_COMMAND_HELP: readonly { cmd: string; text: string }[] = [
  { cmd: '/status', text: 'Zustand und Spieler der eigenen Gameserver' },
  { cmd: '/start spiel', text: 'startet den Gameserver (Recht Starten/Stoppen, RAM-Reserve gilt)' },
  { cmd: '/stop spiel', text: 'stoppt ihn (Recht Starten/Stoppen)' },
  { cmd: '/restart spiel', text: 'startet ihn neu (Recht Neustart)' },
];

// ---- voice ----------------------------------------------------------------------

export function isSwitchEntity(v: string): boolean {
  return voiceSwitchEntitySchema.safeParse(v).success;
}

export function isStatusEntity(v: string): boolean {
  return voiceStatusEntitySchema.safeParse(v).success;
}

import {
  gameModSearchResponseSchema,
  gameModsResponseSchema,
  gameNotifySchema,
  gameNotifyTestResponseSchema,
  gameResponseSchema,
  gameSchedulesResponseSchema,
  gameStatsResponseSchema,
  whitelistRequestListResponseSchema,
  whitelistRequestResponseSchema,
  type GameSchedule,
  type GameStats,
  type GameSummary,
  type ServerNetwork,
  type ServerSummary,
  type WhitelistRequest,
} from '@hz/shared';
import type { Status } from '@hz/ui';
import { api } from './api.js';
import { formatNumber, formatTime, formatWhen, plural } from './format.js';
import type { GameEvent, TemplateInfo } from './games.js';

/**
 * M12 "Gameserver komplett" (SPEC 6.5): REST calls for schedules, Discord, statistics,
 * mods/plugins, whitelist requests and restore, plus the pure helpers the tiles use.
 * Routes and shapes: packages/shared/src/api/game-features.ts.
 */

type Out<S> = S extends { parse(data: unknown): infer T } ? T : never;

export type GameSchedules = Out<typeof gameSchedulesResponseSchema>;
export type GameNotify = Out<typeof gameNotifySchema>;
export type GameNotifyEvent = GameNotify['events'][number];
export type GameMods = Out<typeof gameModsResponseSchema>;
export type ModHit = Out<typeof gameModSearchResponseSchema>['hits'][number];
export type { GameSchedule, GameStats, WhitelistRequest };

const enc = encodeURIComponent;

export const schedulesKey = (id: string) => ['games', 'schedules', id] as const;
export const notifyKey = (id: string) => ['games', 'notify', id] as const;
export const statsKey = (id: string, days: 7 | 30) => ['games', 'stats', id, days] as const;
export const modsKey = (id: string) => ['games', 'mods', id] as const;
export const modSearchKey = (id: string, q: string) => ['games', 'mods', id, 'search', q] as const;
export const whitelistRequestsKey = (id: string) => ['games', 'whitelist-requests', id] as const;

// ---- REST -------------------------------------------------------------------------

export function fetchSchedules(id: string, signal?: AbortSignal): Promise<GameSchedules> {
  return api(`/api/games/${enc(id)}/schedules`, { schema: gameSchedulesResponseSchema, signal });
}

/** Replaces the whole list. */
export function saveSchedules(id: string, schedules: GameSchedule[]): Promise<GameSchedules> {
  return api(`/api/games/${enc(id)}/schedules`, {
    method: 'PUT',
    body: { schedules },
    schema: gameSchedulesResponseSchema,
  });
}

export function fetchNotify(id: string, signal?: AbortSignal): Promise<GameNotify> {
  return api(`/api/games/${enc(id)}/notify`, { schema: gameNotifySchema, signal });
}

/**
 * `discordWebhookUrl`: undefined keeps the stored URL, null removes it. Changing the URL
 * needs step-up (the dialog comes from api()).
 */
export function saveNotify(
  id: string,
  body: { discordWebhookUrl?: string | null; events: GameNotifyEvent[] },
): Promise<GameNotify> {
  return api(`/api/games/${enc(id)}/notify`, { method: 'PUT', body, schema: gameNotifySchema });
}

export async function testNotify(id: string): Promise<boolean> {
  const res = await api(`/api/games/${enc(id)}/notify/test`, {
    method: 'POST',
    body: {},
    schema: gameNotifyTestResponseSchema,
  });
  return res.ok;
}

export function fetchStats(id: string, days: 7 | 30, signal?: AbortSignal): Promise<GameStats> {
  return api(`/api/games/${enc(id)}/stats?days=${days}`, {
    schema: gameStatsResponseSchema,
    signal,
  });
}

export function fetchMods(id: string, signal?: AbortSignal): Promise<GameMods> {
  return api(`/api/games/${enc(id)}/mods`, { schema: gameModsResponseSchema, signal });
}

export async function searchMods(id: string, q: string, signal?: AbortSignal): Promise<ModHit[]> {
  const query = new URLSearchParams({ q: q.trim() });
  const res = await api(`/api/games/${enc(id)}/mods/search?${query.toString()}`, {
    schema: gameModSearchResponseSchema,
    signal,
  });
  return res.hits;
}

export function installMod(id: string, projectId: string): Promise<GameMods> {
  return api(`/api/games/${enc(id)}/mods`, {
    method: 'POST',
    body: { projectId },
    schema: gameModsResponseSchema,
  });
}

export function removeMod(id: string, fileName: string): Promise<GameMods> {
  return api(`/api/games/${enc(id)}/mods/${enc(fileName)}`, {
    method: 'DELETE',
    schema: gameModsResponseSchema,
  });
}

export async function fetchWhitelistRequests(
  id: string,
  signal?: AbortSignal,
): Promise<WhitelistRequest[]> {
  const res = await api(`/api/games/${enc(id)}/whitelist-requests`, {
    schema: whitelistRequestListResponseSchema,
    signal,
  });
  return res.requests;
}

export async function decideWhitelistRequest(
  requestId: string,
  decision: 'approve' | 'reject',
): Promise<WhitelistRequest> {
  const res = await api(`/api/whitelist-requests/${enc(requestId)}/${decision}`, {
    method: 'POST',
    body: {},
    schema: whitelistRequestResponseSchema,
  });
  return res.request;
}

/** 202: progress on topic game:<id>. Step-up comes from api(). */
export async function restoreBackup(
  id: string,
  backupId: string,
  confirmName: string,
): Promise<GameSummary> {
  const res = await api(`/api/games/${enc(id)}/backups/${enc(backupId)}/restore`, {
    method: 'POST',
    body: { confirmName },
    schema: gameResponseSchema,
  });
  return res.game;
}

// ---- restore progress ------------------------------------------------------------------

export interface RestoreProgress {
  state: 'running' | 'ready' | 'error';
  /** Last progress, ready or error text; null before the first event. */
  text: string | null;
}

/**
 * Progress of a restore from the game:<id> events that came after `afterId` (the last
 * event before the restore started; null: all). Console lines are ignored.
 */
export function restoreProgress(
  events: readonly GameEvent[],
  afterId: string | null,
): RestoreProgress {
  const start = afterId ? events.findIndex((e) => e.id === afterId) + 1 : 0;
  let out: RestoreProgress = { state: 'running', text: null };
  for (const e of events.slice(start)) {
    if (e.kind === 'console') continue;
    const text = e.text.trim().split('\n').pop() ?? '';
    if (e.kind === 'progress') out = { state: 'running', text: text || out.text };
    else if (e.kind === 'ready') out = { state: 'ready', text: text || null };
    else out = { state: 'error', text: text || null };
  }
  return out;
}

// ---- sleep mode ---------------------------------------------------------------------

/** Status tag of a game: "Schläft" instead of OFF while asleep. */
export function gameStatusLabel(g: Pick<GameSummary, 'status' | 'sleeping'>): string | undefined {
  return g.status === 'off' && g.sleeping ? 'Schläft' : undefined;
}

/** Long text for the detail page ("Schläft · weckt beim Verbinden"). */
export function sleepText(
  g: Pick<GameSummary, 'status' | 'sleeping' | 'wakeOnConnect' | 'statusText'>,
): string {
  if (g.status !== 'off' || !g.sleeping) return g.statusText;
  return g.wakeOnConnect ? 'Schläft · weckt beim Verbinden' : 'Schläft · Starten weckt ihn';
}

/** "Alle 3 Gameserver sind gestoppt." or with sleep mode "… · 2 schlafen". */
export function stoppedText(games: readonly Pick<GameSummary, 'sleeping'>[]): string {
  if (!games.length) return 'Noch keine Gameserver.';
  const asleep = games.filter((g) => g.sleeping).length;
  if (games.length === 1) {
    return asleep ? 'Der Gameserver schläft.' : 'Der Gameserver ist gestoppt.';
  }
  const all = `Alle ${plural(games.length, 'Gameserver', 'Gameserver')}`;
  if (asleep === games.length) return `${all} schlafen.`;
  if (asleep) return `${all} sind aus · ${asleep} ${asleep === 1 ? 'schläft' : 'schlafen'}.`;
  return `${all} sind gestoppt.`;
}

/** "nach 15 Min ohne Spieler, weckt beim Verbinden" or "aus". */
export function sleepModeText(
  g: Pick<GameSummary, 'autoStopMinutes' | 'wakeOnConnect'>,
  wake: boolean,
): string {
  if (g.autoStopMinutes <= 0) return 'aus';
  const base = `nach ${g.autoStopMinutes} Min ohne Spieler`;
  return wake && g.wakeOnConnect ? `${base}, weckt beim Verbinden` : base;
}

// ---- schedules -----------------------------------------------------------------------

export const MAX_SCHEDULES = 10;
export const DAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;
export const DAY_LONG = [
  'Montag',
  'Dienstag',
  'Mittwoch',
  'Donnerstag',
  'Freitag',
  'Samstag',
  'Sonntag',
] as const;
export const SCHEDULE_KIND_TEXT: Record<GameSchedule['kind'], string> = {
  restart: 'Neustart',
  backup: 'Backup',
};

/** "täglich", "Mo–Fr", "Sa, So", "Mo, Mi, Fr". */
export function daysText(days: readonly number[]): string {
  const d = [...new Set(days)].filter((x) => x >= 1 && x <= 7).sort((a, b) => a - b);
  if (d.length === 7) return 'täglich';
  if (d.length === 0) return 'nie';
  const isRun = d.length >= 3 && d.every((x, i) => i === 0 || x === (d[i - 1] ?? 0) + 1);
  if (isRun) return `${DAY_SHORT[(d[0] ?? 1) - 1]}–${DAY_SHORT[(d[d.length - 1] ?? 1) - 1]}`;
  return d.map((x) => DAY_SHORT[x - 1]).join(', ');
}

export interface ScheduleDraft {
  kind: GameSchedule['kind'];
  days: number[];
  time: string;
  enabled: boolean;
}

export function scheduleDrafts(list: readonly GameSchedule[]): ScheduleDraft[] {
  return list.map((x) => ({ kind: x.kind, days: [...x.days], time: x.time, enabled: x.enabled }));
}

export const emptySchedule = (): ScheduleDraft => ({
  kind: 'backup',
  days: [1, 2, 3, 4, 5, 6, 7],
  time: '04:00',
  enabled: true,
});

/** "4:00", "04.00" or "0400" -> "04:00"; null when it is no time of day. */
export function normalizeTime(raw: string): string | null {
  const m = /^(\d{1,2})[:.]?(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function toggleDay(days: readonly number[], day: number, on: boolean): number[] {
  const s = new Set(days);
  if (on) s.add(day);
  else s.delete(day);
  return [...s].sort((a, b) => a - b);
}

export type ScheduleErrors = Record<number, string>;

/** Validates the drafts; errors per row index. */
export function validateSchedules(
  drafts: readonly ScheduleDraft[],
): { ok: true; schedules: GameSchedule[] } | { ok: false; errors: ScheduleErrors } {
  const errors: ScheduleErrors = {};
  const out: GameSchedule[] = [];
  if (drafts.length > MAX_SCHEDULES) errors[MAX_SCHEDULES] = `Höchstens ${MAX_SCHEDULES} Einträge.`;
  drafts.forEach((d, i) => {
    const time = normalizeTime(d.time);
    if (!time) errors[i] = 'Uhrzeit als HH:MM, z. B. 04:00.';
    else if (d.days.length === 0) errors[i] = 'Mindestens einen Wochentag wählen.';
    else
      out.push({ kind: d.kind, days: [...d.days].sort((a, b) => a - b), time, enabled: d.enabled });
  });
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, schedules: out };
}

/** "nächster Lauf 23:04" / "nächster Lauf 28.11. 04:00" / "aus". */
export function nextRunText(next: string | null | undefined, now: Date): string {
  if (!next) return 'aus';
  return `nächster Lauf ${formatWhen(new Date(next), now)}`;
}

// ---- Discord ----------------------------------------------------------------------------

export const NOTIFY_EVENTS: readonly GameNotifyEvent[] = ['online', 'offline', 'sleep', 'wake'];
export const NOTIFY_EVENT_TEXT: Record<GameNotifyEvent, string> = {
  online: 'Server ist online',
  offline: 'Server ist offline',
  sleep: 'Server schläft',
  wake: 'Server wurde aufgeweckt',
};

const DISCORD_RE =
  /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d{1,20}\/[A-Za-z0-9_-]{1,100}$/;

export function discordUrlError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Webhook-URL eingeben.';
  if (v.length > 300 || !DISCORD_RE.test(v)) {
    return 'Nur Discord-Webhooks: https://discord.com/api/webhooks/…';
  }
  return null;
}

export function toggleEvent(
  events: readonly GameNotifyEvent[],
  e: GameNotifyEvent,
  on: boolean,
): GameNotifyEvent[] {
  const s = new Set(events);
  if (on) s.add(e);
  else s.delete(e);
  return NOTIFY_EVENTS.filter((x) => s.has(x));
}

// ---- statistics ---------------------------------------------------------------------------

/** "12 h 05 min", "42 min", "0 min". */
export function playtimeText(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

/** Players by play time, longest first; ties by name. */
export function sortPlayers<T extends { name: string; seconds: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name, 'de'));
}

/** Busiest hour of day: "20–21 Uhr · Ø 3,2 Spieler"; null when nobody played. */
export function peakHourText(hours: readonly number[]): string | null {
  let best = -1;
  let max = 0;
  hours.forEach((v, i) => {
    if (v > max) {
      max = v;
      best = i;
    }
  });
  if (best < 0) return null;
  return `${String(best).padStart(2, '0')}–${String((best + 1) % 24).padStart(2, '0')} Uhr · Ø ${formatNumber(max, 1)} Spieler`;
}

/** Peak of the range: "7 Spieler · 23.11. 21:14". */
export function peakText(peak: GameStats['peak'], now: Date): string {
  if (!peak) return 'noch keiner';
  return `${peak.online} Spieler · ${formatWhen(new Date(peak.at), now)}`;
}

/**
 * The 24 hour averages rotated so the series ends with the current hour (the
 * Sparkline marks the last bar). `hour` is the current hour in the display zone.
 */
export function hoursUntilNow(
  hours: readonly number[],
  hour: number,
): { data: number[]; first: number } {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  const first = (h + 1) % 24;
  const data: number[] = [];
  for (let i = 0; i < 24; i++) data.push(hours[(first + i) % 24] ?? 0);
  return { data, first };
}

/** Current hour in the display zone (HZ_TIMEZONE), from "23:04". */
export function displayHour(now: Date): number {
  return Number(formatTime(now).slice(0, 2)) || 0;
}

/** Screen-reader text of the 24-hour bars: only the hours with players. */
export function hoursSummary(hours: readonly number[]): string {
  const parts = hours
    .map((v, i) => (v > 0 ? `${String(i).padStart(2, '0')} Uhr ${formatNumber(v, 1)}` : null))
    .filter((x): x is string => x !== null);
  return parts.length ? `Ø Spieler pro Stunde: ${parts.join(', ')}` : 'Noch keine Spieler.';
}

// ---- whitelist requests ---------------------------------------------------------------------

const REQ_RANK: Record<WhitelistRequest['state'], number> = {
  pending: 0,
  approved: 1,
  rejected: 2,
};

/** Open requests first, then newest first. */
export function sortRequests<T extends Pick<WhitelistRequest, 'state' | 'createdAt'>>(
  list: readonly T[],
): T[] {
  return [...list].sort(
    (a, b) => REQ_RANK[a.state] - REQ_RANK[b.state] || b.createdAt.localeCompare(a.createdAt),
  );
}

export const REQUEST_STATE: Record<WhitelistRequest['state'], { status: Status; text: string }> = {
  pending: { status: 'warn', text: 'offen' },
  approved: { status: 'ok', text: 'bestätigt' },
  rejected: { status: 'off', text: 'abgelehnt' },
};

export function pendingCount(list: readonly Pick<WhitelistRequest, 'state'>[]): number {
  return list.filter((r) => r.state === 'pending').length;
}

// ---- mods ---------------------------------------------------------------------------------

export function modsWord(kind: 'plugins' | 'mods'): { title: string; one: string } {
  return kind === 'plugins' ? { title: 'Plugins', one: 'Plugin' } : { title: 'Mods', one: 'Mod' };
}

/** "1,2 Mio. Downloads", "48.000 Downloads" (rounded), "312 Downloads". */
export function downloadsText(n: number): string {
  if (n >= 1_000_000) return `${formatNumber(n / 1_000_000, 1)} Mio. Downloads`;
  if (n >= 10_000) return `${Math.min(Math.round(n / 1000), 999)}.000 Downloads`;
  return `${formatNumber(n, 0)} Downloads`;
}

// ---- architecture ---------------------------------------------------------------------------

export type DockerArch = 'amd64' | 'arm64';

/** Agent/OS names (x64, x86_64, aarch64 …) -> docker arch; null when unknown. */
export function dockerArch(raw: string | null | undefined): DockerArch | null {
  const a = (raw ?? '').trim().toLowerCase();
  if (a === 'x64' || a === 'x86_64' || a === 'amd64') return 'amd64';
  if (a === 'arm64' || a === 'aarch64' || a === 'armv8' || a === 'arm64/v8') return 'arm64';
  return null;
}

/**
 * Null when the template runs on the server (or the arch is unknown, then the agent
 * decides), otherwise the hint "Läuft nicht auf arm64".
 */
export function archMismatch(
  tpl: Pick<TemplateInfo, 'arch'>,
  server: Pick<ServerSummary, 'arch'> | undefined,
): string | null {
  const a = dockerArch(server?.arch);
  if (!a || tpl.arch.includes(a)) return null;
  return `Läuft nicht auf ${a}`;
}

// ---- network of a server ----------------------------------------------------------------------

export const NETWORK_OPTIONS: readonly { value: ServerNetwork; label: string }[] = [
  { value: 'home', label: 'Zuhause (hinter dem Router)' },
  { value: 'cloud', label: 'Cloud-VM (Firewall des Anbieters)' },
  { value: 'vps', label: 'VPS (Firewall des Anbieters)' },
  { value: 'other', label: 'Anderes' },
];

/** Select value -> network; '' and unknown values clear it (null). */
export function parseNetwork(raw: string): ServerNetwork | null {
  return NETWORK_OPTIONS.find((o) => o.value === raw)?.value ?? null;
}

export const NETWORK_SHORT: Record<ServerNetwork, string> = {
  home: 'zuhause',
  cloud: 'Cloud',
  vps: 'VPS',
  other: 'anderes',
};

/** "23:04" of a datetime, used in short lists. */
export function timeOf(iso: string): string {
  return formatTime(new Date(iso));
}

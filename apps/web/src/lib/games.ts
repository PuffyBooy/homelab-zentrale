import {
  gameBackupListResponseSchema,
  gameEventSchema,
  gameListResponseSchema,
  gameNameSchema,
  gameRconResponseSchema,
  gameResponseSchema,
  gameSuggestResponseSchema,
  gameTemplateListResponseSchema,
  type GameSummary,
  type ServerSummary,
  type TemplateField,
} from '@hz/shared';
import type { GameServerAction, GameServerProps, Status, TerminalLine } from '@hz/ui';
import { api } from './api.js';
import { formatBytes, formatBytesOf, formatNumber, plural } from './format.js';
import type { StatusSentence } from './servers.js';

// ---------------------------------------------------------------------------
// Types (inferred from the schemas in packages/shared/src/api/games.ts)

type Out<S> = S extends { parse(data: unknown): infer T } ? T : never;

export type TemplateInfo = Out<typeof gameTemplateListResponseSchema>['templates'][number];
export type TemplatePort = TemplateInfo['ports'][number];
export type GameSuggest = Out<typeof gameSuggestResponseSchema>;
export type GameBackup = Out<typeof gameBackupListResponseSchema>['backups'][number];
export type GameEvent = Out<typeof gameEventSchema>;
export type FieldValue = string | number | boolean;
export type GameAction = 'start' | 'stop' | 'restart' | 'backup';
export type Protocol = TemplatePort['protocol'];

export interface GameCreateBody {
  templateId: string;
  serverId: string;
  name: string;
  values: Record<string, FieldValue>;
  ports: Record<string, number>;
  autoStopMinutes: number;
  externalAddress: string;
}

export interface GameUpdateBody {
  values: Record<string, FieldValue>;
  autoStopMinutes: number;
  /** Left out: unchanged. */
  externalAddress?: string;
}

// ---------------------------------------------------------------------------
// Query keys and REST calls (routes from packages/shared/src/api/games.ts)

export const gamesKey = ['games'] as const;
export const templatesKey = ['games', 'templates'] as const;
export const suggestKey = (templateId: string, serverId: string) =>
  ['games', 'suggest', templateId, serverId] as const;
export const backupsKey = (id: string) => ['games', 'backups', id] as const;
export const gameEventsKey = (id: string) => ['game-events', id] as const;

const enc = encodeURIComponent;

export async function fetchGames(signal?: AbortSignal): Promise<GameSummary[]> {
  const res = await api('/api/games', { schema: gameListResponseSchema, signal });
  return res.games;
}

export async function fetchTemplates(signal?: AbortSignal): Promise<TemplateInfo[]> {
  const res = await api('/api/games/templates', { schema: gameTemplateListResponseSchema, signal });
  return res.templates;
}

export function fetchSuggest(
  templateId: string,
  serverId: string,
  signal?: AbortSignal,
): Promise<GameSuggest> {
  const q = new URLSearchParams({ templateId, serverId });
  return api(`/api/games/suggest?${q.toString()}`, { schema: gameSuggestResponseSchema, signal });
}

/** 202: the setup runs, progress comes on topic `game:<id>`. */
export async function createGame(body: GameCreateBody): Promise<GameSummary> {
  const res = await api('/api/games', { method: 'POST', body, schema: gameResponseSchema });
  return res.game;
}

/** Settings; the core restarts the game with the new values. */
export async function updateGame(id: string, body: GameUpdateBody): Promise<GameSummary> {
  const res = await api(`/api/games/${enc(id)}`, {
    method: 'PUT',
    body,
    schema: gameResponseSchema,
  });
  return res.game;
}

export async function gameAction(id: string, action: GameAction): Promise<GameSummary> {
  const res = await api(`/api/games/${enc(id)}/${action}`, {
    method: 'POST',
    body: {},
    schema: gameResponseSchema,
  });
  return res.game;
}

/** Danger: backup first, then compose down and remove. Step-up comes from api(). */
export async function deleteGame(id: string, confirmName: string): Promise<void> {
  await api(`/api/games/${enc(id)}`, {
    method: 'DELETE',
    body: { confirmName },
    schema: { parse: (d: unknown) => d },
  });
}

export async function sendRcon(id: string, command: string): Promise<string> {
  const res = await api(`/api/games/${enc(id)}/rcon`, {
    method: 'POST',
    body: { command },
    schema: gameRconResponseSchema,
  });
  return res.output;
}

export async function fetchBackups(id: string, signal?: AbortSignal): Promise<GameBackup[]> {
  const res = await api(`/api/games/${enc(id)}/backups`, {
    schema: gameBackupListResponseSchema,
    signal,
  });
  return res.backups;
}

// ---------------------------------------------------------------------------
// Status texts (pure, unit tested)

const STATUS_RANK: Record<GameSummary['status'], number> = {
  crit: 0,
  warn: 1,
  busy: 2,
  ok: 3,
  off: 4,
};

/** Problems first (crit, warn), then setups, running, stopped; then by name. */
export function sortGames<T extends Pick<GameSummary, 'status' | 'name'>>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name, 'de'),
  );
}

export function isGameRunning(g: Pick<GameSummary, 'status'>): boolean {
  return g.status === 'ok' || g.status === 'warn';
}

export function playersOnline(list: readonly Pick<GameSummary, 'players'>[]): number {
  return list.reduce((n, g) => n + (g.players?.online ?? 0), 0);
}

function gameCount(n: number): string {
  return plural(n, 'Gameserver', 'Gameserver');
}

/** Statussatz for /games: problems first, then setups, then what runs. */
export function gamesSentence(games: readonly GameSummary[]): StatusSentence {
  if (games.length === 0) return { em: null, rest: 'Noch keine Gameserver.' };
  const total = ` · ${gameCount(games.length)}`;
  for (const level of ['crit', 'warn'] as const) {
    const bad = games.filter((g) => g.status === level);
    const first = bad[0];
    if (first) {
      const em =
        bad.length === 1
          ? `${first.name}: ${first.statusText}`
          : level === 'crit'
            ? `${bad.length} Gameserver ausgefallen`
            : `${bad.length} Gameserver mit Warnung`;
      return { em, rest: total };
    }
  }
  const busy = games.filter((g) => g.status === 'busy');
  const firstBusy = busy[0];
  if (firstBusy) {
    const what =
      busy.length === 1
        ? `${firstBusy.name}: ${firstBusy.statusText}`
        : `${busy.map((g) => g.name).join(', ')} beschäftigt`;
    return { em: null, rest: `${what}${total}` };
  }
  const running = games.filter(isGameRunning);
  if (running.length === 0) {
    return {
      em: null,
      rest:
        games.length === 1 ? 'Gameserver gestoppt.' : `Alle ${games.length} Gameserver gestoppt.`,
    };
  }
  const players = playersOnline(running);
  const who = players ? ` · ${plural(players, 'Spieler', 'Spieler')} online` : '';
  if (running.length === games.length) {
    return {
      em: null,
      rest: `${games.length === 1 ? 'Gameserver läuft' : `Alle ${games.length} Gameserver laufen`}${who}`,
    };
  }
  return {
    em: null,
    rest: `${running.length} von ${games.length} Gameservern ${running.length === 1 ? 'läuft' : 'laufen'}${who}`,
  };
}

/** Statussatz for one game (detail page). */
export function gameSentence(g: GameSummary): StatusSentence {
  if (g.status === 'crit' || g.status === 'warn') {
    return { em: `${g.name}: ${g.statusText}`, rest: ` · ${g.serverName}` };
  }
  if (g.status === 'busy') return { em: null, rest: `${g.name}: ${g.statusText}` };
  if (g.status === 'off') return { em: null, rest: `${g.name} ist gestoppt.` };
  const p = g.players;
  return {
    em: null,
    rest: p
      ? `${g.name} läuft · ${p.online} von ${p.max} ${p.max === 1 ? 'Spieler' : 'Spielern'} online`
      : `${g.name} läuft.`,
  };
}

/** Max players from the template values (e.g. MAX_PLAYERS) while nobody is queried. */
function maxPlayersOf(values: GameSummary['values']): number {
  const v = values.MAX_PLAYERS ?? values.MAXPLAYERS ?? values.MAX_PLAYER;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** "5,8 / 8 GB", "— / 8 GB" or "—". */
export function ramDetail(g: Pick<GameSummary, 'ramBytes' | 'ramLimitBytes'>): string {
  if (g.ramLimitBytes != null && g.ramLimitBytes > 0) {
    if (g.ramBytes == null) return `— / ${formatBytes(g.ramLimitBytes)}`;
    return formatBytesOf(g.ramBytes, g.ramLimitBytes);
  }
  return formatBytes(g.ramBytes);
}

export function ramPercent(g: Pick<GameSummary, 'ramBytes' | 'ramLimitBytes'>): number {
  if (g.ramBytes == null || !g.ramLimitBytes) return 0;
  return Math.max(0, Math.min(100, (g.ramBytes / g.ramLimitBytes) * 100));
}

/** "19,8": one decimal, Austrian comma. */
export function tpsText(tps: number | null): string {
  return tps == null ? '—' : formatNumber(tps, 1);
}

/** Props for the GameServer tile, without handlers. */
export function gameTileProps(
  g: GameSummary,
): Pick<
  GameServerProps,
  | 'name'
  | 'game'
  | 'version'
  | 'address'
  | 'status'
  | 'players'
  | 'ram'
  | 'ramDetail'
  | 'tps'
  | 'tpsDetail'
  | 'online'
  | 'host'
> {
  return {
    name: g.name,
    game: g.game,
    version: g.version ?? undefined,
    address: g.address,
    status: g.status as Status,
    players: g.players ? [g.players.online, g.players.max] : [0, maxPlayersOf(g.values)],
    ram: ramPercent(g),
    ramDetail: ramDetail(g),
    tps: g.tps,
    tpsDetail: tpsText(g.tps),
    online: g.players?.names ?? [],
    host: g.serverName,
  };
}

/**
 * Footer buttons that do nothing right now: during setup, restart or backup (busy)
 * start/stop/restart wait; "Teilen" comes with the share links (M7).
 */
export function disabledTileActions(g: Pick<GameSummary, 'status'>): GameServerAction[] {
  const out: GameServerAction[] = ['share'];
  if (g.status === 'busy') out.push('start', 'stop', 'restart');
  return out;
}

export const ACTION_TEXT: Record<GameAction, { verb: string; done: string }> = {
  start: { verb: 'Starten', done: 'startet' },
  stop: { verb: 'Stoppen', done: 'wird gestoppt' },
  restart: { verb: 'Neu starten', done: 'startet neu' },
  backup: { verb: 'Backup jetzt', done: 'Backup läuft' },
};

// ---------------------------------------------------------------------------
// Templates, ports and the port-forwarding hint

const RAM_RE = /^(\d{1,3})G$/;

/** "4G" -> 4 GiB in bytes. */
export function ramBytesOf(ram: string): number {
  const m = RAM_RE.exec(ram);
  return m?.[1] ? Number(m[1]) * 1024 ** 3 : 0;
}

/** "4–6 GB" or "2 GB". */
export function ramRange(ram: TemplateInfo['ram']): string {
  const a = RAM_RE.exec(ram.min)?.[1];
  const b = RAM_RE.exec(ram.recommended)?.[1];
  if (!a || !b) return ram.recommended;
  return a === b ? `${a} GB` : `${a}–${b} GB`;
}

const PROTO_TEXT: Record<Protocol, string> = {
  tcp: 'TCP',
  udp: 'UDP',
  'tcp+udp': 'TCP und UDP',
};

export function protocolText(p: Protocol): string {
  return PROTO_TEXT[p];
}

/** "25565" or "2456–2458". */
export function portRange(port: number, count = 1): string {
  return count > 1 ? `${port}–${port + count - 1}` : String(port);
}

/** "25565/TCP", "2456–2458/UDP", "27015/TCP und UDP". */
export function portLabel(port: number, protocol: Protocol, count = 1): string {
  return `${portRange(port, count)}/${PROTO_TEXT[protocol]}`;
}

export interface ForwardRule {
  name: string;
  ports: string;
  protocol: string;
}

/** Rules for the router or the security list, one per template port. */
export function forwardRules(
  ports: readonly { name: string; port: number; protocol: Protocol; count?: number | undefined }[],
): ForwardRule[] {
  return ports.map((p) => ({
    name: p.name,
    ports: portRange(p.port, p.count ?? 1),
    protocol: PROTO_TEXT[p.protocol],
  }));
}

/** Game ports from the summary, with the template count (Valheim 2456–2458). */
export function gamePorts(
  g: Pick<GameSummary, 'ports'>,
  tpl: Pick<TemplateInfo, 'ports'> | undefined,
): { name: string; port: number; protocol: Protocol; count: number }[] {
  return g.ports.map((p) => ({
    ...p,
    count: tpl?.ports.find((t) => t.name === p.name)?.count ?? 1,
  }));
}

export type ForwardPlace = 'home' | 'oracle' | 'unknown';

/**
 * Where the ports have to be opened. Oracle Cloud VMs need a Security List rule,
 * servers at home a port forwarding on the Deco router. Guessed from name and location;
 * when nothing fits, both hints are shown (docs/QUESTIONS.md, M6 Web).
 */
export function forwardPlace(
  s: Pick<ServerSummary, 'name' | 'location'> | undefined,
): ForwardPlace {
  if (!s) return 'unknown';
  const text = `${s.name} ${s.location}`.toLowerCase();
  if (/oracle|\boci\b|oci-/.test(text)) return 'oracle';
  if (/heim|zuhause|daheim|home|wien|studio/.test(text)) return 'home';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Form generator for template fields (create and settings)

/** Draft of the field inputs: text, number and select as strings, boolean as boolean. */
export type FieldDraft = Record<string, string | boolean>;
export type FieldErrors = Record<string, string>;

export function fieldDefaults(fields: readonly TemplateField[]): FieldDraft {
  const out: FieldDraft = {};
  for (const f of fields) {
    out[f.key] = f.type === 'boolean' ? f.default : String(f.default);
  }
  return out;
}

/** Draft from saved values (settings form); missing keys fall back to the defaults. */
export function draftFromValues(
  fields: readonly TemplateField[],
  values: Readonly<Record<string, FieldValue>>,
): FieldDraft {
  const out = fieldDefaults(fields);
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined) continue;
    if (f.type === 'boolean') out[f.key] = v === true || v === 'true';
    else if (f.type === 'number')
      out[f.key] = typeof v === 'number' ? formatNumber(v, 6) : String(v);
    else out[f.key] = String(v);
  }
  return out;
}

function anchored(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${pattern})$`);
  } catch {
    return null;
  }
}

/** "1–100", "ab 1", "bis 100". */
function rangeText(min: number | undefined, max: number | undefined): string {
  const n = (v: number): string => formatNumber(v, 6);
  if (min != null && max != null) return `Zahl von ${n(min)} bis ${n(max)}.`;
  if (min != null) return `Zahl ab ${n(min)}.`;
  if (max != null) return `Zahl bis ${n(max)}.`;
  return 'Zahl eingeben.';
}

/** "20", "1,5" or "1.5" -> number; anything else NaN. */
export function parseNumber(raw: string): number {
  const t = raw.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return Number.NaN;
  return Number(t);
}

/**
 * Validates the draft against the template fields. Only template keys are sent
 * (the core rejects unknown keys). Empty optional numbers are left out.
 */
export function validateFields(
  fields: readonly TemplateField[],
  draft: Readonly<FieldDraft>,
): { values: Record<string, FieldValue>; errors: FieldErrors } {
  const values: Record<string, FieldValue> = {};
  const errors: FieldErrors = {};
  for (const f of fields) {
    const raw = draft[f.key];
    switch (f.type) {
      case 'boolean':
        values[f.key] = typeof raw === 'boolean' ? raw : f.default;
        break;
      case 'select': {
        const v = typeof raw === 'string' ? raw : f.default;
        if (!f.options.includes(v)) errors[f.key] = 'Bitte einen Eintrag aus der Liste wählen.';
        else values[f.key] = v;
        break;
      }
      case 'number': {
        const s = typeof raw === 'string' ? raw.trim() : String(f.default);
        if (!s) {
          if (!f.optional) errors[f.key] = rangeText(f.min, f.max);
          break;
        }
        const n = parseNumber(s);
        if (!Number.isFinite(n) || (f.min != null && n < f.min) || (f.max != null && n > f.max)) {
          errors[f.key] = rangeText(f.min, f.max);
        } else values[f.key] = n;
        break;
      }
      case 'text': {
        const v = typeof raw === 'string' ? raw.trim() : f.default;
        if (!v) {
          if (!f.optional) errors[f.key] = 'Pflichtfeld.';
          else values[f.key] = '';
          break;
        }
        if (v.length > 200) {
          errors[f.key] = 'Höchstens 200 Zeichen.';
          break;
        }
        if (/[\r\n\0]/.test(v)) {
          errors[f.key] = 'Nur eine Zeile.';
          break;
        }
        const re = f.pattern ? anchored(f.pattern) : null;
        if (re && !re.test(v)) {
          errors[f.key] = 'Format passt nicht.';
          break;
        }
        values[f.key] = v;
        break;
      }
    }
  }
  return { values, errors };
}

// ---------------------------------------------------------------------------
// Create and settings forms

export interface CreateDraft {
  name: string;
  serverId: string;
  /** Port per template port name, as typed. */
  ports: Record<string, string>;
  autoStopMinutes: string;
  externalAddress: string;
  fields: FieldDraft;
}

/** Flat error map: `name`, `serverId`, `autoStopMinutes`, `externalAddress`, `port:<name>`, `field:<KEY>`. */
export type CreateErrors = Record<string, string>;

export function emptyCreateDraft(tpl: TemplateInfo, serverId = ''): CreateDraft {
  const ports: Record<string, string> = {};
  for (const p of tpl.ports) ports[p.name] = String(p.default);
  return {
    name: '',
    serverId,
    ports,
    autoStopMinutes: '0',
    externalAddress: '',
    fields: fieldDefaults(tpl.fields),
  };
}

/** Default name from the template id: "minecraft-java" -> "minecraft-java", unique on the server. */
export function suggestName(tpl: Pick<TemplateInfo, 'id'>, taken: readonly string[]): string {
  const base = tpl.id.slice(0, 29).replace(/-+$/, '');
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 100; i++) {
    const n = `${base}-${i}`;
    if (!taken.includes(n)) return n;
  }
  return base;
}

const ADDRESS_RE =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?::\d{1,5})?$/;

/** Empty, a host name or an IPv4 address, optionally with ":port". */
export function externalAddressError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.length > 253 || !ADDRESS_RE.test(v)) {
    return 'Hostname oder IP, optional mit :Port, z. B. mc.hoebe.at.';
  }
  return null;
}

export function autoStopError(raw: string): string | null {
  const n = parseNumber(raw || '0');
  if (!Number.isInteger(n) || n < 0 || n > 1440) return 'Ganze Minuten von 0 bis 1440 (0 = aus).';
  return null;
}

/** Port inputs: whole numbers 1024–65535, ranges inside, no overlap between template ports. */
export function validatePorts(
  ports: readonly TemplatePort[],
  draft: Readonly<Record<string, string>>,
): { ports: Record<string, number>; errors: CreateErrors } {
  const out: Record<string, number> = {};
  const errors: CreateErrors = {};
  const used: { name: string; from: number; to: number }[] = [];
  for (const p of ports) {
    const raw = (draft[p.name] ?? String(p.default)).trim();
    const n = parseNumber(raw);
    const last = n + p.count - 1;
    if (!Number.isInteger(n) || n < 1024 || last > 65535) {
      errors[`port:${p.name}`] =
        p.count > 1 ? `Port von 1024 bis ${65535 - p.count + 1}.` : 'Port von 1024 bis 65535.';
      continue;
    }
    if (used.some((u) => n <= u.to && last >= u.from)) {
      errors[`port:${p.name}`] = 'Port doppelt belegt.';
      continue;
    }
    used.push({ name: p.name, from: n, to: last });
    out[p.name] = n;
  }
  return { ports: out, errors };
}

/** Validates the whole create form. `taken`: game names already on the chosen server. */
export function validateCreate(
  tpl: TemplateInfo,
  draft: CreateDraft,
  taken: readonly string[] = [],
): { ok: true; body: GameCreateBody } | { ok: false; errors: CreateErrors } {
  const errors: CreateErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'Name eingeben.';
  else if (!gameNameSchema.safeParse(name).success) {
    errors.name = 'Nur Kleinbuchstaben, Ziffern und Bindestrich (2–32 Zeichen).';
  } else if (taken.includes(name)) errors.name = 'Diesen Namen gibt es auf dem Server schon.';
  if (!draft.serverId) errors.serverId = 'Server auswählen.';
  const ports = validatePorts(tpl.ports, draft.ports);
  Object.assign(errors, ports.errors);
  const stop = autoStopError(draft.autoStopMinutes);
  if (stop) errors.autoStopMinutes = stop;
  const addr = externalAddressError(draft.externalAddress);
  if (addr) errors.externalAddress = addr;
  const fields = validateFields(tpl.fields, draft.fields);
  for (const [k, v] of Object.entries(fields.errors)) errors[`field:${k}`] = v;
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      templateId: tpl.id,
      serverId: draft.serverId,
      name,
      values: fields.values,
      ports: ports.ports,
      autoStopMinutes: parseNumber(draft.autoStopMinutes || '0'),
      externalAddress: draft.externalAddress.trim(),
    },
  };
}

export interface SettingsDraft {
  autoStopMinutes: string;
  externalAddress: string;
  fields: FieldDraft;
}

/** External address as typed by the admin: the summary shows host:port, keep only the host part. */
export function settingsDraft(g: GameSummary, tpl: Pick<TemplateInfo, 'fields'>): SettingsDraft {
  return {
    autoStopMinutes: String(g.autoStopMinutes),
    externalAddress: '',
    fields: draftFromValues(tpl.fields, g.values),
  };
}

export function validateSettings(
  tpl: Pick<TemplateInfo, 'fields'>,
  draft: SettingsDraft,
): { ok: true; body: GameUpdateBody } | { ok: false; errors: CreateErrors } {
  const errors: CreateErrors = {};
  const stop = autoStopError(draft.autoStopMinutes);
  if (stop) errors.autoStopMinutes = stop;
  const addr = externalAddressError(draft.externalAddress);
  if (addr) errors.externalAddress = addr;
  const fields = validateFields(tpl.fields, draft.fields);
  for (const [k, v] of Object.entries(fields.errors)) errors[`field:${k}`] = v;
  if (Object.keys(errors).length) return { ok: false, errors };
  const ext = draft.externalAddress.trim();
  return {
    ok: true,
    body: {
      values: fields.values,
      autoStopMinutes: parseNumber(draft.autoStopMinutes || '0'),
      ...(ext ? { externalAddress: ext } : {}),
    },
  };
}

/** Error map without one key (same object when the key is not there). */
export function withoutError(errors: CreateErrors, key: string): CreateErrors {
  if (!(key in errors)) return errors;
  return Object.fromEntries(Object.entries(errors).filter(([k]) => k !== key));
}

/** Delete confirmation: the exact name, surrounding spaces ignored. */
export function deleteConfirmed(typed: string, name: string): boolean {
  return typed.trim() === name;
}

/** "Auto-Stopp nach 30 Min ohne Spieler" or "aus". */
export function autoStopText(minutes: number): string {
  return minutes > 0 ? `nach ${minutes} Min ohne Spieler` : 'aus';
}

// ---------------------------------------------------------------------------
// Live events of topic `game:<id>` (setup/backup progress, console lines)

export const MAX_GAME_EVENTS = 2000;

export interface GameEventBuffer {
  events: GameEvent[];
  /** True once a snapshot arrived. */
  complete: boolean;
}

export const emptyGameEvents: GameEventBuffer = { events: [], complete: false };

/** Applies topic items (gameEventSchema); invalid items are dropped, ids deduplicated. */
export function applyGameEvents(
  prev: GameEventBuffer,
  items: readonly unknown[],
  snapshot = false,
): GameEventBuffer {
  const events = snapshot ? [] : [...prev.events];
  const seen = new Set(events.map((e) => e.id));
  for (const raw of items) {
    const ev = gameEventSchema.safeParse(raw);
    if (!ev.success || seen.has(ev.data.id)) continue;
    seen.add(ev.data.id);
    events.push(ev.data);
  }
  return {
    events: events.length > MAX_GAME_EVENTS ? events.slice(-MAX_GAME_EVENTS) : events,
    complete: prev.complete || snapshot,
  };
}

/** Snapshot data: a list of events or `{ events }`. */
export function gameSnapshotToBuffer(data: unknown): GameEventBuffer | null {
  if (Array.isArray(data)) return applyGameEvents(emptyGameEvents, data, true);
  if (data && typeof data === 'object') {
    const list = (data as Record<string, unknown>).events;
    if (Array.isArray(list)) return applyGameEvents(emptyGameEvents, list, true);
  }
  return null;
}

function splitLines(text: string): string[] {
  const parts = text.replace(/\r\n/g, '\n').split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

const EVENT_KIND: Record<GameEvent['kind'], TerminalLine['kind']> = {
  progress: undefined,
  console: undefined,
  ready: 'ok',
  error: 'err',
};

/** Setup progress: progress, ready and error events as Terminal lines. */
export function progressLines(events: readonly GameEvent[]): TerminalLine[] {
  const out: TerminalLine[] = [];
  for (const e of events) {
    if (e.kind === 'console') continue;
    const kind = EVENT_KIND[e.kind];
    for (const text of splitLines(e.text)) out.push(kind ? { text, kind } : { text });
  }
  return out;
}

export type SetupState = 'none' | 'running' | 'ready' | 'error';

/** State of the last setup in the buffer: the last ready/error after the last progress. */
export function setupState(events: readonly GameEvent[]): SetupState {
  let state: SetupState = 'none';
  for (const e of events) {
    if (e.kind === 'progress') state = 'running';
    else if (e.kind === 'ready') state = 'ready';
    else if (e.kind === 'error') state = 'error';
  }
  return state;
}

/** Last error text, for the Alert after a failed setup. */
export function lastError(events: readonly GameEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind === 'error') return e.text;
  }
  return null;
}

// ---- RCON console ---------------------------------------------------------------

/** A command typed here and its answer (the rcon response), with the local time. */
export interface ConsoleEntry {
  id: string;
  ts: string;
  command: string;
  output: string | null;
  error: string | null;
}

/**
 * Console events of the topic and own commands, in time order. The core echoes an RCON
 * command as a console event "> <command>" followed by the output; once that echo is
 * there, the local entry is hidden so nothing shows twice. Pending and failed commands
 * stay local.
 */
export function consoleLines(
  events: readonly GameEvent[],
  entries: readonly ConsoleEntry[],
): TerminalLine[] {
  type Item = { ts: string; order: number; lines: TerminalLine[] };
  const items: Item[] = [];
  let order = 0;
  const echoes: { ts: string; command: string; used: boolean }[] = [];
  for (const e of events) {
    if (e.kind !== 'console') continue;
    const echo = /^> (.*)$/s.exec(e.text);
    if (echo?.[1] !== undefined) {
      echoes.push({ ts: e.ts, command: echo[1].trim(), used: false });
      items.push({ ts: e.ts, order: order++, lines: [{ text: echo[1], kind: 'cmd' }] });
      continue;
    }
    items.push({ ts: e.ts, order: order++, lines: splitLines(e.text).map((text) => ({ text })) });
  }
  for (const c of entries) {
    if (c.output !== null && !c.error) {
      const echo = echoes.find((x) => !x.used && x.command === c.command);
      if (echo) {
        echo.used = true;
        continue;
      }
    }
    const lines: TerminalLine[] = [{ text: c.command, kind: 'cmd' }];
    if (c.error) lines.push({ text: c.error, kind: 'err' });
    else if (c.output === null) lines.push({ text: '…', kind: 'dim' });
    else if (c.output.trim() === '') lines.push({ text: '(keine Ausgabe)', kind: 'dim' });
    else lines.push(...splitLines(c.output).map((text) => ({ text })));
    items.push({ ts: c.ts, order: order++, lines });
  }
  items.sort((a, b) => a.ts.localeCompare(b.ts) || a.order - b.order);
  const out = items.flatMap((i) => i.lines);
  return out.length > MAX_GAME_EVENTS ? out.slice(-MAX_GAME_EVENTS) : out;
}

export const MAX_HISTORY = 50;

/** Adds a command to the history (oldest first), without direct repeats. */
export function pushHistory(history: readonly string[], command: string): string[] {
  const c = command.trim();
  if (!c) return [...history];
  const next = history[history.length - 1] === c ? [...history] : [...history, c];
  return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
}

/**
 * Arrow keys in the command line. `index` = history.length means the line being typed
 * (`draft`). Up goes to older commands, down back to newer ones and finally the draft.
 */
export function historyStep(
  history: readonly string[],
  index: number,
  dir: 'up' | 'down',
  draft: string,
): { index: number; value: string } {
  const len = history.length;
  const i = dir === 'up' ? Math.max(0, index - 1) : Math.min(len, index + 1);
  if (len === 0) return { index: 0, value: draft };
  return { index: i, value: i >= len ? draft : (history[i] ?? draft) };
}

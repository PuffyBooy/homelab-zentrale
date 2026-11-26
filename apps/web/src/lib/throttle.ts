import {
  CPUS_MAX,
  CPUS_MIN,
  DEFAULT_PRIORITY,
  MAX_SCHEDULE_WINDOWS,
  containerActionResponseSchema,
  containerPriorityResponseSchema,
  gamePriorityResponseSchema,
  serverThrottleResponseSchema,
  topConsumersResponseSchema,
  type ContainerPriorityResponse,
  type ContainerSummary,
  type GamePriorityResponse,
  type InsufficientRamDetails,
  type Priority,
  type ScheduleWindow,
  type ServerThrottleResponse,
  type ServerThrottleUpdateRequest,
  type ThrottlePhase,
  type ThrottleSettings,
  type ThrottleSettingsPatch,
  type Throttled,
  type TopConsumer,
  type TopConsumersResponse,
  type Weekday,
} from '@hz/shared';
import { api } from './api.js';
import { formatBytes, formatNumber, formatTime } from './format.js';

/**
 * M10 (SPEC 6a): priorities, manual and automatic throttling, per-server
 * settings, schedules and the "Wer frisst gerade?" tile. Pure helpers are unit
 * tested; the fetchers go through api() (same origin, schema checked).
 */

const enc = encodeURIComponent;

export const topConsumersKey = ['overview', 'top-consumers'] as const;
export const serverThrottleKey = (serverId: string) => ['servers', serverId, 'throttle'] as const;

// ---------------------------------------------------------------------------
// Fetchers

export function fetchTopConsumers(signal?: AbortSignal): Promise<TopConsumersResponse> {
  return api('/api/overview/top-consumers', { schema: topConsumersResponseSchema, signal });
}

export function fetchServerThrottle(
  serverId: string,
  signal?: AbortSignal,
): Promise<ServerThrottleResponse> {
  return api(`/api/servers/${enc(serverId)}/throttle`, {
    schema: serverThrottleResponseSchema,
    signal,
  });
}

export function updateServerThrottle(
  serverId: string,
  body: ServerThrottleUpdateRequest,
): Promise<ServerThrottleResponse> {
  return api(`/api/servers/${enc(serverId)}/throttle`, {
    method: 'PUT',
    body,
    schema: serverThrottleResponseSchema,
  });
}

export interface ContainerPriorityBody {
  priority: Priority;
  allowStop: boolean;
}

export interface GamePriorityBody extends ContainerPriorityBody {
  allowStopWithPlayers: boolean;
}

export function saveContainerPriority(
  id: string,
  body: ContainerPriorityBody,
): Promise<ContainerPriorityResponse> {
  return api(`/api/containers/${enc(id)}/priority`, {
    method: 'PUT',
    body,
    schema: containerPriorityResponseSchema,
  });
}

export function saveGamePriority(
  id: string,
  body: GamePriorityBody,
): Promise<GamePriorityResponse> {
  return api(`/api/games/${enc(id)}/priority`, {
    method: 'PUT',
    body,
    schema: gamePriorityResponseSchema,
  });
}

export function throttleContainer(
  id: string,
  cpus: number,
): Promise<{ ok: true; container: ContainerSummary | null }> {
  return api(`/api/containers/${enc(id)}/throttle`, {
    method: 'POST',
    body: { cpus },
    schema: containerActionResponseSchema,
  });
}

export function unthrottleContainer(
  id: string,
): Promise<{ ok: true; container: ContainerSummary | null }> {
  return api(`/api/containers/${enc(id)}/unthrottle`, {
    method: 'POST',
    body: {},
    schema: containerActionResponseSchema,
  });
}

// ---------------------------------------------------------------------------
// Priority

export const PRIORITY_OPTIONS: readonly { value: Priority; label: string }[] = [
  { value: 'wichtig', label: 'wichtig: läuft immer, wird neu gestartet' },
  { value: 'normal', label: 'normal: wird nicht angefasst' },
  { value: 'niedrig', label: 'niedrig: darf gedrosselt werden' },
];

export function isPriority(v: string): v is Priority {
  return v === 'wichtig' || v === 'normal' || v === 'niedrig';
}

/** "darf gestoppt werden" only with niedrig, "auch mit Spielern" only with allowStop. */
export function priorityBody(
  priority: Priority,
  allowStop: boolean,
  allowStopWithPlayers = false,
): GamePriorityBody {
  const stop = priority === 'niedrig' && allowStop;
  return { priority, allowStop: stop, allowStopWithPlayers: stop && allowStopWithPlayers };
}

/** One line for lists and detail: "niedrig · darf gestoppt werden". */
export function priorityText(p: {
  priority: Priority;
  allowStop: boolean;
  allowStopWithPlayers?: boolean;
  protected?: boolean;
}): string {
  if (p.protected) return 'Zentrale/Agent: immer wichtig';
  if (p.priority !== 'niedrig' || !p.allowStop) return p.priority;
  return p.allowStopWithPlayers
    ? 'niedrig · darf gestoppt werden, auch mit Spielern'
    : 'niedrig · darf gestoppt werden';
}

export { DEFAULT_PRIORITY };

// ---------------------------------------------------------------------------
// Cores and throttle state

/** "1 Kern", "0,5 Kerne", "2 Kerne". */
export function formatCores(cpus: number): string {
  return `${formatNumber(cpus, 2)} ${cpus === 1 ? 'Kern' : 'Kerne'}`;
}

/** Badge text in lists: "gedrosselt (1 Kern)". */
export function throttleBadge(t: Pick<Throttled, 'cpus'>): string {
  return `gedrosselt (${formatCores(t.cpus)})`;
}

export const AUTO_STOPPED_TEXT = 'automatisch gestoppt';

export const BY_TEXT: Record<Throttled['by'], string> = {
  auto: 'Automatik',
  admin: 'von Hand',
  schedule: 'Zeitplan',
};

/** Detail line (tooltip): "gedrosselt auf 1 Kern seit 23:04 · heimserver CPU 96 % seit 2 Min". */
export function throttleDetail(t: Throttled): string {
  return `gedrosselt auf ${formatCores(t.cpus)} seit ${formatTime(new Date(t.since))} · ${
    t.reason || BY_TEXT[t.by]
  }`;
}

/** Parses "1", "0,5" or "1.5" (de-AT comma) into --cpus, or an error text. */
export function parseCpus(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const t = raw.trim().replace(',', '.');
  const err = `Zahl von ${formatNumber(CPUS_MIN, 1)} bis ${formatNumber(CPUS_MAX, 0)}.`;
  if (!/^\d+(?:\.\d+)?$/.test(t)) return { ok: false, error: err };
  const n = Number(t);
  if (!Number.isFinite(n) || n < CPUS_MIN || n > CPUS_MAX) return { ok: false, error: err };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** Number for an input field: 1.5 -> "1,5". */
export function cpusInput(cpus: number): string {
  return formatNumber(cpus, 2);
}

// ---------------------------------------------------------------------------
// RAM reserve: insufficient_ram

const GIB = 1024 ** 3;

/** Always in GB with at most one decimal: "7,8 GB", "0 GB". */
export function formatGb(bytes: number): string {
  return `${formatNumber(Math.max(0, bytes) / GIB, 1)} GB`;
}

/** "Zu wenig RAM, 1,5 GB frei" with free = max(0, freeBytes - reserveBytes). */
export function insufficientRamText(d: InsufficientRamDetails | undefined): string {
  if (!d) return 'Zu wenig RAM auf dem Server.';
  return `Zu wenig RAM, ${formatGb(Math.max(0, d.freeBytes - d.reserveBytes))} frei`;
}

// ---------------------------------------------------------------------------
// Top consumers

/** Which buttons a row of "Wer frisst gerade?" offers. Protected entries: none. */
export function consumerActions(c: Pick<TopConsumer, 'protected' | 'throttled'>): {
  throttle: boolean;
  unthrottle: boolean;
  stop: boolean;
} {
  if (c.protected) return { throttle: false, unthrottle: false, stop: false };
  return { throttle: !c.throttled, unthrottle: !!c.throttled, stop: true };
}

/** Keeps only the entries of one server (ServerSwitch), or all. */
export function consumersOf(res: TopConsumersResponse, serverId?: string): TopConsumersResponse {
  if (!serverId) return res;
  return {
    ...res,
    byCpu: res.byCpu.filter((c) => c.serverId === serverId),
    byRam: res.byRam.filter((c) => c.serverId === serverId),
  };
}

// ---------------------------------------------------------------------------
// Server settings ("Automatik")

const PHASE_STATUS: Record<ThrottlePhase, 'ok' | 'warn' | 'info' | 'off'> = {
  idle: 'ok',
  over: 'warn',
  throttled: 'warn',
  recovering: 'info',
  disabled: 'off',
};

export function phaseStatus(phase: ThrottlePhase): 'ok' | 'warn' | 'info' | 'off' {
  return PHASE_STATUS[phase];
}

/** Status first: "Über der Schwelle seit 23:04 · drosselt nach 2 Min". */
export function phaseText(
  status: ServerThrottleResponse['status'],
  settings: ThrottleSettings,
): string {
  const since = status.since ? ` seit ${formatTime(new Date(status.since))}` : '';
  switch (status.phase) {
    case 'disabled':
      return 'Automatik aus. Nichts wird gedrosselt oder gestoppt.';
    case 'idle':
      return 'Unter den Schwellen. Nichts gedrosselt.';
    case 'over':
      return `Über der Schwelle${since} · drosselt nach ${formatNumber(settings.forMinutes, 0)} Min`;
    case 'throttled':
      return `Gedrosselt${since} · stoppt nach weiteren ${formatNumber(settings.stopAfterMinutes, 0)} Min (nur „darf gestoppt werden“)`;
    case 'recovering':
      return `Erholt sich${since} · hebt nach ${formatNumber(settings.recoverMinutes, 0)} Min auf`;
  }
}

/** "RAM frei 7,8 GB · Reserve 2 GB" or "RAM noch unbekannt". */
export function ramStatusText(status: ServerThrottleResponse['status']): string {
  if (status.freeRamBytes == null) return 'RAM noch unbekannt';
  const free = `RAM frei ${formatGb(status.freeRamBytes)}`;
  return status.ramReserveBytes == null
    ? free
    : `${free} · Reserve ${formatGb(status.ramReserveBytes)}`;
}

export interface SettingsField {
  key: Exclude<keyof ThrottleSettings, 'enabled'>;
  label: string;
  hint?: string;
}

export const SETTINGS_FIELDS: readonly SettingsField[] = [
  { key: 'cpuPct', label: 'CPU über (%)', hint: '50 bis 99' },
  { key: 'ramPct', label: 'RAM über (%)', hint: '50 bis 99' },
  { key: 'forMinutes', label: 'für (Min)', hint: 'dann drosseln' },
  {
    key: 'stopAfterMinutes',
    label: 'Stoppen nach weiteren (Min)',
    hint: 'nur „darf gestoppt werden“',
  },
  { key: 'recoverMinutes', label: 'Aufheben nach (Min)', hint: 'unter Schwelle minus Abstand' },
  { key: 'recoverMarginPct', label: 'Abstand (Prozentpunkte)', hint: '1 bis 40' },
  { key: 'throttleCpus', label: 'Drosseln auf (Kerne)', hint: '0,1 bis 64' },
  {
    key: 'ramReserveMb',
    label: 'RAM-Reserve (GB)',
    hint: '0 = automatisch: RAM der wichtigen Container',
  },
];

export type SettingsDraft = { enabled: boolean } & Record<SettingsField['key'], string>;

export function settingsDraft(s: ThrottleSettings): SettingsDraft {
  return {
    enabled: s.enabled,
    cpuPct: formatNumber(s.cpuPct, 0),
    ramPct: formatNumber(s.ramPct, 0),
    forMinutes: formatNumber(s.forMinutes, 0),
    stopAfterMinutes: formatNumber(s.stopAfterMinutes, 0),
    recoverMinutes: formatNumber(s.recoverMinutes, 0),
    recoverMarginPct: formatNumber(s.recoverMarginPct, 0),
    throttleCpus: cpusInput(s.throttleCpus),
    ramReserveMb: formatNumber(s.ramReserveMb / 1024, 2),
  };
}

const INT_RANGE: Record<
  Exclude<SettingsField['key'], 'throttleCpus' | 'ramReserveMb'>,
  [number, number]
> = {
  cpuPct: [50, 99],
  ramPct: [50, 99],
  forMinutes: [1, 120],
  stopAfterMinutes: [1, 120],
  recoverMinutes: [1, 120],
  recoverMarginPct: [1, 40],
};

const RESERVE_MAX_GB = 1024;

function parseDecimal(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export type SettingsErrors = Partial<Record<SettingsField['key'], string>>;

export function parseSettings(
  d: SettingsDraft,
): { ok: true; value: ThrottleSettings } | { ok: false; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  const out: Partial<ThrottleSettings> = { enabled: d.enabled };
  for (const [key, [min, max]] of Object.entries(INT_RANGE) as [
    keyof typeof INT_RANGE,
    [number, number],
  ][]) {
    const n = parseDecimal(d[key]);
    if (n == null || !Number.isInteger(n) || n < min || n > max) {
      errors[key] = `Ganze Zahl von ${min} bis ${max}.`;
    } else out[key] = n;
  }
  const cpus = parseCpus(d.throttleCpus);
  if (cpus.ok) out.throttleCpus = cpus.value;
  else errors.throttleCpus = cpus.error;
  const gb = parseDecimal(d.ramReserveMb);
  if (gb == null || gb > RESERVE_MAX_GB) {
    errors.ramReserveMb = `Zahl von 0 bis ${RESERVE_MAX_GB} GB.`;
  } else out.ramReserveMb = Math.round(gb * 1024);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: out as ThrottleSettings };
}

/** Only the keys that changed (PUT changes only the sent keys). */
export function changedSettings(
  before: ThrottleSettings,
  after: ThrottleSettings,
): ThrottleSettingsPatch {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(after) as (keyof ThrottleSettings)[]) {
    if (after[k] !== before[k]) out[k] = after[k];
  }
  return out as ThrottleSettingsPatch;
}

// ---------------------------------------------------------------------------
// Schedules

export const WEEKDAYS: readonly { id: Weekday; label: string; long: string }[] = [
  { id: 'mo', label: 'Mo', long: 'Montag' },
  { id: 'di', label: 'Di', long: 'Dienstag' },
  { id: 'mi', label: 'Mi', long: 'Mittwoch' },
  { id: 'do', label: 'Do', long: 'Donnerstag' },
  { id: 'fr', label: 'Fr', long: 'Freitag' },
  { id: 'sa', label: 'Sa', long: 'Samstag' },
  { id: 'so', label: 'So', long: 'Sonntag' },
];

export { MAX_SCHEDULE_WINDOWS };

export interface WindowDraft {
  /** Local key for React lists. */
  key: string;
  tier: 'niedrig' | 'normal';
  days: Weekday[];
  from: string;
  to: string;
  mode: 'no_throttle' | 'cpus';
  cpus: string;
}

export type WindowErrors = Partial<Record<'days' | 'from' | 'to' | 'cpus', string>>;

let wk = 0;
function nextKey(): string {
  wk++;
  return `w${wk}`;
}

export function windowDraft(w: ScheduleWindow): WindowDraft {
  return {
    key: nextKey(),
    tier: w.tier,
    days: [...w.days],
    from: w.from,
    to: w.to,
    mode: w.mode,
    cpus: w.cpus != null ? cpusInput(w.cpus) : '2',
  };
}

/** Example from the roadmap: niedrig, Mo–Fr 18:00–23:00, without throttling. */
export function newWindowDraft(): WindowDraft {
  return {
    key: nextKey(),
    tier: 'niedrig',
    days: ['mo', 'di', 'mi', 'do', 'fr'],
    from: '18:00',
    to: '23:00',
    mode: 'no_throttle',
    cpus: '2',
  };
}

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** "8:00" is accepted as "08:00". */
function normTime(raw: string): string {
  const t = raw.trim();
  return /^\d:[0-5]\d$/.test(t) ? `0${t}` : t;
}

const DAY_ORDER = new Map(WEEKDAYS.map((d, i) => [d.id, i]));

export function toggleDay(days: readonly Weekday[], day: Weekday): Weekday[] {
  const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
  return next.sort((a, b) => (DAY_ORDER.get(a) ?? 0) - (DAY_ORDER.get(b) ?? 0));
}

export function parseWindows(
  list: readonly WindowDraft[],
): { ok: true; value: ScheduleWindow[] } | { ok: false; errors: WindowErrors[] } {
  const errors: WindowErrors[] = [];
  const out: ScheduleWindow[] = [];
  let bad = list.length > MAX_SCHEDULE_WINDOWS;
  for (const w of list) {
    const e: WindowErrors = {};
    const from = normTime(w.from);
    const to = normTime(w.to);
    if (!w.days.length) e.days = 'Mindestens einen Tag wählen.';
    if (!TIME_RE.test(from)) e.from = 'Uhrzeit wie 18:00.';
    if (!TIME_RE.test(to)) e.to = 'Uhrzeit wie 23:00.';
    else if (from === to) e.to = 'Bis muss sich von Von unterscheiden.';
    let cpus: number | undefined;
    if (w.mode === 'cpus') {
      const c = parseCpus(w.cpus);
      if (c.ok) cpus = c.value;
      else e.cpus = c.error;
    }
    errors.push(e);
    if (Object.keys(e).length) {
      bad = true;
      continue;
    }
    out.push({
      tier: w.tier,
      days: [...w.days],
      from,
      to,
      mode: w.mode,
      ...(cpus !== undefined ? { cpus } : {}),
    });
  }
  return bad ? { ok: false, errors } : { ok: true, value: out };
}

/** "Mo–Fr", "Sa, So", "Mo, Mi–Fr", "täglich". */
export function daysText(days: readonly Weekday[]): string {
  if (days.length === 7) return 'täglich';
  const idx = [...days].map((d) => DAY_ORDER.get(d) ?? 0).sort((a, b) => a - b);
  const parts: string[] = [];
  let start = idx[0];
  let prev = idx[0];
  const label = (i: number): string => WEEKDAYS[i]?.label ?? '';
  const flush = (): void => {
    if (start === undefined || prev === undefined) return;
    if (prev - start >= 2) parts.push(`${label(start)}–${label(prev)}`);
    else if (prev > start) parts.push(label(start), label(prev));
    else parts.push(label(start));
  };
  for (const i of idx.slice(1)) {
    if (prev !== undefined && i === prev + 1) {
      prev = i;
      continue;
    }
    flush();
    start = i;
    prev = i;
  }
  flush();
  return parts.join(', ');
}

/** "niedrig Mo–Fr 18:00–23:00 ohne Drosselung" */
export function windowText(w: ScheduleWindow): string {
  const mode =
    w.mode === 'cpus' && w.cpus != null
      ? `mit ${formatNumber(w.cpus, 2)} ${w.cpus === 1 ? 'Kern' : 'Kernen'}`
      : 'ohne Drosselung';
  return `${w.tier} ${daysText(w.days)} ${w.from}–${w.to} ${mode}`;
}

// ---------------------------------------------------------------------------
// "Wieder starten" on autostop alerts (key `autostop:<serverId>:<containerName>`)

const AUTOSTOP_RE = /^autostop:([^:]+):(.+)$/;

export function parseAutostopKey(key: string): { serverId: string; name: string } | null {
  const m = AUTOSTOP_RE.exec(key);
  return m?.[1] && m[2] ? { serverId: m[1], name: m[2] } : null;
}

/**
 * What "Wieder starten" starts: the game (clean start, RAM reserve checked) or the
 * container. Null when the container is gone or runs again.
 */
export function autostopTarget(
  key: string,
  containers: readonly Pick<
    ContainerSummary,
    'id' | 'serverId' | 'name' | 'gameId' | 'autoStopped' | 'state'
  >[],
): { kind: 'game' | 'container'; id: string; name: string } | null {
  const ref = parseAutostopKey(key);
  if (!ref) return null;
  const c = containers.find((x) => x.serverId === ref.serverId && x.name === ref.name);
  if (!c || c.state === 'running' || c.state === 'restarting') return null;
  return c.gameId
    ? { kind: 'game', id: c.gameId, name: c.name }
    : { kind: 'container', id: c.id, name: c.name };
}

/**
 * RAM line in "Neuer Gameserver": "8,2 GB RAM frei · davon 4 GB Reserve · empfohlen 6 GB".
 * The reserve (M10) is only named when there is one.
 */
export function suggestRamText(
  freeBytes: number,
  reserveBytes: number | null | undefined,
  recommendedBytes: number,
): string {
  const reserve = reserveBytes ? ` · davon ${formatBytes(reserveBytes)} Reserve` : '';
  return `${formatBytes(freeBytes)} RAM frei${reserve} · empfohlen ${formatBytes(recommendedBytes)}`;
}

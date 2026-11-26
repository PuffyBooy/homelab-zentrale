import {
  haAvailableResponseSchema,
  haConfigSchema,
  haItemResponseSchema,
  haKindAllowed,
  haSettingsSchema,
  haStateSchema,
  haDomain,
  okResponseSchema,
  type HaConfig,
  type HaItem,
  type HaKind,
  type HaSettings,
  type HaState,
} from '@hz/shared';
import type { Status } from '@hz/ui';
import { api } from './api.js';
import { formatNumber, plural } from './format.js';
import type { StatusSentence } from './servers.js';

// ---------------------------------------------------------------------------
// Query keys and REST calls (routes from packages/shared/src/api/ha.ts)

export const haKey = ['ha'] as const;
export const haStateKey = ['ha', 'state'] as const;
export const haSettingsKey = ['ha', 'settings'] as const;
export const haConfigKey = ['ha', 'config'] as const;
export const haAvailableKey = ['ha', 'available'] as const;

export type HaAvailableEntity = ReturnType<
  typeof haAvailableResponseSchema.parse
>['entities'][number];
export type HaRoom = HaConfig['rooms'][number];
export type HaEntityConfig = HaConfig['entities'][number];

/** Body of PUT /api/ha/settings; omitted fields stay as they are. */
export interface HaSettingsPatch {
  url?: string;
  token?: string;
  pricePerKwh?: number;
  energyEntityId?: string | null;
  powerEntityId?: string | null;
}

const enc = encodeURIComponent;

export function fetchHaState(signal?: AbortSignal): Promise<HaState> {
  return api('/api/ha/state', { schema: haStateSchema, signal });
}

export function fetchHaSettings(signal?: AbortSignal): Promise<HaSettings> {
  return api('/api/ha/settings', { schema: haSettingsSchema, signal });
}

/** Step-up when url or token change: api() asks for the code and retries once. */
export function saveHaSettings(patch: HaSettingsPatch): Promise<HaSettings> {
  return api('/api/ha/settings', { method: 'PUT', body: patch, schema: haSettingsSchema });
}

export async function deleteHaToken(): Promise<void> {
  await api('/api/ha/token', { method: 'DELETE', schema: okResponseSchema });
}

export function fetchHaConfig(signal?: AbortSignal): Promise<HaConfig> {
  return api('/api/ha/config', { schema: haConfigSchema, signal });
}

export function saveHaConfig(config: HaConfig): Promise<HaConfig> {
  return api('/api/ha/config', { method: 'PUT', body: config, schema: haConfigSchema });
}

export async function fetchHaAvailable(signal?: AbortSignal): Promise<HaAvailableEntity[]> {
  const res = await api('/api/ha/available', { schema: haAvailableResponseSchema, signal });
  return res.entities;
}

export async function toggleHaEntity(entityId: string, on: boolean): Promise<HaItem> {
  const res = await api(`/api/ha/entities/${enc(entityId)}/toggle`, {
    method: 'POST',
    body: { on },
    schema: haItemResponseSchema,
  });
  return res.item;
}

/** Door opener / intercom. Step-up route, only after the confirm dialog. */
export async function pressHaEntity(entityId: string): Promise<HaItem> {
  const res = await api(`/api/ha/entities/${enc(entityId)}/press`, {
    method: 'POST',
    body: { confirm: true },
    schema: haItemResponseSchema,
  });
  return res.item;
}

// ---------------------------------------------------------------------------
// State helpers

export function isHaConfigured(state: HaState | undefined): boolean {
  return !!state && state.status !== 'off';
}

/** Items are only usable while HA is connected and the entity is available. */
export function itemUsable(state: HaState, item: HaItem): boolean {
  return state.status === 'connected' && item.available;
}

export function isOn(item: HaItem): boolean {
  return item.state === 'on';
}

/** Replaces one item (by entity id) in the state. */
export function replaceItem(state: HaState, item: HaItem): HaState {
  return {
    ...state,
    items: state.items.map((x) => (x.entityId === item.entityId ? item : x)),
  };
}

/** A toggle the user clicked: shown at once, until HA reports the new state. */
export interface PendingToggle {
  on: boolean;
  /** The POST is still running. */
  inFlight: boolean;
}

/**
 * Optimistic view: while the request runs, or while the core still reports the
 * item as pending, the switch shows the target state with "schaltet …". Once the
 * request is done and the core is no longer pending, the real state wins (so a
 * switch HA refused falls back). Failed requests are dropped from the map, which
 * reverts the switch.
 */
export function withPending(state: HaState, pending: ReadonlyMap<string, PendingToggle>): HaState {
  if (!pending.size) return state;
  return {
    ...state,
    items: state.items.map((x) => {
      const p = pending.get(x.entityId);
      if (!p || x.kind !== 'toggle') return x;
      if (!p.inFlight && !x.pending) return x;
      const target = p.on ? 'on' : 'off';
      return { ...x, state: target, pending: p.inFlight || x.pending };
    }),
  };
}

export interface RoomGroup {
  id: string | null;
  name: string;
  items: HaItem[];
}

/** Rooms in config order with their items; "Ohne Raum" last. Empty rooms are left out. */
export function groupByRoom(state: Pick<HaState, 'rooms' | 'items'>): RoomGroup[] {
  const known = new Set(state.rooms.map((r) => r.id));
  const groups: RoomGroup[] = state.rooms.map((r) => ({
    id: r.id,
    name: r.name,
    items: state.items.filter((i) => i.roomId === r.id),
  }));
  const loose = state.items.filter((i) => i.roomId === null || !known.has(i.roomId));
  if (loose.length) groups.push({ id: null, name: 'Ohne Raum', items: loose });
  return groups.filter((g) => g.items.length > 0);
}

/** Items for the overview tile ("wichtigste Schalter" and Klima). */
export function overviewItems(state: HaState): { metrics: HaItem[]; controls: HaItem[] } {
  const marked = state.items.filter((i) => i.overview);
  return {
    metrics: marked.filter((i) => i.kind === 'metric'),
    controls: marked.filter((i) => i.kind !== 'metric'),
  };
}

// ---------------------------------------------------------------------------
// Formatting (Austrian number format, "Stimme und Text")

/** Fraction digits per unit: 21,4 °C · 48 % · 612 ppm · 38 W · 123,4 kWh. */
function digitsFor(unit: string | null, deviceClass: string | null): number {
  switch (unit) {
    case '°C':
    case '°F':
    case 'K':
      return 1;
    case '%':
    case 'ppm':
    case 'ppb':
    case 'W':
    case 'lx':
    case 'dB':
    case 'hPa':
    case 'µg/m³':
      return 0;
    case 'kW':
    case 'kWh':
    case 'V':
    case 'A':
    case 'm³':
      return 1;
    default:
      return deviceClass === 'battery' || deviceClass === 'humidity' ? 0 : 1;
  }
}

const BINARY_TEXT: Record<string, [on: string, off: string]> = {
  door: ['offen', 'zu'],
  garage_door: ['offen', 'zu'],
  window: ['offen', 'zu'],
  opening: ['offen', 'zu'],
  lock: ['offen', 'verriegelt'],
  motion: ['Bewegung', 'ruhig'],
  occupancy: ['belegt', 'frei'],
  presence: ['da', 'weg'],
  moisture: ['nass', 'trocken'],
  smoke: ['Rauch', 'kein Rauch'],
  problem: ['Problem', 'ok'],
  connectivity: ['verbunden', 'getrennt'],
  plug: ['eingesteckt', 'ausgesteckt'],
  power: ['an', 'aus'],
};

export interface MetricParts {
  value: string;
  unit: string | undefined;
}

const NO_STATE = new Set(['unavailable', 'unknown', '']);

/**
 * Value and unit for a Metric. Unavailable: "—" without unit. With `lastKnown`
 * (HA not connected) the last reported value stays visible.
 */
export function metricParts(item: HaItem, lastKnown = false): MetricParts {
  if (!item.available && !(lastKnown && !NO_STATE.has(item.state)))
    return { value: '—', unit: undefined };
  if (haDomain(item.entityId) === 'binary_sensor') {
    const text = BINARY_TEXT[item.deviceClass ?? ''] ?? ['an', 'aus'];
    return { value: item.state === 'on' ? text[0] : text[1], unit: undefined };
  }
  if (item.value !== null && Number.isFinite(item.value)) {
    const unit = item.unit ?? undefined;
    return { value: formatNumber(item.value, digitsFor(item.unit, item.deviceClass)), unit };
  }
  return { value: item.state, unit: undefined };
}

/** One line for text contexts: "21,4 °C", "offen", "—". */
export function metricText(item: HaItem, lastKnown = false): string {
  const p = metricParts(item, lastKnown);
  return p.unit ? `${p.value} ${p.unit}` : p.value;
}

/** de-AT with a dot as group separator (Intl uses a narrow space for de-AT). */
function grouped(v: number, minDigits: number, maxDigits: number): string {
  return new Intl.NumberFormat('de-AT', {
    minimumFractionDigits: minDigits,
    maximumFractionDigits: maxDigits,
    useGrouping: true,
  })
    .formatToParts(v)
    .map((p) => (p.type === 'group' ? '.' : p.value))
    .join('');
}

/** "12,40", "1.234,56" (always two decimals, grouped). */
export function formatEurAmount(v: number): string {
  return grouped(Math.abs(v) < 0.005 ? 0 : v, 2, 2);
}

/** Monthly energy: "123,4", "1.234,5" (one decimal, grouped). */
export function formatKwh(v: number): string {
  return grouped(Math.abs(v) < 0.05 ? 0 : v, 0, 1);
}

/** "12,40 €". */
export function formatEur(v: number): string {
  return `${formatEurAmount(v)} €`;
}

/** "0,25" for the price field. */
export function priceToText(v: number): string {
  return new Intl.NumberFormat('de-AT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
    useGrouping: false,
  }).format(v);
}

/** Parses "0,25" or "0.25" (€/kWh). Null when it is not a price between 0 and 5. */
export function parsePrice(text: string): number | null {
  const t = text.trim().replace(/\s*€.*$/, '');
  if (!/^\d{1,2}([.,]\d{1,4})?$/.test(t)) return null;
  const v = Number(t.replace(',', '.'));
  return v >= 0 && v <= 5 ? v : null;
}

/** Hint under a toggle: pending first, then availability. */
export function toggleHint(state: HaState, item: HaItem): string | undefined {
  if (item.pending) return 'schaltet …';
  if (state.status !== 'connected') return 'Home Assistant nicht erreichbar';
  if (!item.available) return 'nicht verfügbar';
  return undefined;
}

/** Door openers and intercoms get "Tür öffnen", other buttons "Auslösen". */
export function pressLabel(item: Pick<HaItem, 'entityId' | 'label'>): string {
  if (haDomain(item.entityId) === 'lock') return 'Tür öffnen';
  const text = `${item.entityId} ${item.label}`.toLowerCase();
  return /t(ü|ue)r|door|(ö|oe)ffner|eingang|haus|gate|\btor|tor\b|garage|summer|intercom|gegensprech|klingel/.test(
    text,
  )
    ? 'Tür öffnen'
    : 'Auslösen';
}

/** Statussatz of the "Wohnung" page. Problems first. */
export function haSentence(state: HaState | undefined): StatusSentence {
  if (!state) return { em: null, rest: 'Wohnung' };
  if (state.status === 'off') return { em: null, rest: 'Home Assistant nicht verbunden.' };
  if (state.status === 'unreachable') return { em: 'Home Assistant nicht erreichbar', rest: '' };
  if (state.status === 'connecting') return { em: null, rest: 'Verbinde mit Home Assistant …' };
  const toggles = state.items.filter((i) => i.kind === 'toggle');
  const gone = state.items.filter((i) => !i.available).length;
  const on = toggles.filter(isOn).length;
  const rest = toggles.length
    ? `${on} von ${plural(toggles.length, 'Schalter', 'Schaltern')} an`
    : plural(state.items.length, 'Gerät', 'Geräte');
  if (gone) {
    return { em: `${gone} nicht verfügbar`, rest: ` · ${rest}` };
  }
  return { em: null, rest: state.items.length ? `${rest}.` : 'Noch keine Geräte gewählt.' };
}

/** Tile status for the connection. */
export function haTileStatus(state: Pick<HaState, 'status'> | undefined): Status | undefined {
  if (!state) return undefined;
  if (state.status === 'connected') return 'ok';
  // Same level as the "Home Assistant nicht erreichbar" alert (warn).
  if (state.status === 'unreachable') return 'warn';
  if (state.status === 'connecting') return 'busy';
  return 'off';
}

export const STATUS_TEXT: Record<HaState['status'], string> = {
  off: 'nicht eingerichtet',
  connecting: 'verbindet …',
  connected: 'verbunden',
  unreachable: 'nicht erreichbar',
};

// ---------------------------------------------------------------------------
// Configuration rules (kinds, rooms)

export const KIND_LABEL: Record<HaKind, string> = {
  toggle: 'Schalter',
  metric: 'Sensor',
  button: 'Taster',
};

const KIND_ORDER: readonly HaKind[] = ['toggle', 'metric', 'button'];

/** Kinds that may be chosen for this entity (same rule as the core). */
export function allowedKinds(entityId: string): HaKind[] {
  return KIND_ORDER.filter((k) => haKindAllowed(k, entityId));
}

/**
 * Kind for a newly added entity: buttons and locks press, sensors measure, lights
 * and switches toggle. A switch that is a door opener (Shelly) must be set to
 * "Taster" by hand, unless its name says it is one.
 */
export function defaultKind(entity: Pick<HaAvailableEntity, 'entityId' | 'name'>): HaKind | null {
  const kinds = allowedKinds(entity.entityId);
  const d = haDomain(entity.entityId);
  if (
    d === 'switch' &&
    pressLabel({ entityId: entity.entityId, label: entity.name }) === 'Tür öffnen'
  )
    return 'button';
  if (kinds.includes('toggle')) return 'toggle';
  if (kinds.includes('metric')) return 'metric';
  if (kinds.includes('button')) return 'button';
  return null;
}

/** Room id from a name: "Wohnzimmer" → "wohnzimmer", "Küche" → "kueche", unique. */
export function roomIdFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34) || 'raum';
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}

/** Removes a room; its entities move to "Ohne Raum". */
export function removeRoom(config: HaConfig, roomId: string): HaConfig {
  return {
    rooms: config.rooms.filter((r) => r.id !== roomId),
    entities: config.entities.map((e) => (e.roomId === roomId ? { ...e, roomId: null } : e)),
  };
}

/** Finds a room by HA area name (case-insensitive). */
export function roomForArea(rooms: readonly HaRoom[], area: string | null): string | null {
  if (!area) return null;
  const a = area.trim().toLowerCase();
  return rooms.find((r) => r.name.trim().toLowerCase() === a)?.id ?? null;
}

/** New config entry for an entity from the picker. Null if no kind is allowed. */
export function entityFromAvailable(
  config: HaConfig,
  entity: HaAvailableEntity,
): HaEntityConfig | null {
  const kind = defaultKind(entity);
  if (!kind) return null;
  return {
    entityId: entity.entityId,
    kind,
    roomId: roomForArea(config.rooms, entity.area),
    label: null,
    overview: false,
  };
}

/** Problems that keep the config from being saved (German, first one wins). */
export function configProblem(config: HaConfig): string | null {
  const names = new Set<string>();
  for (const r of config.rooms) {
    const n = r.name.trim();
    if (!n) return 'Jeder Raum braucht einen Namen.';
    if (n.length > 40) return `Raumname „${n.slice(0, 20)}…“ ist zu lang (höchstens 40 Zeichen).`;
    if (names.has(n.toLowerCase())) return `Den Raum „${n}“ gibt es zweimal.`;
    names.add(n.toLowerCase());
  }
  for (const e of config.entities) {
    if (!haKindAllowed(e.kind, e.entityId))
      return `${e.entityId}: Art „${KIND_LABEL[e.kind]}“ geht für diese Entität nicht.`;
    if (e.label !== null && e.label.trim().length > 60)
      return `${e.entityId}: Bezeichnung höchstens 60 Zeichen.`;
  }
  return null;
}

/** Trims labels (empty → null) before PUT. */
export function normalizeConfig(config: HaConfig): HaConfig {
  return {
    rooms: config.rooms.map((r) => ({ ...r, name: r.name.trim() })),
    entities: config.entities.map((e) => {
      const label = e.label?.trim() ?? '';
      return { ...e, label: label ? label : null };
    }),
  };
}

/** Sensors for the energy picker: kWh/Wh, or device class energy. */
export function isEnergySensor(e: HaAvailableEntity): boolean {
  return (
    haDomain(e.entityId) === 'sensor' &&
    (e.deviceClass === 'energy' || e.unit === 'kWh' || e.unit === 'Wh')
  );
}

/** Sensors for the power picker: W/kW, or device class power. */
export function isPowerSensor(e: HaAvailableEntity): boolean {
  return (
    haDomain(e.entityId) === 'sensor' &&
    (e.deviceClass === 'power' || e.unit === 'W' || e.unit === 'kW')
  );
}

/** Search in the entity picker: id, name, area. */
export function matchesEntity(e: HaAvailableEntity, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    e.entityId.includes(q) ||
    e.name.toLowerCase().includes(q) ||
    (e.area ?? '').toLowerCase().includes(q)
  );
}

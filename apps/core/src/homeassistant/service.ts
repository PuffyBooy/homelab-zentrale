import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  HA_TOGGLE_DOMAINS,
  haConfigNeedsStepUp,
  haConfigSchema,
  haDomain,
  haEntityIdSchema,
  haKindAllowed,
  haKindSchema,
  haUrlSchema,
  type HaConfig,
  type HaKind,
  type HaSettings,
  type HaState,
  type haAvailableEntitySchema,
  type haConnectionStatusSchema,
  type haItemSchema,
  type haSettingsRequestSchema,
} from '@hz/shared';
import type { AlertService } from '../alerts/service.js';
import type { Clock } from '../clock.js';
import { DecryptError, type SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import { settings as settingsTable } from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import { clockTime } from '../format.js';
import { HttpError } from '../http/errors.js';
import { WindowLimiter } from '../share/limits.js';
import {
  HaCallError,
  HaClient,
  type HaClientOptions,
  type HaDownReason,
  type HaSnapshot,
} from './client.js';
import { EnergyStore, HA_ENERGY_UNITS, HA_POWER_UNITS, toKwh, toWatts } from './energy.js';
import type { HaEntityState } from './protocol.js';

type HaItem = z.infer<typeof haItemSchema>;
type HaAvailableEntity = z.infer<typeof haAvailableEntitySchema>;
type HaStatus = z.infer<typeof haConnectionStatusSchema>;
type SettingsRequest = z.output<typeof haSettingsRequestSchema>;

const SETTINGS_KEY = 'ha.settings';
const TOKEN_KEY = 'ha.token';
const TOKEN_AAD = 'settings.ha.token';
const CONFIG_KEY = 'ha.config';
const STATUS_KEY = 'ha.status';
export const HA_ALERT_KEY = 'ha:unreachable';
/** Default € per kWh until the admin sets a tariff. */
export const HA_DEFAULT_PRICE = 0.25;
/** A toggle/press shows `pending` until HA reports the change, at most this long. */
export const HA_PENDING_MS = 10_000;
/** HA down for longer than this: warn alert. */
export const HA_ALERT_AFTER_MS = 2 * 60_000;
/** PUT settings waits this long for the first connection result. */
const SETTINGS_WAIT_MS = 5_000;
/** Door opener presses per minute (all entities together). */
export const HA_PRESS_PER_MIN = 3;
/** LockEntityFeature.OPEN */
const LOCK_FEATURE_OPEN = 1;
const MAX_CACHED = 20_000;
const MAX_AVAILABLE = 5_000;

export const HA_ERROR_TEXT: Record<HaDownReason, string> = {
  auth_invalid: 'Token ungültig',
  unreachable: 'Nicht erreichbar',
  timeout: 'Nicht erreichbar (Zeitüberschreitung)',
  tls: 'Nicht erreichbar (TLS-Fehler)',
  too_large: 'Antwort zu groß',
  protocol: 'Unerwartete Antwort',
  closed: 'Verbindung unterbrochen',
};
const TOKEN_UNREADABLE = 'Token nicht lesbar, bitte neu eintragen';

const storedSettingsSchema = z.object({
  url: haUrlSchema.nullable().catch(null),
  pricePerKwh: z.number().min(0).max(5).catch(HA_DEFAULT_PRICE),
  energyEntityId: haEntityIdSchema.nullable().catch(null),
  powerEntityId: haEntityIdSchema.nullable().catch(null),
});
type StoredSettings = z.infer<typeof storedSettingsSchema>;
const DEFAULT_SETTINGS: StoredSettings = {
  url: null,
  pricePerKwh: HA_DEFAULT_PRICE,
  energyEntityId: null,
  powerEntityId: null,
};

const storedStatusSchema = z.object({
  lastConnectedAt: z.number().nullable().catch(null),
  haVersion: z.string().max(40).nullable().catch(null),
});

export interface HaServiceCall {
  domain: string;
  service: string;
}

/** Fixed service per toggle domain; null if the domain is not a toggle domain. */
export function toggleCall(entityId: string, on: boolean): HaServiceCall | null {
  const domain = haDomain(entityId);
  if (!(HA_TOGGLE_DOMAINS as readonly string[]).includes(domain)) return null;
  return { domain, service: on ? 'turn_on' : 'turn_off' };
}

/** A lock that can release the latch (`lock.open`); others only lock and unlock. */
export function lockCanOpen(supportedFeatures: number): boolean {
  return (supportedFeatures & LOCK_FEATURE_OPEN) !== 0;
}

/**
 * Fixed service per button domain. lock: `open` (releases the latch), only for
 * locks with the OPEN feature (null otherwise: never `unlock` as a fallback).
 * switch: `turn_on` (Shelly with auto-off).
 */
export function pressCall(entityId: string, supportedFeatures: number): HaServiceCall | null {
  switch (haDomain(entityId)) {
    case 'button':
      return { domain: 'button', service: 'press' };
    case 'lock':
      return lockCanOpen(supportedFeatures) ? { domain: 'lock', service: 'open' } : null;
    case 'switch':
      return { domain: 'switch', service: 'turn_on' };
    case 'script':
      return { domain: 'script', service: 'turn_on' };
    default:
      return null;
  }
}

const KINDS = haKindSchema.options;
/**
 * "unavailable" always; "unknown" too, except for buttons (a button's state is
 * the time of its last press and stays "unknown" until it was pressed once).
 */
function isUnavailable(entityId: string, state: string): boolean {
  return state === 'unavailable' || (state === 'unknown' && haDomain(entityId) !== 'button');
}

function numeric(state: string): number | null {
  if (state.trim() === '') return null;
  const v = Number(state);
  return Number.isFinite(v) ? v : null;
}

export interface HaServiceDeps {
  db: Db;
  box: SecretBox;
  now: Clock;
  alerts: AlertService;
  log: FastifyBaseLogger;
  options?: HaClientOptions;
}

/**
 * Home Assistant (SPEC 10): one WebSocket connection, the entity selection,
 * live state for topic `ha`, toggles and door openers through a fixed service
 * map (only configured entities), energy per month and the "nicht erreichbar"
 * alert.
 */
export class HaService {
  private client: HaClient | null = null;
  private status: HaStatus = 'off';
  private error: string | null = null;
  private haVersion: string | null = null;
  /** Reconnecting after a failed attempt shows `unreachable`, not `connecting`. */
  private failed = false;
  private downSince: number | null = null;
  private readonly cache = new Map<string, HaEntityState>();
  private areas = new Map<string, string>();
  private readonly pending = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private waiters: (() => void)[] = [];
  private readonly energy: EnergyStore;
  private readonly pressLimiter: WindowLimiter;
  private changedAt: number;
  /** Parsed `ha.config` / `ha.settings`; only setConfig/updateSettings write them. */
  private configCache: HaConfig | null = null;
  private configIds: Set<string> | null = null;
  private settingsCache: StoredSettings | null = null;

  constructor(private readonly deps: HaServiceDeps) {
    this.energy = new EnergyStore(deps.db);
    this.pressLimiter = new WindowLimiter(HA_PRESS_PER_MIN, 60_000, deps.now);
    this.changedAt = deps.now();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.changedAt = this.deps.now();
    for (const fn of this.listeners) fn();
  }

  /** Module switch (settings/modules): off closes the websocket and stays off. */
  private active = true;

  setEnabled(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.reconnect();
  }

  start(): void {
    this.reconnect();
  }

  stop(): void {
    this.client?.stop();
    this.client = null;
  }

  // ---- stored settings -------------------------------------------------------------

  private stored(): StoredSettings {
    if (this.settingsCache) return this.settingsCache;
    const p = storedSettingsSchema.safeParse(readSetting(this.deps.db, SETTINGS_KEY) ?? {});
    this.settingsCache = p.success ? p.data : DEFAULT_SETTINGS;
    return this.settingsCache;
  }

  private tokenSet(): boolean {
    return typeof readSetting(this.deps.db, TOKEN_KEY) === 'string';
  }

  private token(): string | null {
    const enc = readSetting(this.deps.db, TOKEN_KEY);
    if (typeof enc !== 'string') return null;
    try {
      return this.deps.box.decrypt(enc, TOKEN_AAD);
    } catch (err) {
      if (err instanceof DecryptError) return null;
      throw err;
    }
  }

  private storedStatus(): z.infer<typeof storedStatusSchema> {
    const p = storedStatusSchema.safeParse(readSetting(this.deps.db, STATUS_KEY) ?? {});
    return p.success ? p.data : { lastConnectedAt: null, haVersion: null };
  }

  settings(): HaSettings {
    const s = this.stored();
    const st = this.storedStatus();
    return {
      url: s.url,
      tokenSet: this.tokenSet(),
      status: this.status,
      error: this.error,
      haVersion: this.haVersion ?? st.haVersion,
      lastConnectedAt:
        st.lastConnectedAt === null ? null : new Date(st.lastConnectedAt).toISOString(),
      pricePerKwh: s.pricePerKwh,
      energyEntityId: s.energyEntityId,
      powerEntityId: s.powerEntityId,
    };
  }

  /** URL or token change: needs step-up (docs/SECURITY.md, "Ändern von Tokens"). */
  needsStepUp(body: SettingsRequest): boolean {
    return body.token !== undefined || (body.url !== undefined && body.url !== this.stored().url);
  }

  /**
   * A sensor HA knows must have a matching unit (Wh/kWh/MWh, W/kW). Unknown
   * entities pass (HA may be offline); without a usable unit they show no value.
   */
  private checkSensorUnits(body: SettingsRequest): void {
    const check = (id: string | null | undefined, units: readonly string[], msg: string): void => {
      if (id === null || id === undefined) return;
      const c = this.cache.get(id);
      if (c && (c.unit === null || !units.includes(c.unit))) {
        throw new HttpError(400, 'invalid_input', undefined, msg);
      }
    };
    check(
      body.energyEntityId,
      HA_ENERGY_UNITS,
      'Energiesensor braucht die Einheit Wh, kWh oder MWh',
    );
    check(body.powerEntityId, HA_POWER_UNITS, 'Leistungssensor braucht die Einheit W oder kW');
  }

  /** Stores the settings; a new URL or token reconnects and waits briefly for the result. */
  async updateSettings(
    body: SettingsRequest,
  ): Promise<{ settings: HaSettings; urlChanged: boolean; tokenChanged: boolean }> {
    this.checkSensorUnits(body);
    const prev = this.stored();
    const next: StoredSettings = {
      url: body.url ?? prev.url,
      pricePerKwh: body.pricePerKwh ?? prev.pricePerKwh,
      energyEntityId: body.energyEntityId === undefined ? prev.energyEntityId : body.energyEntityId,
      powerEntityId: body.powerEntityId === undefined ? prev.powerEntityId : body.powerEntityId,
    };
    const now = this.deps.now();
    writeSetting(this.deps.db, SETTINGS_KEY, next, now);
    this.settingsCache = null;
    const tokenChanged = body.token !== undefined;
    if (body.token !== undefined) {
      writeSetting(this.deps.db, TOKEN_KEY, this.deps.box.encrypt(body.token, TOKEN_AAD), now);
    }
    const urlChanged = next.url !== prev.url;
    if (urlChanged || tokenChanged) {
      this.reconnect();
      await this.waitOutcome(SETTINGS_WAIT_MS);
    } else {
      this.recordEnergy();
      this.emit();
    }
    return { settings: this.settings(), urlChanged, tokenChanged };
  }

  /** Forgets the token and disconnects. */
  clearToken(): void {
    this.deps.db.delete(settingsTable).where(eq(settingsTable.key, TOKEN_KEY)).run();
    this.reconnect();
  }

  // ---- connection ------------------------------------------------------------------

  private reconnect(): void {
    this.client?.stop();
    this.client = null;
    this.cache.clear();
    this.areas = new Map();
    this.pending.clear();
    this.haVersion = null;
    this.failed = false;
    const url = this.active ? this.stored().url : null;
    const token = this.active ? this.token() : null;
    if (url === null || token === null) {
      this.status = 'off';
      this.error = this.active && this.tokenSet() && token === null ? TOKEN_UNREADABLE : null;
      this.downSince = null;
      // Switched off: the condition is gone, no "wieder erreichbar".
      const active = this.deps.alerts.active(HA_ALERT_KEY);
      if (active) this.deps.alerts.resolveById(active.id);
      this.emit();
      this.wake();
      return;
    }
    this.status = 'connecting';
    this.error = null;
    this.downSince = this.deps.now();
    const client = new HaClient(
      url,
      token,
      {
        connecting: () => {
          if (this.client !== client) return;
          const next: HaStatus = this.failed ? 'unreachable' : 'connecting';
          if (next !== this.status) {
            this.status = next;
            this.emit();
          }
        },
        ready: (snap) => {
          if (this.client === client) this.onReady(snap);
        },
        stateChanged: (id, s) => {
          if (this.client === client) this.onStateChanged(id, s);
        },
        down: (reason) => {
          if (this.client === client) this.onDown(reason);
        },
      },
      this.deps.options,
    );
    this.client = client;
    this.emit();
    client.start();
  }

  private onReady(snap: HaSnapshot): void {
    const now = this.deps.now();
    this.cache.clear();
    for (const s of snap.states) this.cache.set(s.entityId, s);
    this.areas = snap.areas;
    this.status = 'connected';
    this.error = null;
    this.failed = false;
    this.haVersion = snap.haVersion;
    this.downSince = null;
    writeSetting(
      this.deps.db,
      STATUS_KEY,
      { lastConnectedAt: now, haVersion: snap.haVersion },
      now,
    );
    this.deps.log.info(
      { haVersion: snap.haVersion, entities: snap.states.length },
      'home assistant connected',
    );
    if (this.deps.alerts.active(HA_ALERT_KEY)) {
      this.deps.alerts.resolve(HA_ALERT_KEY, {
        title: 'Home Assistant wieder erreichbar',
        body: `Seit ${clockTime(now)} wieder verbunden.`,
      });
    }
    this.recordEnergy();
    this.emit();
    this.wake();
  }

  private onStateChanged(entityId: string, s: HaEntityState | null): void {
    if (s === null) this.cache.delete(entityId);
    else if (this.cache.has(entityId) || this.cache.size < MAX_CACHED) this.cache.set(entityId, s);
    const wasPending = this.pending.delete(entityId);
    const st = this.stored();
    if (entityId === st.energyEntityId) this.recordEnergy();
    if (
      wasPending ||
      entityId === st.energyEntityId ||
      entityId === st.powerEntityId ||
      this.configuredIds().has(entityId)
    ) {
      this.emit();
    }
  }

  private onDown(reason: HaDownReason): void {
    const wasConnected = this.status === 'connected';
    this.pending.clear();
    this.downSince ??= this.deps.now();
    if (wasConnected && reason === 'closed') {
      // HA restarts or the network blipped: first try again before calling it down.
      this.status = 'connecting';
      this.error = null;
    } else {
      this.status = 'unreachable';
      this.error = HA_ERROR_TEXT[reason];
      this.failed = true;
    }
    this.deps.log.info({ reason }, 'home assistant connection down');
    this.emit();
    this.wake();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  /** Resolves once the connection is up, failed or off (or after `ms`). */
  waitOutcome(ms: number): Promise<void> {
    if (this.status !== 'connecting') return Promise.resolve();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const done = (): void => {
        if (timer) clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== check);
        resolve();
      };
      const check = (): void => {
        if (this.status !== 'connecting') done();
        else this.waiters.push(check);
      };
      timer = setTimeout(done, ms);
      timer.unref();
      this.waiters.push(check);
    });
  }

  /** Every second: pending timeouts, the unreachable alert and the month rollover. */
  tick(): void {
    const now = this.deps.now();
    let changed = false;
    for (const [id, until] of this.pending) {
      if (until <= now) {
        this.pending.delete(id);
        changed = true;
      }
    }
    if (
      this.status !== 'off' &&
      this.status !== 'connected' &&
      this.downSince !== null &&
      now - this.downSince > HA_ALERT_AFTER_MS
    ) {
      this.deps.alerts.raise(
        HA_ALERT_KEY,
        'warn',
        'Home Assistant nicht erreichbar',
        `Seit ${clockTime(this.downSince)} keine Verbindung (${this.error ?? HA_ERROR_TEXT.closed}).`,
        null,
        'ha',
      );
    }
    const energyId = this.stored().energyEntityId;
    if (
      this.status === 'connected' &&
      energyId !== null &&
      this.cache.has(energyId) &&
      (this.energy.hasSuspect(energyId) || this.energy.monthKwh(energyId, now) === null)
    ) {
      this.recordEnergy();
      changed = true;
    }
    if (changed) this.emit();
  }

  // ---- entity selection --------------------------------------------------------------

  config(): HaConfig {
    if (this.configCache) return this.configCache;
    const p = haConfigSchema.safeParse(readSetting(this.deps.db, CONFIG_KEY));
    this.configCache = p.success ? p.data : { rooms: [], entities: [] };
    this.configIds = null;
    return this.configCache;
  }

  private configuredIds(): Set<string> {
    const c = this.config();
    this.configIds ??= new Set(c.entities.map((e) => e.entityId));
    return this.configIds;
  }

  /**
   * New `switch.*` or `button` entity, or a changed kind: needs step-up
   * (`switch` is both toggle and door opener, see haConfigNeedsStepUp).
   */
  configNeedsStepUp(next: HaConfig): boolean {
    return haConfigNeedsStepUp(this.config(), next);
  }

  setConfig(c: HaConfig): HaConfig {
    writeSetting(this.deps.db, CONFIG_KEY, c, this.deps.now());
    this.configCache = null;
    this.configIds = null;
    this.emit();
    return this.config();
  }

  /** Everything HA knows that the core can show (for the picker). */
  available(): HaAvailableEntity[] {
    const out: HaAvailableEntity[] = [];
    for (const s of this.cache.values()) {
      const kinds = KINDS.filter((k) => haKindAllowed(k, s.entityId));
      if (kinds.length === 0) continue;
      out.push({
        entityId: s.entityId,
        name: s.friendlyName ?? s.entityId,
        state: s.state,
        unit: s.unit,
        deviceClass: s.deviceClass,
        area: this.areas.get(s.entityId) ?? null,
        kinds,
      });
    }
    out.sort((a, b) => a.entityId.localeCompare(b.entityId));
    return out.slice(0, MAX_AVAILABLE);
  }

  // ---- state -------------------------------------------------------------------------

  private buildItem(e: HaConfig['entities'][number]): HaItem {
    const now = this.deps.now();
    const c = this.cache.get(e.entityId);
    const connected = this.status === 'connected';
    const state = c?.state ?? 'unavailable';
    const climate = haDomain(e.entityId) === 'climate';
    const value = climate ? (c?.currentTemperature ?? null) : numeric(state);
    return {
      entityId: e.entityId,
      kind: e.kind,
      roomId: e.roomId,
      label: e.label ?? c?.friendlyName ?? e.entityId,
      overview: e.overview,
      state,
      value,
      unit: climate ? (value === null ? null : '°C') : (c?.unit ?? null),
      deviceClass: c?.deviceClass ?? null,
      available: connected && c !== undefined && !isUnavailable(e.entityId, state),
      lastChanged: c?.lastChanged ?? null,
      pending: (this.pending.get(e.entityId) ?? 0) > now,
    };
  }

  private energyState(): HaState['energy'] {
    const s = this.stored();
    if (s.energyEntityId === null && s.powerEntityId === null) return null;
    const now = this.deps.now();
    const p =
      s.powerEntityId !== null && this.status === 'connected'
        ? this.cache.get(s.powerEntityId)
        : undefined;
    const watts = p ? toWatts(p.state, p.unit) : null;
    const monthKwh = s.energyEntityId !== null ? this.energy.monthKwh(s.energyEntityId, now) : null;
    return {
      powerW: watts === null ? null : Math.round(watts * 10) / 10,
      monthKwh,
      monthEur: EnergyStore.euro(monthKwh, s.pricePerKwh),
      pricePerKwh: s.pricePerKwh,
    };
  }

  private recordEnergy(): void {
    const id = this.stored().energyEntityId;
    if (id === null) return;
    const c = this.cache.get(id);
    if (!c) return;
    const kwh = toKwh(c.state, c.unit);
    if (kwh !== null) this.energy.record(id, kwh, this.deps.now());
  }

  state(): HaState {
    const c = this.config();
    return {
      status: this.status,
      error: this.error,
      rooms: c.rooms,
      items: c.entities.map((e) => this.buildItem(e)),
      energy: this.energyState(),
      updatedAt: new Date(this.changedAt).toISOString(),
    };
  }

  // ---- actions -----------------------------------------------------------------------

  /** The configured entity of this kind, or an HttpError (only selected entities). */
  private configured(entityId: string, kind: HaKind): HaConfig['entities'][number] {
    const e = this.config().entities.find((x) => x.entityId === entityId);
    if (!e) throw new HttpError(404, 'not_found');
    if (e.kind !== kind || !haKindAllowed(kind, entityId)) {
      throw new HttpError(
        400,
        'invalid_input',
        undefined,
        kind === 'toggle' ? 'Nur Schalter und Lichter lassen sich schalten' : 'Kein Türöffner',
      );
    }
    return e;
  }

  private requireUsable(entityId: string): HaEntityState {
    if (!this.client || this.status !== 'connected') {
      throw new HttpError(502, 'ha_error', undefined, 'Home Assistant nicht erreichbar');
    }
    const c = this.cache.get(entityId);
    if (!c || isUnavailable(entityId, c.state)) {
      throw new HttpError(409, 'conflict', undefined, 'Gerät nicht verfügbar');
    }
    return c;
  }

  private async run(entityId: string, call: HaServiceCall): Promise<void> {
    const client = this.client;
    if (!client) throw new HttpError(502, 'ha_error', undefined, 'Home Assistant nicht erreichbar');
    this.pending.set(entityId, this.deps.now() + HA_PENDING_MS);
    this.emit();
    try {
      await client.callService(call.domain, call.service, entityId);
    } catch (err) {
      this.pending.delete(entityId);
      this.emit();
      if (!(err instanceof HaCallError)) throw err;
      const msg =
        err.kind === 'failed'
          ? 'Home Assistant hat die Aktion abgelehnt'
          : err.kind === 'timeout'
            ? 'Home Assistant antwortet nicht'
            : err.kind === 'busy'
              ? 'Home Assistant ist ausgelastet'
              : 'Home Assistant nicht erreichbar';
      this.deps.log.info({ kind: err.kind, haCode: err.haCode }, 'home assistant call failed');
      throw new HttpError(502, 'ha_error', undefined, msg);
    }
  }

  async toggle(entityId: string, on: boolean): Promise<{ item: HaItem; call: HaServiceCall }> {
    const e = this.configured(entityId, 'toggle');
    const call = toggleCall(entityId, on);
    if (!call) throw new HttpError(400, 'invalid_input');
    this.requireUsable(entityId);
    await this.run(entityId, call);
    return { item: this.buildItem(e), call };
  }

  /** Checks and rate limit before the step-up-protected press goes to HA. */
  async press(entityId: string): Promise<{ item: HaItem; call: HaServiceCall }> {
    const e = this.configured(entityId, 'button');
    const c = this.requireUsable(entityId);
    if (haDomain(entityId) === 'lock' && !lockCanOpen(c.supportedFeatures)) {
      throw new HttpError(409, 'conflict', undefined, 'Schloss kann nur auf-/zusperren');
    }
    const call = pressCall(entityId, c.supportedFeatures);
    if (!call) throw new HttpError(400, 'invalid_input');
    const wait = this.pressLimiter.hit('press');
    if (wait !== null) throw new HttpError(429, 'rate_limited', wait);
    await this.run(entityId, call);
    return { item: this.buildItem(e), call };
  }
}

import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  VOICE_COOLDOWN_MS,
  voiceStateSchema,
  voiceStatusEntitySchema,
  voiceSwitchEntitySchema,
  type GameSummary,
  type VoiceState,
  type voiceGameRequestSchema,
} from '@hz/shared';
import type { Clock } from '../clock.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { readSetting, writeSetting } from '../db/settings.js';
import type { GameService } from '../games/service.js';
import type { HaService } from '../homeassistant/service.js';
import { HttpError } from '../http/errors.js';
import { friendStatusText } from '../share/service.js';

export const VOICE_KEY = 'voice.games';
/** A state_changed matching our own service call within this window is our echo. */
export const VOICE_ECHO_MS = 10_000;
/** input_text default max length in Home Assistant. */
export const VOICE_STATUS_MAX = 100;
export const VOICE_ACTOR = 'voice:ha';

const entrySchema = z.object({
  switchEntity: voiceSwitchEntitySchema.nullable().catch(null),
  statusEntity: voiceStatusEntitySchema.nullable().catch(null),
  allowStop: z.boolean().catch(false),
  lastTriggerAt: z.number().int().nonnegative().nullable().catch(null),
});
type Entry = z.infer<typeof entrySchema>;
const storedSchema = z.record(z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), entrySchema);

export type VoiceGameRequest = z.output<typeof voiceGameRequestSchema>;

export interface VoiceDeps {
  db: Db;
  now: Clock;
  log: FastifyBaseLogger;
  ha: Pick<HaService, 'ready' | 'entityState' | 'setHelper' | 'onEntityState' | 'onChange'>;
  games: Pick<
    GameService,
    'row' | 'summary' | 'list' | 'action' | 'enabled' | 'onChange' | 'isRunning'
  >;
}

/** Short German status for an input_text, from the friend-safe texts only. */
export function voiceStatusText(s: GameSummary, phase: string): string {
  let text: string = friendStatusText(s.status, s.statusText, phase);
  if (s.players && (s.status === 'ok' || s.status === 'warn')) {
    text += `, ${s.players.online} Spieler`;
  }
  return text.length > VOICE_STATUS_MAX ? text.slice(0, VOICE_STATUS_MAX) : text;
}

/**
 * Switch position that shows the truth: on while the game runs or starts, off
 * while it is stopped, sleeps or stops; null while unclear (setup, backup).
 */
export function desiredSwitch(s: GameSummary, running: boolean): boolean | null {
  switch (s.status) {
    case 'ok':
    case 'warn':
      return true;
    case 'off':
      return false;
    case 'crit':
      return running;
    case 'busy':
      if (s.statusText === 'Startet' || s.statusText === 'Neustart') return true;
      if (s.statusText === 'Wird gestoppt') return false;
      return null;
  }
}

/**
 * Echo Show / Alexa through Home Assistant helpers (module voice, api/ops.ts).
 * Watches `input_boolean.*` switches over the existing HA connection: on starts
 * the game (RAM reserve applies), off stops it only with allowStop. Mirrors the
 * game state back into the switch and an optional `input_text.*` status.
 * Ignores its own echoes, unavailable states and toggles within the cooldown.
 */
export class VoiceService {
  private enabled = false;
  /** Last state per configured switch entity (to see off->on / on->off). */
  private readonly lastSeen = new Map<string, string>();
  /** State we just asked HA for, per entity (our own echo). */
  private readonly expected = new Map<string, { state: string; until: number }>();
  /** Status text we wrote last per input_text entity. */
  private readonly written = new Map<string, string>();
  /** Games with a voice-triggered action running. */
  private readonly inFlight = new Set<string>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly unsubscribe: (() => void)[] = [];
  private haWasReady = false;
  private cache: Record<string, Entry> | null = null;

  constructor(private readonly deps: VoiceDeps) {
    this.unsubscribe.push(
      deps.ha.onEntityState((id, state) => this.onEntity(id, state)),
      deps.ha.onChange(() => {
        const r = deps.ha.ready;
        if (r && !this.haWasReady) this.resync();
        this.haWasReady = r;
      }),
      deps.games.onChange((id, deleted) => {
        if (deleted) this.forget(id);
        else if (this.config()[id]) this.track(this.mirror(id));
      }),
    );
    this.haWasReady = deps.ha.ready;
  }

  // ---- settings --------------------------------------------------------------------

  private config(): Record<string, Entry> {
    if (this.cache) return this.cache;
    const p = storedSchema.safeParse(readSetting(this.deps.db, VOICE_KEY) ?? {});
    this.cache = p.success ? p.data : {};
    return this.cache;
  }

  private write(c: Record<string, Entry>): void {
    writeSetting(this.deps.db, VOICE_KEY, c, this.deps.now());
    this.cache = null;
  }

  private forget(gameId: string): void {
    const c = this.config();
    if (!(gameId in c)) return;
    this.write(Object.fromEntries(Object.entries(c).filter(([id]) => id !== gameId)));
  }

  state(): VoiceState {
    const c = this.config();
    const games = this.deps.games.list();
    // Lazily drop entries of deleted games.
    const ids = new Set(games.map((g) => g.id));
    if (Object.keys(c).some((id) => !ids.has(id))) {
      this.write(Object.fromEntries(Object.entries(c).filter(([id]) => ids.has(id))));
    }
    return voiceStateSchema.parse({
      haReady: this.deps.ha.ready,
      games: games.map((g) => {
        const e = c[g.id];
        return {
          gameId: g.id,
          gameName: g.name,
          switchEntity: e?.switchEntity ?? null,
          statusEntity: e?.statusEntity ?? null,
          allowStop: e?.allowStop ?? false,
          lastTriggerAt:
            e?.lastTriggerAt === null || e?.lastTriggerAt === undefined
              ? null
              : new Date(e.lastTriggerAt).toISOString(),
        };
      }),
    });
  }

  /** Step-up: a new switch entity, or allowing stop. Removing either does not need it. */
  needsStepUp(gameId: string, req: VoiceGameRequest): boolean {
    const prev = this.config()[gameId];
    const switchChanged = req.switchEntity !== null && req.switchEntity !== prev?.switchEntity;
    return switchChanged || (req.allowStop && !(prev?.allowStop ?? false));
  }

  /** 404 unknown game, 409 switch already used by another game. */
  update(gameId: string, req: VoiceGameRequest): void {
    if (!this.deps.games.row(gameId)) throw new HttpError(404, 'not_found');
    const c = { ...this.config() };
    for (const [id, e] of Object.entries(c)) {
      if (id === gameId) continue;
      if (
        (req.switchEntity !== null && e.switchEntity === req.switchEntity) ||
        (req.statusEntity !== null && e.statusEntity === req.statusEntity)
      ) {
        throw new HttpError(
          409,
          'conflict',
          undefined,
          'Diese Entität nutzt schon ein anderes Spiel',
        );
      }
    }
    const prev = c[gameId];
    if (req.switchEntity === null && req.statusEntity === null && !req.allowStop) {
      this.write(Object.fromEntries(Object.entries(c).filter(([id]) => id !== gameId)));
    } else {
      c[gameId] = {
        switchEntity: req.switchEntity,
        statusEntity: req.statusEntity,
        allowStop: req.allowStop,
        lastTriggerAt: prev?.lastTriggerAt ?? null,
      };
      this.write(c);
    }
    if (prev?.switchEntity && prev.switchEntity !== req.switchEntity) {
      this.lastSeen.delete(prev.switchEntity);
      this.expected.delete(prev.switchEntity);
    }
    if (prev?.statusEntity) this.written.delete(prev.statusEntity);
    if (req.switchEntity !== null) this.seen(req.switchEntity);
    this.track(this.mirror(gameId));
  }

  // ---- lifecycle -------------------------------------------------------------------

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this.resync();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private active(): boolean {
    return this.enabled && this.deps.ha.ready && this.deps.games.enabled;
  }

  private seen(entityId: string): void {
    const s = this.deps.ha.entityState(entityId);
    if (s === null) this.lastSeen.delete(entityId);
    else this.lastSeen.set(entityId, s);
  }

  /** HA (re)connected or module on: read the switches, then mirror every game. */
  private resync(): void {
    this.lastSeen.clear();
    this.expected.clear();
    this.written.clear();
    for (const [id, e] of Object.entries(this.config())) {
      if (e.switchEntity) this.seen(e.switchEntity);
      if (this.active()) this.track(this.mirror(id));
    }
  }

  private track(p: Promise<unknown>): void {
    const t = p
      .catch((err: unknown) =>
        this.deps.log.error(
          { err: err instanceof Error ? { name: err.name } : 'error' },
          'voice handler failed',
        ),
      )
      .finally(() => this.background.delete(t));
    this.background.add(t);
  }

  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  shutdown(): void {
    this.enabled = false;
    for (const fn of this.unsubscribe.splice(0)) fn();
  }

  // ---- HA -> game ------------------------------------------------------------------

  private gameOfSwitch(entityId: string): string | null {
    for (const [id, e] of Object.entries(this.config())) {
      if (e.switchEntity === entityId) return id;
    }
    return null;
  }

  private onEntity(entityId: string, state: string | null): void {
    if (!entityId.startsWith('input_boolean.')) return;
    const gameId = this.gameOfSwitch(entityId);
    if (gameId === null) return;
    const prev = this.lastSeen.get(entityId);
    if (state === null) {
      this.lastSeen.delete(entityId);
      return;
    }
    this.lastSeen.set(entityId, state);
    if (state !== 'on' && state !== 'off') return;
    const now = this.deps.now();
    const exp = this.expected.get(entityId);
    if (exp) {
      this.expected.delete(entityId);
      if (exp.until > now && exp.state === state) return;
    }
    // unavailable/unknown -> on (HA restart, helper created) is not a toggle.
    if ((prev !== 'on' && prev !== 'off') || prev === state) return;
    if (!this.active()) return;
    this.track(this.trigger(gameId, entityId, state === 'on'));
  }

  private audit(gameId: string, details: Record<string, unknown>): void {
    writeAudit(this.deps.db, this.deps.now(), {
      actor: VOICE_ACTOR,
      action: 'voice.trigger',
      target: gameId,
      details,
    });
  }

  private async trigger(gameId: string, entityId: string, on: boolean): Promise<void> {
    const cfg = this.config()[gameId];
    const s = this.deps.games.summary(gameId);
    if (!cfg || cfg.switchEntity !== entityId || !s) return;
    const to = on ? 'on' : 'off';
    const now = this.deps.now();
    if (!on && !cfg.allowStop) {
      this.audit(gameId, { entity: entityId, to, result: 'stop_not_allowed' });
      return this.mirror(gameId);
    }
    if (cfg.lastTriggerAt !== null && now - cfg.lastTriggerAt < VOICE_COOLDOWN_MS) {
      this.audit(gameId, { entity: entityId, to, result: 'cooldown' });
      return this.mirror(gameId);
    }
    if (this.inFlight.has(gameId)) {
      this.audit(gameId, { entity: entityId, to, result: 'busy' });
      return;
    }
    const want = desiredSwitch(s, this.deps.games.isRunning(gameId));
    if (want === on) {
      this.audit(gameId, { entity: entityId, to, result: 'unchanged' });
      return;
    }
    this.write({ ...this.config(), [gameId]: { ...cfg, lastTriggerAt: now } });
    this.inFlight.add(gameId);
    try {
      await this.deps.games.action(gameId, on ? 'start' : 'stop', VOICE_ACTOR);
      this.audit(gameId, { entity: entityId, to, result: 'ok' });
    } catch (err) {
      const code = err instanceof HttpError ? err.code : 'failed';
      this.audit(gameId, { entity: entityId, to, result: 'failed', error: code });
    } finally {
      this.inFlight.delete(gameId);
    }
    await this.mirror(gameId);
  }

  // ---- game -> HA ------------------------------------------------------------------

  private async mirror(gameId: string): Promise<void> {
    if (!this.active()) return;
    const cfg = this.config()[gameId];
    const s = this.deps.games.summary(gameId);
    const row = this.deps.games.row(gameId);
    if (!cfg || !s || !row) return;
    const ha = this.deps.ha;
    const sw = cfg.switchEntity;
    if (sw !== null && !this.inFlight.has(gameId)) {
      const want = desiredSwitch(s, this.deps.games.isRunning(gameId));
      const cur = ha.entityState(sw);
      const exp = this.expected.get(sw);
      const pendingSame =
        exp !== undefined && exp.until > this.deps.now() && exp.state === (want ? 'on' : 'off');
      if (want !== null && (cur === 'on' || cur === 'off') && cur !== (want ? 'on' : 'off')) {
        if (!pendingSame) {
          this.expected.set(sw, {
            state: want ? 'on' : 'off',
            until: this.deps.now() + VOICE_ECHO_MS,
          });
          try {
            await ha.setHelper(sw, want);
          } catch {
            this.expected.delete(sw);
            this.deps.log.info({ gameId }, 'voice switch mirror failed');
          }
        }
      }
    }
    const se = cfg.statusEntity;
    if (se !== null) {
      const text = voiceStatusText(s, row.phase);
      const cur = ha.entityState(se);
      if (cur !== null && cur !== 'unavailable' && cur !== text && this.written.get(se) !== text) {
        this.written.set(se, text);
        try {
          await ha.setHelper(se, text);
        } catch {
          this.written.delete(se);
          this.deps.log.info({ gameId }, 'voice status mirror failed');
        }
      }
    }
  }
}

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { wallDeviceSchema } from '@hz/shared';
import {
  wallStateSchema,
  wallTokenSchema,
  type GameSummary,
  type HaState,
  type ServerSummary,
  type WallState,
} from '@hz/shared';
import type { z } from 'zod';
import { localTime } from '../calendar.js';
import type { Clock } from '../clock.js';
import { randomToken, sha256Hex, timingSafeEqual } from '../crypto.js';
import type { Db } from '../db/index.js';
import { alerts, wallDevices, type WallDeviceRow } from '../db/schema.js';

type WallTile = WallState['tiles'][number];
type WallDevice = z.infer<typeof wallDeviceSchema>;

/** lastSeenAt (and the cookie) are refreshed at most this often. */
export const WALL_TOUCH_MS = 60_000;
/** Cookie lifetime; refreshed with lastSeenAt, so a used tablet never runs out. */
export const WALL_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60_000;
/** Night (dim to 40 %): from 22:00 to 06:59 local time (HZ_TIMEZONE). */
export const NIGHT_FROM_HOUR = 22;
export const NIGHT_UNTIL_HOUR = 7;
const MAX_ALERTS = 5;

export function wallTokenHash(token: string): string {
  return sha256Hex(`wall:${token}`);
}

export function isNight(ms: number): boolean {
  const h = localTime(ms).hour;
  return h >= NIGHT_FROM_HOUR || h < NIGHT_UNTIL_HOUR;
}

const intFmt = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 0 });
const oneDecimalFmt = new Intl.NumberFormat('de-AT', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function plural(n: number, one: string, many: string): string {
  return `${intFmt.format(n)} ${n === 1 ? one : many}`;
}

/** IPv4 (with port) and IPv6 literals; alert titles on the wall never show addresses. */
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;
const IPV6 =
  /\[?(?:\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*\b)?)\]?/gi;

export function maskAddresses(text: string): string {
  return text.replace(IPV4, '…').replace(IPV6, '…');
}

interface Sources {
  /** Optional modules that are on; switched-off modules have no tiles. Default: all on. */
  modules?: () => { games: boolean; homeassistant: boolean };
  servers: () => ServerSummary[];
  games: () => GameSummary[];
  ha: () => HaState;
}

/**
 * Same wording as the status sentence of the web app (apps/web/src/lib/servers.ts):
 * "Alles läuft." · "1 Problem auf oracle-a1 · 4 von 4 Servern laufen" ·
 * "2 Probleme · 3 von 4 Servern laufen".
 */
export function wallSentence(
  servers: ServerSummary[],
  openAlerts: { level: string; serverId: string | null }[],
): string {
  if (servers.length === 0) return 'Noch nichts verbunden.';
  const ids = new Set(servers.map((s) => s.id));
  const bad = servers.filter((s) => s.status === 'crit' || s.status === 'warn');
  const other = openAlerts.filter(
    (a) =>
      (a.level === 'crit' || a.level === 'warn') && (a.serverId === null || !ids.has(a.serverId)),
  ).length;
  const running = servers.filter((s) => s.status !== 'crit' && s.status !== 'off').length;
  const problems = bad.length + other;
  const rest = `${running} von ${plural(servers.length, 'Server', 'Servern')} ${running === 1 ? 'läuft' : 'laufen'}`;
  if (problems === 0) return running === servers.length ? 'Alles läuft.' : rest;
  const only = bad.length === 1 && other === 0 ? bad[0] : undefined;
  const em = only ? `1 Problem auf ${only.name}` : plural(problems, 'Problem', 'Probleme');
  return `${em} · ${rest}`;
}

/** Wall devices (SPEC 12) and the read-only wall state. */
export class WallService {
  constructor(
    private readonly deps: {
      db: Db;
      now: Clock;
      sources: Sources;
    },
  ) {}

  private toDevice(r: WallDeviceRow): WallDevice {
    return {
      id: r.id,
      name: r.name,
      createdAt: new Date(r.createdAt).toISOString(),
      lastSeenAt: r.lastSeenAt === null ? null : new Date(r.lastSeenAt).toISOString(),
      paired: r.sessionHash !== null,
    };
  }

  list(): WallDevice[] {
    return this.deps.db
      .select()
      .from(wallDevices)
      .orderBy(desc(wallDevices.createdAt), desc(wallDevices.id))
      .all()
      .map((r) => this.toDevice(r));
  }

  /** Creates a device. The one-time token is returned only here and never stored. */
  create(name: string): { device: WallDevice; token: string } {
    const token = randomToken(32);
    const row: WallDeviceRow = {
      id: randomToken(16),
      name,
      tokenHash: wallTokenHash(token),
      sessionHash: null,
      usedTokenHash: null,
      createdAt: this.deps.now(),
      lastSeenAt: null,
      pairedAt: null,
    };
    this.deps.db.insert(wallDevices).values(row).run();
    return { device: this.toDevice(row), token };
  }

  /**
   * A fresh one-time link for an existing device. The old link and the old cookie
   * stop working at once. Returns null for an unknown device.
   */
  relink(id: string): { device: WallDevice; token: string } | null {
    const token = randomToken(32);
    const changed = this.deps.db
      .update(wallDevices)
      .set({
        tokenHash: wallTokenHash(token),
        sessionHash: null,
        usedTokenHash: null,
        pairedAt: null,
      })
      .where(eq(wallDevices.id, id))
      .run().changes;
    if (changed === 0) return null;
    const device = this.get(id);
    return device ? { device, token } : null;
  }

  get(id: string): WallDevice | null {
    const r = this.deps.db.select().from(wallDevices).where(eq(wallDevices.id, id)).get();
    return r ? this.toDevice(r) : null;
  }

  /** Deleting revokes at once: every request looks the cookie up again. */
  delete(id: string): boolean {
    return this.deps.db.delete(wallDevices).where(eq(wallDevices.id, id)).run().changes > 0;
  }

  /** The device of a cookie value (session secret), or null. Used by the auth guard. */
  resolve(secret: string | undefined): { id: string; lastSeenAt: number | null } | null {
    if (secret === undefined || !wallTokenSchema.safeParse(secret).success) return null;
    const hash = wallTokenHash(secret);
    const row = this.deps.db
      .select({
        id: wallDevices.id,
        sessionHash: wallDevices.sessionHash,
        lastSeenAt: wallDevices.lastSeenAt,
      })
      .from(wallDevices)
      .where(eq(wallDevices.sessionHash, hash))
      .get();
    // The lookup is by hash of a 256-bit secret; the compare is constant time anyway.
    if (!row?.sessionHash || !timingSafeEqual(row.sessionHash, hash)) return null;
    return { id: row.id, lastSeenAt: row.lastSeenAt };
  }

  /**
   * Swaps a one-time link token for a new device session secret (decision 2026-11-26).
   * - Unused token: the token hash is cleared, a new secret is stored (hash only) and
   *   returned for the cookie; an older cookie of that device stops working.
   * - Used token, but the request carries a valid cookie of the device that this
   *   token paired: `repeat` (kiosk reload of the start URL), the cookie stays.
   * - Otherwise null (401).
   */
  exchange(
    token: string,
    cookie: string | undefined,
  ): { kind: 'paired'; id: string; secret: string } | { kind: 'repeat'; id: string } | null {
    const hash = wallTokenHash(token);
    const secret = randomToken(32);
    const now = this.deps.now();
    const paired = this.deps.db
      .update(wallDevices)
      .set({
        tokenHash: null,
        sessionHash: wallTokenHash(secret),
        usedTokenHash: hash,
        pairedAt: now,
        lastSeenAt: now,
      })
      .where(eq(wallDevices.tokenHash, hash))
      .returning({ id: wallDevices.id })
      .get();
    if (paired) return { kind: 'paired', id: paired.id, secret };
    const current = this.resolve(cookie);
    if (!current) return null;
    const row = this.deps.db
      .select({ usedTokenHash: wallDevices.usedTokenHash })
      .from(wallDevices)
      .where(eq(wallDevices.id, current.id))
      .get();
    if (!row?.usedTokenHash || !timingSafeEqual(row.usedTokenHash, hash)) return null;
    return { kind: 'repeat', id: current.id };
  }

  /** Updates lastSeenAt at most once per WALL_TOUCH_MS. Returns true if written. */
  touch(device: { id: string; lastSeenAt: number | null }): boolean {
    const now = this.deps.now();
    if (device.lastSeenAt !== null && now - device.lastSeenAt < WALL_TOUCH_MS) return false;
    this.deps.db
      .update(wallDevices)
      .set({ lastSeenAt: now })
      .where(eq(wallDevices.id, device.id))
      .run();
    return true;
  }

  /** Read-only state of the wall. No ids, no addresses. */
  state(): WallState {
    const now = this.deps.now();
    const mods = this.deps.sources.modules?.() ?? { games: true, homeassistant: true };
    const servers = this.deps.sources.servers();
    const games = mods.games ? this.deps.sources.games() : [];
    const ha = this.deps.sources.ha();
    const open = this.deps.db
      .select({
        level: alerts.level,
        title: alerts.title,
        openedAt: alerts.openedAt,
        serverId: alerts.serverId,
      })
      .from(alerts)
      .where(and(eq(alerts.state, 'open'), inArray(alerts.level, ['crit', 'warn'])))
      .orderBy(desc(alerts.openedAt), desc(alerts.id))
      .all();

    const tiles: WallTile[] = [
      serversTile(servers),
      ...(mods.games ? [playersTile(games)] : []),
      ...(mods.homeassistant ? [temperatureTile(ha), powerTile(ha)] : []),
      problemsTile(open),
    ];
    // crit first, then by time (newest first).
    const shown = [...open]
      .sort((a, b) => (a.level === b.level ? b.openedAt - a.openedAt : a.level === 'crit' ? -1 : 1))
      .slice(0, MAX_ALERTS)
      .map((a) => ({
        level: a.level as 'crit' | 'warn',
        title: maskAddresses(a.title),
        openedAt: new Date(a.openedAt).toISOString(),
      }));
    return wallStateSchema.parse({
      tiles,
      alerts: shown,
      sentence: wallSentence(servers, open),
      night: isNight(now),
      updatedAt: new Date(now).toISOString(),
    });
  }
}

function serversTile(servers: ServerSummary[]): WallTile {
  const up = servers.filter((s) => s.status !== 'crit' && s.status !== 'off').length;
  const tone: WallTile['tone'] =
    servers.length === 0
      ? 'off'
      : servers.some((s) => s.status === 'crit')
        ? 'crit'
        : servers.some((s) => s.status === 'warn')
          ? 'warn'
          : up === servers.length
            ? 'ok'
            : 'off';
  return {
    id: 'servers',
    label: 'Server',
    value: `${intFmt.format(up)}/${intFmt.format(servers.length)}`,
    unit: null,
    hint: servers.length === 0 ? 'Noch nichts verbunden' : up === 1 ? 'läuft' : 'laufen',
    tone,
  };
}

function playersTile(games: GameSummary[]): WallTile {
  const live = games.filter((g) => g.players !== null);
  const players = live.reduce((a, g) => a + (g.players?.online ?? 0), 0);
  const running = games.filter((g) => g.status === 'ok' || g.status === 'warn').length;
  return {
    id: 'players',
    label: 'Spieler online',
    value: intFmt.format(players),
    unit: null,
    hint:
      games.length === 0
        ? 'Keine Gameserver'
        : plural(running, 'Gameserver läuft', 'Gameserver laufen'),
    tone: running === 0 ? 'off' : 'ok',
  };
}

function isTemperature(i: HaState['items'][number]): boolean {
  return (
    i.kind === 'metric' && (i.entityId.startsWith('climate.') || i.deviceClass === 'temperature')
  );
}

function temperatureTile(ha: HaState): WallTile {
  // Overview entities first (the admin chose them as the important ones), then any.
  const candidates = ha.items.filter(isTemperature);
  const pick =
    candidates.find((i) => i.overview && i.available && i.value !== null) ??
    candidates.find((i) => i.available && i.value !== null);
  return {
    id: 'temperature',
    label: 'Temperatur innen',
    value: pick && pick.value !== null ? oneDecimalFmt.format(pick.value) : '–',
    unit: pick?.unit ?? '°C',
    // The label falls back to the entity id in HA; ids never reach the wall.
    hint: pick
      ? pick.label === pick.entityId
        ? null
        : pick.label
      : ha.status === 'off'
        ? 'Home Assistant nicht eingerichtet'
        : 'Kein Sensor',
    tone: pick ? 'ok' : 'off',
  };
}

function powerTile(ha: HaState): WallTile {
  const w = ha.energy?.powerW ?? null;
  return {
    id: 'power',
    label: 'Strom aktuell',
    value: w === null ? '–' : intFmt.format(Math.round(w)),
    unit: 'W',
    hint:
      w === null
        ? ha.status === 'off'
          ? 'Home Assistant nicht eingerichtet'
          : 'Kein Sensor'
        : null,
    tone: w === null ? 'off' : 'ok',
  };
}

function problemsTile(open: { level: string }[]): WallTile {
  const crit = open.filter((a) => a.level === 'crit').length;
  return {
    id: 'problems',
    label: 'Offene Probleme',
    value: intFmt.format(open.length),
    unit: null,
    hint:
      open.length === 0
        ? 'Alles in Ordnung'
        : crit > 0
          ? plural(crit, 'kritisch', 'kritisch')
          : null,
    tone: crit > 0 ? 'crit' : open.length > 0 ? 'warn' : 'ok',
  };
}

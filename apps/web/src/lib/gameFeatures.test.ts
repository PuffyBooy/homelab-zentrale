import { describe, expect, it } from 'vitest';
import { game, server, template } from '../test-fixtures.js';
import {
  archMismatch,
  daysText,
  discordUrlError,
  dockerArch,
  downloadsText,
  hoursSummary,
  hoursUntilNow,
  nextRunText,
  normalizeTime,
  parseNetwork,
  peakHourText,
  playtimeText,
  restoreProgress,
  sleepModeText,
  sleepText,
  sortPlayers,
  sortRequests,
  stoppedText,
  toggleDay,
  toggleEvent,
  validateSchedules,
} from './gameFeatures.js';
import {
  findGameContainer,
  forwardPlace,
  gamesSentence,
  gameSentence,
  gameTileProps,
} from './games.js';
import { permsFor, togglePerm } from './shares.js';
import { container } from '../test-fixtures.js';

describe('play time', () => {
  it('formats hours and zero-padded minutes', () => {
    expect(playtimeText(0)).toBe('0 min');
    expect(playtimeText(59)).toBe('0 min');
    expect(playtimeText(42 * 60)).toBe('42 min');
    expect(playtimeText(12 * 3600 + 5 * 60 + 30)).toBe('12 h 05 min');
    expect(playtimeText(100 * 3600)).toBe('100 h 00 min');
    expect(playtimeText(-5)).toBe('0 min');
  });

  it('sorts players by play time, then name', () => {
    const list = sortPlayers([
      { name: 'Tobi', seconds: 60 },
      { name: 'Sam', seconds: 3600 },
      { name: 'Lena', seconds: 60 },
    ]);
    expect(list.map((p) => p.name)).toEqual(['Sam', 'Lena', 'Tobi']);
  });

  it('finds the busiest hour and rotates the bars to end now', () => {
    const hours = Array.from({ length: 24 }, (_, i) => (i === 20 ? 3.24 : i === 21 ? 2 : 0));
    expect(peakHourText(hours)).toBe('20–21 Uhr · Ø 3,2 Spieler');
    expect(peakHourText(new Array<number>(24).fill(0))).toBeNull();
    expect(peakHourText(Array.from({ length: 24 }, (_, i) => (i === 23 ? 1 : 0)))).toBe(
      '23–00 Uhr · Ø 1 Spieler',
    );
    const r = hoursUntilNow(hours, 21);
    expect(r.first).toBe(22);
    expect(r.data).toHaveLength(24);
    expect(r.data[23]).toBe(2);
    expect(r.data[22]).toBe(3.24);
    expect(hoursSummary(hours)).toBe('Ø Spieler pro Stunde: 20 Uhr 3,2, 21 Uhr 2');
    expect(hoursSummary(new Array<number>(24).fill(0))).toBe('Noch keine Spieler.');
  });
});

describe('architecture', () => {
  it('maps agent names to docker names', () => {
    expect(dockerArch('x64')).toBe('amd64');
    expect(dockerArch('x86_64')).toBe('amd64');
    expect(dockerArch('aarch64')).toBe('arm64');
    expect(dockerArch('arm64')).toBe('arm64');
    expect(dockerArch('armv7l')).toBeNull();
    expect(dockerArch(null)).toBeNull();
  });

  it('greys out servers the template does not run on', () => {
    const amdOnly = template({ arch: ['amd64'] });
    expect(archMismatch(amdOnly, server({ arch: 'aarch64' }))).toBe('Läuft nicht auf arm64');
    expect(archMismatch(amdOnly, server({ arch: 'x86_64' }))).toBeNull();
    expect(archMismatch(template(), server({ arch: 'aarch64' }))).toBeNull();
    // Unknown arch: the agent decides.
    expect(archMismatch(amdOnly, server({ arch: null }))).toBeNull();
    expect(archMismatch(amdOnly, undefined)).toBeNull();
  });
});

describe('sleep mode', () => {
  it('shows "Schläft" with the off shape', () => {
    const asleep = game({
      status: 'off',
      statusText: 'Schläft',
      sleeping: true,
      wakeOnConnect: true,
    });
    expect(gameTileProps(asleep).statusLabel).toBe('Schläft');
    expect(gameTileProps(asleep).status).toBe('off');
    expect(gameTileProps(game({ status: 'off', sleeping: false })).statusLabel).toBeUndefined();
    expect(sleepText(asleep)).toBe('Schläft · weckt beim Verbinden');
    expect(sleepText({ ...asleep, wakeOnConnect: false })).toBe('Schläft · Starten weckt ihn');
    expect(gameSentence(asleep).rest).toBe('survival schläft. Verbinden weckt ihn.');
  });

  it('switches back to the normal status once it runs', () => {
    const awake = game({ status: 'ok', statusText: 'Läuft', sleeping: false });
    expect(gameTileProps(awake).statusLabel).toBeUndefined();
    expect(sleepText(awake)).toBe('Läuft');
    // A stale sleeping flag on a running game is ignored.
    expect(gameTileProps({ ...awake, sleeping: true }).statusLabel).toBeUndefined();
  });

  it('counts sleeping games in the sentences', () => {
    const a = game({ name: 'a', status: 'off', sleeping: true });
    const b = game({ name: 'b', status: 'off', sleeping: false });
    expect(gamesSentence([a, { ...a, name: 'c' }]).rest).toBe('Alle 2 Gameserver schlafen.');
    expect(gamesSentence([a, b]).rest).toBe('Alle 2 Gameserver aus · 1 schläft.');
    expect(stoppedText([a, b])).toBe('Alle 2 Gameserver sind aus · 1 schläft.');
    expect(stoppedText([b])).toBe('Der Gameserver ist gestoppt.');
    expect(stoppedText([a])).toBe('Der Gameserver schläft.');
  });

  it('describes the setting', () => {
    expect(sleepModeText({ autoStopMinutes: 0, wakeOnConnect: true }, true)).toBe('aus');
    expect(sleepModeText({ autoStopMinutes: 15, wakeOnConnect: true }, true)).toBe(
      'nach 15 Min ohne Spieler, weckt beim Verbinden',
    );
    expect(sleepModeText({ autoStopMinutes: 15, wakeOnConnect: true }, false)).toBe(
      'nach 15 Min ohne Spieler',
    );
  });
});

describe('schedules', () => {
  it('names the weekdays', () => {
    expect(daysText([1, 2, 3, 4, 5, 6, 7])).toBe('täglich');
    expect(daysText([1, 2, 3, 4, 5])).toBe('Mo–Fr');
    expect(daysText([6, 7])).toBe('Sa, So');
    expect(daysText([5, 1, 3])).toBe('Mo, Mi, Fr');
    expect(toggleDay([3, 1], 2, true)).toEqual([1, 2, 3]);
    expect(toggleDay([1, 2], 2, false)).toEqual([1]);
  });

  it('normalizes the time and validates the list', () => {
    expect(normalizeTime('4:00')).toBe('04:00');
    expect(normalizeTime('2359')).toBe('23:59');
    expect(normalizeTime('24:00')).toBeNull();
    const ok = validateSchedules([{ kind: 'backup', days: [7, 1], time: '4.30', enabled: true }]);
    expect(ok).toEqual({
      ok: true,
      schedules: [{ kind: 'backup', days: [1, 7], time: '04:30', enabled: true }],
    });
    const bad = validateSchedules([
      { kind: 'restart', days: [], time: '05:00', enabled: true },
      { kind: 'restart', days: [1], time: 'x', enabled: true },
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors[0]).toBe('Mindestens einen Wochentag wählen.');
      expect(bad.errors[1]).toBe('Uhrzeit als HH:MM, z. B. 04:00.');
    }
    const many = Array.from({ length: 11 }, () => ({
      kind: 'backup' as const,
      days: [1],
      time: '04:00',
      enabled: true,
    }));
    expect(validateSchedules(many).ok).toBe(false);
  });

  it('says when it runs next', () => {
    const now = new Date(2026, 10, 26, 12, 0);
    expect(nextRunText(null, now)).toBe('aus');
    expect(nextRunText(new Date(2026, 10, 26, 23, 4).toISOString(), now)).toBe(
      'nächster Lauf 23:04',
    );
  });
});

describe('Discord and mods', () => {
  it('accepts only Discord webhooks', () => {
    expect(discordUrlError('https://discord.com/api/webhooks/123/abc_DEF-1')).toBeNull();
    expect(discordUrlError('https://discordapp.com/api/webhooks/1/x')).toBeNull();
    expect(discordUrlError('https://evil.example/api/webhooks/1/x')).not.toBeNull();
    expect(discordUrlError('http://discord.com/api/webhooks/1/x')).not.toBeNull();
    expect(discordUrlError('')).toBe('Webhook-URL eingeben.');
    expect(toggleEvent(['wake', 'online'], 'sleep', true)).toEqual(['online', 'sleep', 'wake']);
    expect(toggleEvent(['online'], 'online', false)).toEqual([]);
  });

  it('formats downloads', () => {
    expect(downloadsText(312)).toBe('312 Downloads');
    expect(downloadsText(48_200)).toBe('48.000 Downloads');
    expect(downloadsText(1_250_000)).toBe('1,3 Mio. Downloads');
    expect(downloadsText(999_700)).toBe('999.000 Downloads');
  });
});

describe('whitelist requests', () => {
  it('puts open requests first, newest first', () => {
    const list = sortRequests([
      { id: 'a', state: 'approved', createdAt: '2026-11-26T10:00:00.000Z' },
      { id: 'b', state: 'pending', createdAt: '2026-11-25T10:00:00.000Z' },
      { id: 'c', state: 'pending', createdAt: '2026-11-26T09:00:00.000Z' },
    ]);
    expect(list.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('share rights', () => {
  it('offers world download for every game and the request only for Minecraft Java', () => {
    expect(permsFor('valheim')).toContain('world_download');
    expect(permsFor('valheim')).not.toContain('whitelist_request');
    expect(permsFor('minecraft-java')).toContain('whitelist_request');
  });

  it('keeps whitelist editing and whitelist request apart', () => {
    expect(togglePerm(['power', 'whitelist'], 'whitelist_request', true)).toEqual([
      'power',
      'whitelist_request',
    ]);
    expect(togglePerm(['whitelist_request'], 'whitelist', true)).toEqual(['whitelist']);
    expect(togglePerm(['power'], 'world_download', true)).toEqual(['power', 'world_download']);
  });
});

describe('restore progress', () => {
  const ev = (id: string, kind: 'progress' | 'ready' | 'error' | 'console', text: string) => ({
    id,
    kind,
    text,
    ts: '2026-11-26T20:00:00.000Z',
  });
  it('only counts events after the mark', () => {
    const list = [
      ev('1', 'ready', 'alt'),
      ev('2', 'progress', 'Backup vorher …'),
      ev('3', 'console', 'x'),
    ];
    expect(restoreProgress(list, '1')).toEqual({ state: 'running', text: 'Backup vorher …' });
    expect(restoreProgress([...list, ev('4', 'ready', 'Welt wiederhergestellt')], '1')).toEqual({
      state: 'ready',
      text: 'Welt wiederhergestellt',
    });
    expect(restoreProgress([ev('5', 'error', 'kaputt')], null).state).toBe('error');
    expect(restoreProgress(list, '3')).toEqual({ state: 'running', text: null });
  });
});

describe('labels and network', () => {
  it('finds the game container by its label first', () => {
    const g = game({ serverId: 'srv-a', name: 'survival' });
    const labelled = container({ serverId: 'srv-a', name: 'mc-custom', game: 'survival' });
    const byName = container({ serverId: 'srv-a', name: 'game-survival' });
    const otherGame = container({
      serverId: 'srv-a',
      composeProject: 'survival',
      game: 'creative',
    });
    expect(findGameContainer(g, [byName, labelled])).toBe(labelled);
    expect(findGameContainer(g, [byName])).toBe(byName);
    // A container labelled for another game is never taken by the heuristic.
    expect(findGameContainer(g, [otherGame])).toBeUndefined();
  });

  it('uses the network of the server for the forwarding hint', () => {
    expect(forwardPlace(server({ name: 'web-vps', location: 'x', network: 'home' }))).toBe('home');
    expect(forwardPlace(server({ name: 'oracle-a1', location: 'x', network: 'cloud' }))).toBe(
      'oracle',
    );
    expect(forwardPlace(server({ name: 'hetzner', location: 'x', network: 'cloud' }))).toBe(
      'cloud',
    );
    expect(forwardPlace(server({ name: 'heimserver', location: 'x', network: 'vps' }))).toBe('vps');
    expect(forwardPlace(server({ name: 'heimserver', location: 'x', network: 'other' }))).toBe(
      'unknown',
    );
    expect(forwardPlace(server({ name: 'heimserver', location: 'x', network: null }))).toBe('home');
    expect(parseNetwork('vps')).toBe('vps');
    expect(parseNetwork('')).toBeNull();
    expect(parseNetwork('mars')).toBeNull();
  });
});

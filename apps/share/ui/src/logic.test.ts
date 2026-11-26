import { describe, expect, it } from 'vitest';
import {
  controlsFor,
  errorLine,
  expiresText,
  failureOf,
  isConsoleResponse,
  isFinal,
  isShareStatus,
  mergeLines,
  messageFor,
  pinText,
  playerError,
  screenFor,
  statusLine,
  tokenFromPath,
  type ShareStatus,
} from './logic.js';

const TOKEN = 'A'.repeat(20) + '_-' + 'b'.repeat(21);

function status(
  over: Partial<ShareStatus> = {},
  game: Partial<ShareStatus['game']> = {},
): ShareStatus {
  return {
    person: 'Max',
    perms: ['power'],
    expiresAt: null,
    ...over,
    game: {
      name: 'survival',
      game: 'Minecraft Java',
      version: '1.21.4',
      status: 'ok',
      statusText: 'Läuft',
      address: 'mc.example.at:25565',
      players: { online: 2, max: 20, names: ['Lena', 'Tobi'] },
      whitelist: true,
      ...game,
    },
  };
}

describe('token from the path', () => {
  it('accepts exactly /s/<43 chars base64url>', () => {
    expect(TOKEN).toHaveLength(43);
    expect(tokenFromPath(`/s/${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromPath(`/s/${TOKEN}/`)).toBe(TOKEN);
    expect(tokenFromPath(`/s/${TOKEN}x`)).toBeNull();
    expect(tokenFromPath(`/s/${TOKEN.slice(1)}`)).toBeNull();
    expect(tokenFromPath(`/s/${TOKEN.slice(1)}.`)).toBeNull();
    expect(tokenFromPath(`/x/${TOKEN}`)).toBeNull();
    expect(tokenFromPath(`/s/api/status`)).toBeNull();
  });
});

describe('rights -> controls', () => {
  it('power only: Start when stopped, Stop otherwise, nothing else', () => {
    expect(controlsFor(status({}, { status: 'off' }))).toEqual({
      power: 'start',
      restart: false,
      disabled: false,
      console: false,
      command: false,
      whitelist: false,
    });
    expect(controlsFor(status()).power).toBe('stop');
  });

  it('no power right: no power button', () => {
    expect(controlsFor(status({ perms: ['restart'] }))).toMatchObject({
      power: null,
      restart: true,
    });
  });

  it('console write implies reading; whitelist only where the game supports it', () => {
    const c = controlsFor(status({ perms: ['console_write', 'whitelist'] }));
    expect(c).toMatchObject({ console: true, command: true, whitelist: true });
    expect(controlsFor(status({ perms: ['console_read'] }))).toMatchObject({
      console: true,
      command: false,
    });
    expect(controlsFor(status({ perms: ['whitelist'] }, { whitelist: false })).whitelist).toBe(
      false,
    );
  });

  it('blocks buttons while the server is busy', () => {
    expect(controlsFor(status({}, { status: 'busy' })).disabled).toBe(true);
  });
});

describe('answers -> screens', () => {
  const now = new Date(2026, 10, 26, 23, 4);

  it('maps the fatal answers', () => {
    expect(screenFor({ status: 404, error: 'not_found' })).toEqual({ kind: 'invalid' });
    expect(screenFor({ status: 410, error: 'revoked' })).toEqual({ kind: 'revoked' });
    expect(screenFor({ status: 410, error: 'expired' })).toEqual({ kind: 'expired' });
    expect(messageFor({ kind: 'invalid' })?.title).toBe('Link ungültig.');
    expect(messageFor({ kind: 'expired' })?.title).toBe('Link abgelaufen.');
    expect(messageFor({ kind: 'revoked' })?.title).toBe('Link widerrufen.');
    expect(isFinal({ kind: 'revoked' })).toBe(true);
    expect(isFinal({ kind: 'pin', wrong: false, triesLeft: 5 })).toBe(false);
  });

  it('asks for the PIN and says how many tries are left', () => {
    const s = screenFor({ status: 401, error: 'pin_wrong', triesLeft: 3 });
    expect(s).toEqual({ kind: 'pin', wrong: true, triesLeft: 3 });
    if (s?.kind !== 'pin') throw new Error('pin');
    expect(pinText(s)).toBe('PIN falsch. Noch 3 Versuche.');
    expect(pinText({ kind: 'pin', wrong: true, triesLeft: 1 })).toBe('PIN falsch. Noch 1 Versuch.');
    expect(pinText({ kind: 'pin', wrong: false, triesLeft: 5 })).toBeNull();
  });

  it('shows the lock with its end time', () => {
    const s = screenFor({ status: 423, error: 'locked', retryAfter: 900 }, now);
    expect(s).toEqual({ kind: 'locked', until: new Date(2026, 10, 26, 23, 19) });
    if (!s) throw new Error('locked');
    expect(messageFor(s)?.title).toBe('PIN gesperrt bis 23:19.');
  });

  it('keeps the page for other errors and says what happened', () => {
    expect(screenFor({ status: 403, error: 'forbidden' })).toBeNull();
    expect(errorLine({ status: 403, error: 'forbidden' })).toBe(
      'Dafür hat dieser Link keine Berechtigung.',
    );
    expect(errorLine({ status: 429, error: 'rate_limited', retryAfter: 90 })).toBe(
      'Zu viele Anfragen. Wieder möglich in 2 Min.',
    );
    expect(errorLine({ status: 409, error: 'busy' })).toMatch(/läuft schon/);
    expect(screenFor({ status: 409, error: 'insufficient_ram' })).toBeNull();
    expect(errorLine(failureOf(409, { ok: false, error: 'insufficient_ram' }, null))).toBe(
      'Zu wenig Arbeitsspeicher auf dem Server. Später erneut versuchen.',
    );
  });

  it('reads error bodies, Retry-After and unknown bodies', () => {
    expect(failureOf(401, { ok: false, error: 'pin_wrong', triesLeft: 2 }, null)).toEqual({
      status: 401,
      error: 'pin_wrong',
      retryAfter: undefined,
      triesLeft: 2,
    });
    expect(failureOf(429, { ok: false, error: 'rate_limited' }, '30').retryAfter).toBe(30);
    expect(failureOf(410, undefined, null).error).toBe('revoked');
    expect(failureOf(404, '<html>', null).error).toBe('not_found');
    expect(failureOf(500, { error: 'secret stuff' }, null).error).toBe('bad_response');
  });
});

describe('texts and data', () => {
  it('status first, then players', () => {
    expect(statusLine(status().game)).toBe('Läuft · 2 von 20 Spielern online');
    expect(statusLine(status({}, { status: 'off', statusText: 'Gestoppt' }).game)).toBe('Gestoppt');
    expect(expiresText(null)).toBe('läuft nicht ab');
    expect(
      expiresText(new Date(2026, 11, 3, 23, 4).toISOString(), new Date(2026, 10, 26, 12, 0)),
    ).toBe('gilt bis 03.12. 23:04');
  });

  it('checks player names like the core', () => {
    expect(playerError('Steve_01')).toBeNull();
    expect(playerError('')).toBe('Spielernamen eingeben.');
    expect(playerError('a b')).not.toBeNull();
    expect(playerError('x'.repeat(17))).not.toBeNull();
  });

  it('merges console lines without duplicates and keeps the last 500', () => {
    const line = (id: number) => ({ id: String(id), text: `l${id}`, kind: 'out' as const, ts: '' });
    const a = mergeLines([line(1), line(2)], [line(2), line(3)]);
    expect(a.map((l) => l.id)).toEqual(['1', '2', '3']);
    const many = mergeLines(
      [],
      Array.from({ length: 600 }, (_, i) => line(i)),
    );
    expect(many).toHaveLength(500);
    expect(many[0]?.id).toBe('100');
  });

  it('accepts only well-formed answers', () => {
    expect(isShareStatus(status())).toBe(true);
    expect(isShareStatus({ ...status(), perms: ['admin'] })).toBe(false);
    expect(isShareStatus({ ...status(), game: { ...status().game, status: 'up' } })).toBe(false);
    expect(isConsoleResponse({ lines: [{ id: '1', text: 'x', kind: 'out', ts: '' }] })).toBe(true);
    expect(isConsoleResponse({ lines: [{ id: '1', text: 'x', kind: 'html', ts: '' }] })).toBe(
      false,
    );
  });
});

import type { ShareLink } from '@hz/shared';
import { describe, expect, it } from 'vitest';
import {
  auditIsWarning,
  auditSub,
  AUDIT_TEXT,
  emptyDraft,
  permsFor,
  permsText,
  publicUrlError,
  shareState,
  shareSub,
  sortShares,
  togglePerm,
  validateDraft,
} from './shares.js';

const now = new Date(2026, 10, 26, 23, 4);

function link(over: Partial<ShareLink> = {}): ShareLink {
  return {
    id: 'share-0001',
    gameId: 'game-0001',
    person: 'Max',
    perms: ['power'],
    hasPin: false,
    state: 'active',
    expiresAt: new Date(2026, 11, 3, 23, 4).toISOString(),
    revokedAt: null,
    lastUsedAt: null,
    lockedUntil: null,
    createdAt: new Date(2026, 10, 26, 22, 0).toISOString(),
    ...over,
  };
}

describe('share texts', () => {
  it('lists rights as German text in a fixed order', () => {
    expect(permsText(['console_read', 'power'])).toBe('Starten/Stoppen · Konsole lesen');
    expect(permsText([])).toBe('keine Rechte');
  });

  it('offers the whitelist only for Minecraft Java', () => {
    expect(permsFor('minecraft-java')).toContain('whitelist');
    expect(permsFor('valheim')).not.toContain('whitelist');
    expect(permsFor('valheim')).toHaveLength(4);
  });

  it('maps the state to shape and tag', () => {
    expect(shareState(link(), now)).toEqual({
      status: 'ok',
      tag: 'AKTIV',
      when: 'läuft ab 03.12. 23:04',
      locked: false,
    });
    expect(shareState(link({ expiresAt: null }), now).when).toBe('läuft nie ab');
    const revoked = shareState(
      link({ state: 'revoked', revokedAt: new Date(2026, 10, 26, 21, 30).toISOString() }),
      now,
    );
    expect(revoked).toMatchObject({ status: 'off', tag: 'WIDERRUFEN', when: 'widerrufen 21:30' });
    expect(shareState(link({ state: 'expired' }), now)).toMatchObject({
      status: 'off',
      tag: 'ABGELAUFEN',
    });
  });

  it('shows a PIN lock only while it lasts', () => {
    const locked = shareState(
      link({ hasPin: true, lockedUntil: new Date(2026, 10, 26, 23, 19).toISOString() }),
      now,
    );
    expect(locked.status).toBe('warn');
    expect(locked.tag).toBe('GESPERRT');
    expect(locked.when).toContain('PIN gesperrt bis 23:19');
    const over = shareState(
      link({ hasPin: true, lockedUntil: new Date(2026, 10, 26, 22, 0).toISOString() }),
      now,
    );
    expect(over.tag).toBe('AKTIV');
  });

  it('says PIN and last use', () => {
    expect(shareSub(link(), now)).toBe('ohne PIN · noch nie benutzt');
    expect(
      shareSub(
        link({ hasPin: true, lastUsedAt: new Date(2026, 10, 26, 23, 0).toISOString() }),
        now,
      ),
    ).toBe('mit PIN · zuletzt benutzt vor 4 Min');
  });

  it('sorts active links first, newest first', () => {
    const a = link({ id: 'share-aaaa', state: 'revoked' });
    const b = link({ id: 'share-bbbb', createdAt: '2026-11-20T10:00:00.000Z' });
    const c = link({ id: 'share-cccc', createdAt: '2026-11-25T10:00:00.000Z' });
    expect(sortShares([a, b, c]).map((s) => s.id)).toEqual([
      'share-cccc',
      'share-bbbb',
      'share-aaaa',
    ]);
  });

  it('has a German text for every audit action and marks refused ones', () => {
    expect(AUDIT_TEXT.start).toBe('hat gestartet');
    expect(AUDIT_TEXT.whitelist_add).toBe('hat zur Whitelist hinzugefügt');
    expect(auditIsWarning('denied')).toBe(true);
    expect(auditIsWarning('start')).toBe(false);
    expect(
      auditSub(
        {
          id: 'audit-0001',
          shareId: 'share-0001',
          person: 'Max',
          action: 'start',
          detail: null,
          ts: new Date(2026, 10, 26, 23, 2).toISOString(),
          ip: '203.0.113.7',
          via: 'gateway',
        },
        now,
      ),
    ).toBe('23:02 · über Gateway · 203.0.113.7');
  });
});

describe('create form', () => {
  it('turns reading on with writing and writing off with reading', () => {
    expect(togglePerm(['power'], 'console_write', true)).toEqual([
      'power',
      'console_read',
      'console_write',
    ]);
    expect(togglePerm(['console_read', 'console_write'], 'console_read', false)).toEqual([]);
  });

  it('checks person, rights and PIN before sending', () => {
    const allowed = permsFor('valheim');
    const bad = validateDraft(
      { person: ' ', perms: ['whitelist'], expires: '7d', pin: '12a' },
      allowed,
    );
    expect(bad.body).toBeNull();
    expect(bad.errors).toEqual({
      person: 'Name der Person eingeben.',
      perms: 'Mindestens ein Recht wählen.',
      pin: 'Genau 4 Ziffern oder leer.',
    });
    expect(validateDraft({ ...emptyDraft(), person: 'Max<script>' }, allowed).errors.person).toBe(
      "Höchstens 40 Zeichen: Buchstaben, Ziffern, Leerzeichen und . _ ' -",
    );
  });

  it('builds the request body, PIN only when set', () => {
    const allowed = permsFor('minecraft-java');
    expect(validateDraft({ ...emptyDraft(), person: ' Lena K. ' }, allowed).body).toEqual({
      person: 'Lena K.',
      perms: ['power'],
      expires: '7d',
    });
    expect(
      validateDraft(
        { person: 'Max', perms: ['power', 'whitelist'], expires: 'never', pin: '0420' },
        allowed,
      ).body,
    ).toEqual({ person: 'Max', perms: ['power', 'whitelist'], expires: 'never', pin: '0420' });
  });
});

describe('share gateway URL', () => {
  it('needs an https address without path when switched on', () => {
    expect(publicUrlError('', false)).toBeNull();
    expect(publicUrlError('', true)).toBe('Zum Einschalten die öffentliche Adresse eintragen.');
    expect(publicUrlError('http://spiel.example.org', true)).toBe('Nur https-Adressen.');
    expect(publicUrlError('https://a:b@spiel.example.org', true)).toBe(
      'Ohne Benutzer und Passwort.',
    );
    expect(publicUrlError('https://spiel.example.org/x', true)).toMatch(/ohne Pfad/);
    expect(publicUrlError('spiel.example.org', true)).toBe('Ganze Adresse mit https:// eintragen.');
    expect(publicUrlError('https://spiel.example.duckdns.org', true)).toBeNull();
  });
});

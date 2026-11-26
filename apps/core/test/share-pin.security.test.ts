import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareStatusResponseSchema } from '@hz/shared';
import type * as passwordModule from '../src/auth/password.js';
import { verifyPassword } from '../src/auth/password.js';
import { gameServers, shareAudit, shareLinks } from '../src/db/schema.js';
import { WindowLimiter } from '../src/share/limits.js';
import {
  FRIEND_STATUS_TEXTS,
  friendStatusText,
  PIN_GRANT_MS,
  PIN_MAX_FAILURES,
} from '../src/share/service.js';
import type { WsClient } from './agent-helpers.js';
import { stepUp } from './agent-helpers.js';
import { gameRequest, readyGame, withGames, type GameSetup } from './games-helpers.js';
import type { TestApp } from './helpers.js';
import { createShare, friend, nextIp } from './share-helpers.js';

// Pass-through spy: counts argon2 verifies of share PINs.
vi.mock('../src/auth/password.js', async (importOriginal) => {
  const m = await importOriginal<typeof passwordModule>();
  return { ...m, verifyPassword: vi.fn(m.verifyPassword) };
});
const verifySpy = vi.mocked(verifyPassword);
/** argon2 verifies of 4-digit share PINs so far (the admin password is longer). */
const pinVerifies = (): number => verifySpy.mock.calls.filter(([, p]) => /^\d{4}$/.test(p)).length;

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(): Promise<GameSetup> {
  const s = await withGames(clients);
  t = s.t;
  return s;
}

const MIN = 60_000;
const PIN = '9876';

describe('share PIN tries are reserved before argon2 (S1)', () => {
  it('parallel wrong PINs run at most 5 verifies and the right PIN then gets the same 423', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { pin: PIN });
    const before = pinVerifies();

    // 19 wrong PINs at once, each from its own IP (the token budget is 20 per minute).
    const wrong = Array.from({ length: 19 }, (_, i) =>
      friend(s, 'GET', 'status', { token: link.token, pin: String(1000 + i), ip: nextIp() }),
    );
    // The right PIN comes once the 5 tries are taken (in flight or already locked).
    await vi.waitFor(() => expect(pinVerifies() - before).toBeGreaterThanOrEqual(5));
    const right = friend(s, 'GET', 'status', { token: link.token, pin: PIN, ip: nextIp() });
    const answers = await Promise.all([...wrong, right]);

    expect(pinVerifies() - before).toBe(PIN_MAX_FAILURES);
    const rightRes = answers.at(-1);
    expect(rightRes?.statusCode).toBe(423);
    expect(rightRes?.json()).toEqual({ ok: false, error: 'locked', retryAfter: 900 });
    const codes = answers.slice(0, -1).map((r) => r.statusCode);
    // At most the 4 tries before the 5th give pin_wrong (fewer if they end after the
    // lock was set, then they also get 423); everything else is 423.
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(PIN_MAX_FAILURES - 1);
    expect(codes.every((c) => c === 401 || c === 423)).toBe(true);
    for (const r of answers.filter((a) => a.statusCode === 401)) {
      expect(r.json()).toMatchObject({ ok: false, error: 'pin_wrong' });
    }
    // Every 423 looks the same, whatever PIN was sent: nothing to tell the right PIN apart.
    const lockedBodies = new Set(answers.filter((r) => r.statusCode === 423).map((r) => r.body));
    expect([...lockedBodies]).toEqual([
      JSON.stringify({ ok: false, error: 'locked', retryAfter: 900 }),
    ]);

    // Late tries during the lock (next minute, new token budget): both 423, no verify.
    s.t.clock.advance(MIN);
    const lateRight = await friend(s, 'GET', 'status', { token: link.token, pin: PIN });
    const lateWrong = await friend(s, 'GET', 'status', { token: link.token, pin: '1111' });
    expect(lateRight.statusCode).toBe(423);
    expect(lateWrong.statusCode).toBe(423);
    expect(lateRight.body).toBe(lateWrong.body);
    expect(pinVerifies() - before).toBe(PIN_MAX_FAILURES);

    const row = s.t.db.db.select().from(shareLinks).where(eq(shareLinks.id, link.id)).get();
    expect(row?.lockedUntil).toBeGreaterThan(s.t.clock.t);
    const actions = s.t.db.db
      .select()
      .from(shareAudit)
      .all()
      .map((r) => r.action);
    expect(actions.filter((a) => a === 'pin_failed')).toHaveLength(4);
    expect(actions.filter((a) => a === 'pin_locked')).toHaveLength(1);

    // After the lock the right PIN works and the count starts again.
    s.t.clock.advance(14 * MIN);
    expect((await friend(s, 'GET', 'status', { token: link.token, pin: PIN })).statusCode).toBe(
      200,
    );
    const again = await friend(s, 'GET', 'status', { token: link.token, pin: '1111' });
    expect(again.json()).toEqual({ ok: false, error: 'pin_wrong', triesLeft: 4 });
  });

  it('a stale full counter (crash during a verify) locks instead of blocking forever', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { pin: PIN });
    s.t.db.db
      .update(shareLinks)
      .set({ pinFailures: PIN_MAX_FAILURES, lockedUntil: null })
      .where(eq(shareLinks.id, link.id))
      .run();
    const res = await friend(s, 'GET', 'status', { token: link.token, pin: PIN });
    expect(res.statusCode).toBe(423);
    s.t.clock.advance(15 * MIN);
    expect((await friend(s, 'GET', 'status', { token: link.token, pin: PIN })).statusCode).toBe(
      200,
    );
  });
});

describe('share PIN grant (S4)', () => {
  it('polls with the verified PIN skip argon2; wrong PINs, expiry and revoke still count', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { pin: PIN });
    const before = pinVerifies();

    for (let i = 0; i < 5; i++) {
      const r = await friend(s, 'GET', 'status', { token: link.token, pin: PIN });
      expect(r.statusCode).toBe(200);
    }
    expect(pinVerifies() - before).toBe(1);

    // A wrong PIN is not covered by the grant.
    const bad = await friend(s, 'GET', 'status', { token: link.token, pin: '1234' });
    expect(bad.json()).toEqual({ ok: false, error: 'pin_wrong', triesLeft: 4 });
    expect(pinVerifies() - before).toBe(2);
    // No PIN is still 401 even with a grant for the token.
    expect((await friend(s, 'GET', 'status', { token: link.token })).statusCode).toBe(401);
    expect((await friend(s, 'GET', 'status', { token: link.token, pin: PIN })).statusCode).toBe(
      200,
    );
    expect(pinVerifies() - before).toBe(2);

    // The grant ends after 10 minutes.
    s.t.clock.advance(PIN_GRANT_MS + 1);
    expect((await friend(s, 'GET', 'status', { token: link.token, pin: PIN })).statusCode).toBe(
      200,
    );
    expect(pinVerifies() - before).toBe(3);

    // Revoke wins over the grant at once.
    expect((await gameRequest(s, 'POST', `/api/shares/${link.id}/revoke`)).statusCode).toBe(200);
    const revoked = await friend(s, 'GET', 'status', { token: link.token, pin: PIN });
    expect(revoked.statusCode).toBe(410);
    expect(revoked.json()).toEqual({ ok: false, error: 'revoked' });
    expect(pinVerifies() - before).toBe(3);
  });

  it('expiry wins over the grant', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id, { pin: PIN, expires: '1d' });
    // Grant 2 minutes before the end, so it is still valid when the link expires.
    s.t.clock.advance(24 * 60 * MIN - 2 * MIN);
    expect((await friend(s, 'GET', 'status', { token: link.token, pin: PIN })).statusCode).toBe(
      200,
    );
    s.t.clock.advance(2 * MIN);
    const res = await friend(s, 'GET', 'status', { token: link.token, pin: PIN });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ ok: false, error: 'expired' });
  });
});

describe('share status text is fixed (S2)', () => {
  it('maps every internal status text to a fixed friend text', () => {
    const cases: [Parameters<typeof friendStatusText>, string][] = [
      [['ok', 'Läuft', 'running'], 'Läuft'],
      [['warn', 'TPS niedrig (12,3)', 'running'], 'Läuft, aber langsam'],
      [['warn', 'Antwortet nicht', 'running'], 'Antwortet nicht'],
      [['crit', 'Container abgestürzt (Exit 137)', 'running'], 'Gestört'],
      [['crit', 'Aufsetzen fehlgeschlagen: pull 192.168.1.5 /opt/homelab', 'failed'], 'Gestört'],
      [['off', 'Gestoppt', 'stopped'], 'Gestoppt'],
      [['off', 'Pausiert', 'running'], 'Gestoppt'],
      [['off', 'Server offline', 'running'], 'Nicht erreichbar'],
      [['busy', 'Startet', 'running'], 'Startet'],
      [['busy', 'Neustart', 'running'], 'Startet neu'],
      [['busy', 'Wird gestoppt', 'running'], 'Wird gestoppt'],
      [['busy', 'Backup läuft: 12 MiB', 'running'], 'Backup läuft'],
      [['busy', 'Image lädt von /opt/homelab/x', 'setup'], 'Wird eingerichtet'],
      [['busy', 'Wird gelöscht', 'running'], 'Beschäftigt'],
    ];
    for (const [args, want] of cases) {
      expect(friendStatusText(...args), args[1]).toBe(want);
      expect(FRIEND_STATUS_TEXTS).toContain(want);
    }
  });

  it('agent error details (container id, paths, LAN IPs) never reach the friend', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const link = await createShare(s, g.id);
    const containerId = '3f2a9c1b7d4e8a6b5c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b';
    const detail = `Error response from daemon: container ${containerId} failed: open /opt/homelab/games/${g.id}/data: 192.168.1.23:2375 refused`;
    const leaks = [containerId, containerId.slice(0, 12), '/opt/homelab', '192.168.1.23', g.id];

    for (const [phase, want] of [
      ['failed', 'Gestört'],
      ['setup', 'Wird eingerichtet'],
    ] as const) {
      s.t.db.db
        .update(gameServers)
        .set({ phase, phaseText: detail })
        .where(eq(gameServers.id, g.id))
        .run();
      // The admin sees the detail; that is the text that must not leak.
      expect(s.t.app.hzCore.games.summary(g.id)?.statusText).toContain(containerId);
      const res = await friend(s, 'GET', 'status', { token: link.token });
      expect(res.statusCode, phase).toBe(200);
      const body = shareStatusResponseSchema.parse(res.json());
      expect(body.game.statusText).toBe(want);
      for (const leak of leaks) expect(res.body, `${phase}: ${leak}`).not.toContain(leak);
    }
  });
});

describe('core share limiter has a hard key cap (N1)', () => {
  it('drops the least recently seen key and keeps hot keys', () => {
    let now = 0;
    const l = new WindowLimiter(1, MIN, () => now, 3);
    expect(l.hit('a')).toBeNull();
    expect(l.hit('b')).toBeNull();
    expect(l.hit('c')).toBeNull();
    expect(l.hit('a')).not.toBeNull(); // a is now the most recent
    expect(l.hit('d')).toBeNull(); // evicts b
    expect(l.size).toBe(3);
    expect(l.hit('a')).not.toBeNull(); // a kept its count
    expect(l.hit('b')).toBeNull(); // b was forgotten
    expect(l.size).toBe(3);
    now += MIN;
    expect(l.hit('a')).toBeNull();
  });

  it('stays bounded and fast under a flood of distinct keys', () => {
    const l = new WindowLimiter(10, MIN, () => 0, 1000);
    const start = performance.now();
    for (let i = 0; i < 200_000; i++) l.hit(`k${i}`);
    expect(l.size).toBe(1000);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('links with console_write need step-up (N4)', () => {
  it('refuses console_write without step-up; other links and invalid input as usual', async () => {
    const s = await setup();
    const g = await readyGame(s);
    const url = `/api/games/${g.id}/shares`;
    for (const perms of [['console_write'], ['console_read', 'console_write']]) {
      const res = await gameRequest(s, 'POST', url, { person: 'Max', perms, expires: '7d' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ ok: false, error: 'step_up_required' });
    }
    expect(s.t.db.db.select().from(shareLinks).all()).toHaveLength(0);

    const read = await gameRequest(s, 'POST', url, {
      person: 'Max',
      perms: ['power', 'restart', 'console_read'],
      expires: '7d',
    });
    expect(read.statusCode).toBe(201);
    const bad = await gameRequest(s, 'POST', url, {
      person: 'Max',
      perms: ['console_write', 'root'],
      expires: '7d',
    });
    expect(bad.statusCode).toBe(400);

    await stepUp(s.t, s.secret, s.cookie);
    const ok = await gameRequest(s, 'POST', url, {
      person: 'Max',
      perms: ['console_write'],
      expires: '7d',
    });
    expect(ok.statusCode).toBe(201);
    expect(s.t.db.db.select().from(shareLinks).all()).toHaveLength(2);
  });
});

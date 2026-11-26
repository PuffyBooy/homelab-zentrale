import { describe, expect, it } from 'vitest';
import {
  shareCommandRequestSchema,
  shareCreateRequestSchema,
  sharePersonSchema,
  sharePlayerNameSchema,
  shareStatusResponseSchema,
  shareTokenSchema,
} from './share.js';

describe('share schemas', () => {
  it('tokens are exactly 43 base64url chars', () => {
    expect(shareTokenSchema.safeParse('A'.repeat(43)).success).toBe(true);
    for (const t of ['A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}/`, `${'A'.repeat(42)}=`]) {
      expect(shareTokenSchema.safeParse(t).success).toBe(false);
    }
  });

  it('player names cannot smuggle RCON commands', () => {
    expect(sharePlayerNameSchema.safeParse('Steve_01').success).toBe(true);
    for (const p of ['a', 'Steve; op Max', 'x'.repeat(17), 'Steve\nstop', '@a', 'Ste ve']) {
      expect(sharePlayerNameSchema.safeParse(p).success).toBe(false);
    }
  });

  it('commands are single line and short', () => {
    expect(shareCommandRequestSchema.safeParse({ command: 'list' }).success).toBe(true);
    expect(shareCommandRequestSchema.safeParse({ command: 'say a\nstop' }).success).toBe(false);
    expect(shareCommandRequestSchema.safeParse({ command: 'x'.repeat(201) }).success).toBe(false);
  });

  it('person names have no markup and create requests are strict', () => {
    expect(sharePersonSchema.safeParse('Lena K.').success).toBe(true);
    expect(sharePersonSchema.safeParse('<img src=x>').success).toBe(false);
    expect(
      shareCreateRequestSchema.safeParse({
        person: 'Max',
        perms: ['power'],
        expires: '7d',
        pin: '123',
      }).success,
    ).toBe(false);
    expect(
      shareCreateRequestSchema.safeParse({
        person: 'Max',
        perms: ['power'],
        expires: '7d',
        admin: true,
      }).success,
    ).toBe(false);
  });

  it('the friend status has no room for internal fields', () => {
    const ok = {
      person: 'Max',
      perms: ['power'],
      expiresAt: null,
      game: {
        name: 'mc',
        game: 'Minecraft Java',
        version: '1.21',
        status: 'ok',
        statusText: 'Läuft',
        address: null,
        players: null,
        whitelist: true,
      },
    };
    expect(shareStatusResponseSchema.safeParse(ok).success).toBe(true);
    for (const extra of [
      { serverId: 'x' },
      { tailscaleIp: '100.64.0.1' },
      { containerId: 'abc' },
    ]) {
      expect(
        shareStatusResponseSchema.safeParse({ ...ok, game: { ...ok.game, ...extra } }).success,
      ).toBe(false);
      expect(shareStatusResponseSchema.safeParse({ ...ok, ...extra }).success).toBe(false);
    }
  });
});

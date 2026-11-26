import { describe, expect, it } from 'vitest';
import { hasTokenParam, sortWallTiles, wallTokenFrom } from './wall.js';

const TOKEN = 'A'.repeat(20) + '_-' + 'b'.repeat(21);

describe('wall', () => {
  it('accepts only a well-formed device token', () => {
    expect(TOKEN).toHaveLength(43);
    expect(wallTokenFrom(`?t=${TOKEN}`)).toBe(TOKEN);
    expect(wallTokenFrom('?t=short')).toBeNull();
    expect(wallTokenFrom(`?t=${TOKEN}x`)).toBeNull();
    expect(wallTokenFrom('')).toBeNull();
    expect(hasTokenParam('?t=')).toBe(true);
    expect(hasTokenParam('?x=1')).toBe(false);
  });

  it('puts problem tiles first and keeps the rest in order', () => {
    const tiles = [
      { id: 'servers', tone: 'ok' },
      { id: 'players', tone: 'off' },
      { id: 'temperature', tone: 'warn' },
      { id: 'power', tone: 'ok' },
      { id: 'problems', tone: 'crit' },
    ] as const;
    expect(sortWallTiles(tiles).map((t) => t.id)).toEqual([
      'problems',
      'temperature',
      'servers',
      'players',
      'power',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { backoffDelay } from '../src/backoff.js';

describe('backoffDelay', () => {
  it('doubles the ceiling per attempt, capped at 60 s', () => {
    const max = (n: number) => backoffDelay(n, { random: () => 0.999999 });
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(max)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });

  it('jitters between half the ceiling and the ceiling, never below 1 s', () => {
    for (let n = 0; n < 12; n++) {
      for (const r of [0, 0.25, 0.5, 0.99]) {
        const d = backoffDelay(n, { random: () => r });
        const ceiling = Math.min(60_000, 1000 * 2 ** n);
        expect(d).toBeGreaterThanOrEqual(Math.max(1000, ceiling / 2));
        expect(d).toBeLessThanOrEqual(ceiling);
      }
    }
    expect(backoffDelay(0, { random: () => 0 })).toBe(1000);
    expect(backoffDelay(6, { random: () => 0 })).toBe(30_000);
  });

  it('handles odd inputs', () => {
    expect(backoffDelay(-5, { random: () => 1 })).toBe(1000);
    expect(backoffDelay(1e9, { random: () => 1 })).toBe(60_000);
    expect(backoffDelay(3, { random: () => 7 })).toBe(8000);
    expect(backoffDelay(3, { baseMs: 10, maxMs: 50, random: () => 1 })).toBe(50);
  });
});

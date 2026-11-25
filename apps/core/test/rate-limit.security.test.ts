import { describe, expect, it } from 'vitest';
import { FailureLimiter, loginLimits } from '../src/auth/rate-limit.js';

describe('FailureLimiter', () => {
  it('blocks after max failures, doubles, caps and forgets', () => {
    let now = 0;
    const l = new FailureLimiter(loginLimits, () => now);
    const fail = (n: number) => {
      for (let i = 0; i < n; i++) l.fail('ip');
    };
    fail(4);
    expect(l.check('ip')).toEqual({ blocked: false });
    fail(1);
    expect(l.check('ip')).toEqual({ blocked: true, retryAfter: 900 });
    expect(l.check('other')).toEqual({ blocked: false });
    let expected = 900;
    for (let i = 0; i < 10; i++) {
      now += expected * 1000;
      fail(5);
      expected = Math.min(expected * 2, 86_400);
      expect(l.check('ip')).toEqual({ blocked: true, retryAfter: expected });
    }
    expect(expected).toBe(86_400);
    now += 2 * 86_400_000 + 1;
    fail(5);
    expect(l.check('ip')).toEqual({ blocked: true, retryAfter: 900 });
    l.reset('ip');
    expect(l.check('ip')).toEqual({ blocked: false });
  });
});

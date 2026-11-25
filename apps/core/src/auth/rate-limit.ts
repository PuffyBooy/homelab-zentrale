import type { Clock } from '../clock.js';

export interface LimiterOptions {
  /** Failures allowed inside the window before blocking. */
  max: number;
  windowMs: number;
  /** First block duration; doubles with every further block. */
  baseBlockMs: number;
  maxBlockMs: number;
  /** A key without failures for this long forgets its earlier blocks. */
  forgetMs: number;
}

interface Entry {
  failures: number[];
  strikes: number;
  blockedUntil: number;
  lastActivity: number;
}

export type LimitCheck = { blocked: false } | { blocked: true; retryAfter: number };

/**
 * In-memory failure counter per key (client IP). After `max` failures within
 * `windowMs` the key is blocked for `baseBlockMs`, then 2x, 4x ... up to `maxBlockMs`.
 * State is lost on restart, which is acceptable for a single-admin tailnet app.
 */
export class FailureLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly opts: LimiterOptions,
    private readonly now: Clock,
  ) {}

  check(key: string): LimitCheck {
    const e = this.entries.get(key);
    const now = this.now();
    if (e && e.blockedUntil > now) {
      return { blocked: true, retryAfter: Math.ceil((e.blockedUntil - now) / 1000) };
    }
    return { blocked: false };
  }

  fail(key: string): void {
    const now = this.now();
    let e = this.entries.get(key);
    if (e && now - e.lastActivity > this.opts.forgetMs) e = undefined;
    e ??= { failures: [], strikes: 0, blockedUntil: 0, lastActivity: now };
    e.failures = e.failures.filter((t) => now - t < this.opts.windowMs);
    e.failures.push(now);
    e.lastActivity = now;
    if (e.failures.length >= this.opts.max) {
      const block = Math.min(this.opts.baseBlockMs * 2 ** e.strikes, this.opts.maxBlockMs);
      e.strikes += 1;
      e.blockedUntil = now + block;
      e.failures = [];
    }
    this.entries.set(key, e);
    if (this.entries.size > 1000) this.prune(now);
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [k, e] of this.entries) {
      if (e.blockedUntil <= now && now - e.lastActivity > this.opts.forgetMs)
        this.entries.delete(k);
    }
  }
}

const MIN = 60_000;

/** docs/SECURITY.md: 5 attempts per 15 min per IP, then growing wait. */
export const loginLimits: LimiterOptions = {
  max: 5,
  windowMs: 15 * MIN,
  baseBlockMs: 15 * MIN,
  maxBlockMs: 24 * 60 * MIN,
  forgetMs: 24 * 60 * MIN,
};

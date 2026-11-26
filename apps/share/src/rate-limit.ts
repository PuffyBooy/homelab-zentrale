/**
 * Fixed-window rate limiter with a hard cap on the number of tracked keys.
 * The map is kept in LRU order (re-inserted on every hit), so when it is full the
 * least recently seen key is dropped. Memory never grows beyond `maxKeys` entries.
 */

export type LimitResult = { ok: true } | { ok: false; retryAfter: number };

interface Window {
  start: number;
  count: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly maxKeys: number = 10_000,
  ) {}

  hit(key: string, now: number): LimitResult {
    let w = this.windows.get(key);
    if (w && now - w.start >= this.windowMs) w = undefined;
    if (!w) w = { start: now, count: 0 };
    this.windows.delete(key);
    if (w.count >= this.limit) {
      this.windows.set(key, w);
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000)),
      };
    }
    w.count += 1;
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
    this.windows.set(key, w);
    return { ok: true };
  }

  get size(): number {
    return this.windows.size;
  }
}

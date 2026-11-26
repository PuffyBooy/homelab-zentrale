import type { Clock } from '../clock.js';

/** Default cap of tracked keys per limiter (same as the gateway). */
export const LIMITER_MAX_KEYS = 10_000;

/**
 * Sliding-window request counter per key (in memory, lost on restart).
 * `hit` counts the request and returns null, or the seconds to wait.
 *
 * The map has a hard cap of `maxKeys` entries and is kept in LRU order (a key is
 * re-inserted on every hit), so when it is full the least recently seen key is
 * dropped. Each hit is O(max) for its own list and O(1) amortized for the map.
 */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: Clock,
    private readonly maxKeys: number = LIMITER_MAX_KEYS,
  ) {}

  hit(key: string): number | null {
    const now = this.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.delete(key);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return Math.max(1, Math.ceil((this.windowMs - (now - (list[0] ?? now))) / 1000));
    }
    list.push(now);
    while (this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
    this.hits.set(key, list);
    return null;
  }

  get size(): number {
    return this.hits.size;
  }
}

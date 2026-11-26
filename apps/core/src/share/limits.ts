import type { Clock } from '../clock.js';

/**
 * Sliding-window request counter per key (in memory, lost on restart).
 * `hit` counts the request and returns null, or the seconds to wait.
 */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: Clock,
  ) {}

  hit(key: string): number | null {
    const now = this.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return Math.max(1, Math.ceil((this.windowMs - (now - (list[0] ?? now))) / 1000));
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5000) this.prune(now);
    return null;
  }

  private prune(now: number): void {
    for (const [k, list] of this.hits) {
      if (list.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }
}

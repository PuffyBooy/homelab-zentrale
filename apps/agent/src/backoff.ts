export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Random source in [0, 1). */
  random?: () => number;
}

/**
 * Exponential backoff with jitter: the ceiling doubles per attempt
 * (1 s, 2 s, 4 s ... capped at 60 s), the delay is random in [ceiling/2, ceiling],
 * never below baseMs. `attempt` starts at 0.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 60_000;
  const random = opts.random ?? Math.random;
  const n = Math.max(0, Math.min(Math.floor(attempt), 30));
  const ceiling = Math.min(max, base * 2 ** n);
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(Math.max(base, ceiling * (0.5 + r * 0.5)));
}

/** After a reject for a bad or revoked token, wait this long (no hammering). */
export const REJECT_PAUSE_MS = 10 * 60_000;
/** After a protocol mismatch the agent needs an update, retry rarely. */
export const PROTOCOL_PAUSE_MS = 60 * 60_000;

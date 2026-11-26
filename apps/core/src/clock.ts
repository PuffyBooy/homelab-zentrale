/** Milliseconds since epoch. Injected so tests can move time (step-up, rate limit, TOTP). */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/**
 * One-shot timer, injected so tests can fire timeouts without waiting. Returns
 * a function that cancels the timer (idempotent).
 */
export type SetTimer = (fn: () => void, ms: number) => () => void;

export const systemTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

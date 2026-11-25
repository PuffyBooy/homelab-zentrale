/** Milliseconds since epoch. Injected so tests can move time (step-up, rate limit, TOTP). */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

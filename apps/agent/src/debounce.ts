/**
 * Trailing debounce with a max wait: `fn` runs `waitMs` after the last trigger,
 * but at least every `maxWaitMs` while triggers keep coming (a container in a
 * restart loop must not starve the inventory).
 */
export interface Debounced {
  trigger(): void;
  /** Cancels a pending run. */
  cancel(): void;
  readonly pending: boolean;
}

export function debounce(fn: () => void, waitMs: number, maxWaitMs = waitMs * 5): Debounced {
  let timer: NodeJS.Timeout | null = null;
  let firstAt: number | null = null;

  const run = () => {
    timer = null;
    firstAt = null;
    fn();
  };

  return {
    trigger() {
      const now = Date.now();
      if (firstAt === null) firstAt = now;
      if (timer) clearTimeout(timer);
      const delay = Math.max(0, Math.min(waitMs, firstAt + maxWaitMs - now));
      timer = setTimeout(run, delay);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      firstAt = null;
    },
    get pending() {
      return timer !== null;
    },
  };
}

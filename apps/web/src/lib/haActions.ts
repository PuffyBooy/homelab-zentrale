import type { HaItem, HaState } from '@hz/shared';
import type { QueryClient } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';
import { useHaState } from './data.js';
import { haStateKey, replaceItem, toggleHaEntity, withPending, type PendingToggle } from './ha.js';

/** Same bound as the core: after 10 s a pending switch shows the real state again. */
const PENDING_MS = 10_000;

type Listener = () => void;

/**
 * Clicked toggles, shared by the page, the overview tile and the command palette.
 * Kept outside the query cache so a live snapshot never undoes the optimistic state.
 */
export class PendingToggles {
  private map: ReadonlyMap<string, PendingToggle> = new Map();
  private readonly listeners = new Set<Listener>();

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): ReadonlyMap<string, PendingToggle> => this.map;

  set(entityId: string, value: PendingToggle | null): void {
    const next = new Map(this.map);
    if (value) next.set(entityId, value);
    else next.delete(entityId);
    this.map = next;
    for (const fn of this.listeners) fn();
  }

  get(entityId: string): PendingToggle | undefined {
    return this.map.get(entityId);
  }
}

export const pendingToggles = new PendingToggles();

/**
 * Switches an entity. The switch flips at once; on success the item from the core
 * replaces the cached one; on error the switch reverts and the error is thrown.
 */
export async function runToggle(
  qc: QueryClient,
  entityId: string,
  on: boolean,
  store: PendingToggles = pendingToggles,
): Promise<HaItem> {
  const mine: PendingToggle = { on, inFlight: true };
  store.set(entityId, mine);
  try {
    const item = await toggleHaEntity(entityId, on);
    qc.setQueryData<HaState>(haStateKey, (old) => (old ? replaceItem(old, item) : old));
    if (store.get(entityId) === mine) {
      const done: PendingToggle = { on, inFlight: false };
      store.set(entityId, done);
      setTimeout(() => {
        if (store.get(entityId) === done) store.set(entityId, null);
      }, PENDING_MS);
    }
    return item;
  } catch (err) {
    if (store.get(entityId) === mine) store.set(entityId, null);
    throw err;
  }
}

/** HA state with the optimistic toggles applied. */
export function useHaView(enabled = true): {
  query: ReturnType<typeof useHaState>;
  view: HaState | undefined;
} {
  const query = useHaState(enabled);
  const pending = useSyncExternalStore(
    pendingToggles.subscribe,
    pendingToggles.snapshot,
    pendingToggles.snapshot,
  );
  const view = useMemo(
    () => (query.data ? withPending(query.data, pending) : undefined),
    [query.data, pending],
  );
  return { query, view };
}

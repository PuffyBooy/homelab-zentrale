import type { ContainerSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { containersKey, runContainerAction } from '../../lib/containers.js';
import { gameAction, gamesKey } from '../../lib/games.js';
import { mergeById } from '../../lib/live.js';
import { throttleContainer, topConsumersKey, unthrottleContainer } from '../../lib/throttle.js';

export type ThrottleVars =
  | { kind: 'throttle'; id: string; cpus: number }
  | { kind: 'unthrottle'; id: string }
  /** gameId set: stop through the game route (RCON save, compose down). */
  | { kind: 'stop'; id: string; gameId?: string | null | undefined };

/**
 * The request behind one ThrottleVars. A game is stopped with
 * POST /api/games/:id/stop, never with the plain container stop.
 */
export async function throttleRequest(
  v: ThrottleVars,
): Promise<{ container: ContainerSummary | null; game: boolean }> {
  if (v.kind === 'throttle') return { ...(await throttleContainer(v.id, v.cpus)), game: false };
  if (v.kind === 'unthrottle') return { ...(await unthrottleContainer(v.id)), game: false };
  if (v.gameId) {
    await gameAction(v.gameId, 'stop');
    return { container: null, game: true };
  }
  return { ...(await runContainerAction(v.id, 'stop')), game: false };
}

/**
 * Manual throttle, unthrottle and stop (M10). The returned container goes into
 * the list cache, the top-consumer tile and the games are fetched again.
 */
export function useThrottle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: throttleRequest,
    onSuccess: (res) => {
      const next = res.container;
      if (next) {
        qc.setQueryData<ContainerSummary[]>(containersKey, (old) =>
          old ? mergeById(old, [next]) : old,
        );
      }
      void qc.invalidateQueries({ queryKey: topConsumersKey });
      if (res.game) void qc.invalidateQueries({ queryKey: containersKey });
      if (res.game || next?.gameId) void qc.invalidateQueries({ queryKey: gamesKey, exact: true });
    },
  });
}

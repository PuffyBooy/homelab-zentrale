import type { ContainerAction, ContainerSummary, GameSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { containersKey, runContainerAction } from '../../lib/containers.js';
import { gameAction, gamesKey } from '../../lib/games.js';
import { mergeById } from '../../lib/live.js';

type ActionTarget = Pick<ContainerSummary, 'id'> & { gameId?: string | null };

/**
 * Start, stop and restart of a game container go through the game route (RCON
 * save, compose down/up, RAM reserve check); the core answers 409 on
 * /api/containers/:id/start for game containers. "update" stays a container action.
 */
export async function containerOrGameAction(
  c: ActionTarget,
  action: ContainerAction,
): Promise<{ container: ContainerSummary | null; game: GameSummary | null }> {
  if (c.gameId && action !== 'update') {
    return { container: null, game: await gameAction(c.gameId, action) };
  }
  return { container: (await runContainerAction(c.id, action)).container, game: null };
}

/** Runs a container action and writes the returned container (or game) into the cache. */
export function useContainerAction(c: ActionTarget) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: ContainerAction) => containerOrGameAction(c, action),
    onSuccess: (res) => {
      const next = res.container;
      const game = res.game;
      if (game) {
        qc.setQueryData<GameSummary[]>(gamesKey, (old) => (old ? mergeById(old, [game]) : old));
        void qc.invalidateQueries({ queryKey: containersKey });
      }
      if (!next) return;
      qc.setQueryData<ContainerSummary[]>(containersKey, (old) =>
        old ? mergeById(old, [next]) : old,
      );
    },
  });
}

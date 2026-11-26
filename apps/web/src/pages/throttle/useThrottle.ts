import type { ContainerSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { containersKey, runContainerAction } from '../../lib/containers.js';
import { gamesKey } from '../../lib/games.js';
import { mergeById } from '../../lib/live.js';
import { throttleContainer, topConsumersKey, unthrottleContainer } from '../../lib/throttle.js';

export type ThrottleVars =
  | { kind: 'throttle'; id: string; cpus: number }
  | { kind: 'unthrottle'; id: string }
  | { kind: 'stop'; id: string };

/**
 * Manual throttle, unthrottle and stop (M10). The returned container goes into
 * the list cache, the top-consumer tile and the games are fetched again.
 */
export function useThrottle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: ThrottleVars) =>
      v.kind === 'throttle'
        ? throttleContainer(v.id, v.cpus)
        : v.kind === 'unthrottle'
          ? unthrottleContainer(v.id)
          : runContainerAction(v.id, 'stop'),
    onSuccess: (res) => {
      const next = res.container;
      if (next) {
        qc.setQueryData<ContainerSummary[]>(containersKey, (old) =>
          old ? mergeById(old, [next]) : old,
        );
      }
      void qc.invalidateQueries({ queryKey: topConsumersKey });
      if (next?.gameId) void qc.invalidateQueries({ queryKey: gamesKey, exact: true });
    },
  });
}

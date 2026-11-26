import type { ContainerAction, ContainerSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { containersKey, runContainerAction } from '../../lib/containers.js';
import { mergeById } from '../../lib/live.js';

/** Runs a container action and writes the returned container into the list cache. */
export function useContainerAction(c: Pick<ContainerSummary, 'id'>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: ContainerAction) => runContainerAction(c.id, action),
    onSuccess: (res) => {
      const next = res.container;
      if (!next) return;
      qc.setQueryData<ContainerSummary[]>(containersKey, (old) =>
        old ? mergeById(old, [next]) : old,
      );
    },
  });
}

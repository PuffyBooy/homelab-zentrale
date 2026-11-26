import type { Deploy, RepoSummary } from '@hz/shared';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { reposKey, startDeploy } from '../../lib/github.js';

export interface DeployVars {
  targetIds: string[];
  sha?: string | undefined;
  rollback?: boolean | undefined;
}

/** 409 on deploy: busy (lock per target), ci_not_green, or conflict (unknown commit). */
export function deployErrorText(err: unknown): string {
  if (isApiError(err, 'conflict')) {
    return 'Deploy abgelehnt: Commit nicht auf dem Branch des Ziels oder für Rollback nie erfolgreich deployt.';
  }
  return errorText(err);
}

/**
 * Starts a deploy (or rollback) on one or more targets. Marks the targets as deploying
 * in the cache at once; the live topic `github` brings the real state.
 */
export function useDeploy(
  onStarted?: (deploys: Deploy[]) => void,
): UseMutationResult<Deploy[], unknown, DeployVars> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ targetIds, sha, rollback }: DeployVars) => {
      const out: Deploy[] = [];
      for (const id of targetIds) out.push(await startDeploy(id, { sha, rollback }));
      return out;
    },
    onSuccess: (deploys) => {
      const ids = new Set(deploys.map((d) => d.targetId));
      qc.setQueryData<RepoSummary[]>(reposKey, (old) =>
        old?.map((r) =>
          r.targets.some((t) => ids.has(t.id))
            ? {
                ...r,
                targets: r.targets.map((t) => (ids.has(t.id) ? { ...t, deploying: true } : t)),
              }
            : r,
        ),
      );
      void qc.invalidateQueries({ queryKey: ['github', 'deploys'] });
      onStarted?.(deploys);
    },
  });
}

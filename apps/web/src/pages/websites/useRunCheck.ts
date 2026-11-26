import type { CheckSummary } from '@hz/shared';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { checksKey, runCheck } from '../../lib/checks.js';
import { mergeById } from '../../lib/live.js';

/** "Jetzt prüfen": runs the check and writes the fresh result into the list. */
export function useRunCheck(): UseMutationResult<CheckSummary, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: runCheck,
    onSuccess: (c) => {
      qc.setQueryData<CheckSummary[]>(checksKey, (old) => mergeById(old, [c]));
      void qc.invalidateQueries({ queryKey: [...checksKey, c.id, 'history'] });
    },
  });
}

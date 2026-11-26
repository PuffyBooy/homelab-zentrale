import type { ContainerSummary, GameSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Button } from '@hz/ui';
import { containersKey, runContainerAction } from '../../lib/containers.js';
import { gameAction, gamesKey } from '../../lib/games.js';
import { mergeById } from '../../lib/live.js';
import { autostopTarget } from '../../lib/throttle.js';

/**
 * "Wieder starten" on an autostop alert (SPEC 6a: the core does not restart them on
 * its own). Games start through the game route, so the RAM reserve is checked and
 * 409 insufficient_ram comes back as "Zu wenig RAM, X GB frei" (via `onError`).
 */
export function RestartAutostopButton({
  alertKey,
  containers,
  onError,
}: {
  alertKey: string;
  containers: readonly ContainerSummary[];
  /** Called with the error, or with null when a new start begins. */
  onError: (err: unknown) => void;
}): ReactElement | null {
  const qc = useQueryClient();
  const target = autostopTarget(alertKey, containers);
  const start = useMutation({
    mutationFn: async (t: NonNullable<typeof target>) => {
      if (t.kind === 'game') {
        const game = await gameAction(t.id, 'start');
        qc.setQueryData<GameSummary[]>(gamesKey, (old) => (old ? mergeById(old, [game]) : old));
        return;
      }
      const res = await runContainerAction(t.id, 'start');
      const next = res.container;
      if (next) {
        qc.setQueryData<ContainerSummary[]>(containersKey, (old) =>
          old ? mergeById(old, [next]) : old,
        );
      }
    },
    onError,
  });
  if (!target) return null;
  return (
    <Button
      size="sm"
      icon="play"
      disabled={start.isPending}
      aria-label={`${target.name} wieder starten`}
      onClick={() => {
        onError(null);
        start.mutate(target);
      }}
    >
      {start.isPending ? 'Startet …' : 'Wieder starten'}
    </Button>
  );
}

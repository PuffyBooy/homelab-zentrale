import type { GameSummary } from '@hz/shared';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { backupsKey, gameAction, gamesKey, type GameAction } from '../../lib/games.js';
import { mergeById } from '../../lib/live.js';

/** Error texts for game routes; `busy` means setup, backup or restart is running. */
export function gameErrorText(err: unknown): string {
  if (isApiError(err, 'insufficient_ram')) return errorText(err);
  if (isApiError(err) && err.hint) return err.hint;
  if (isApiError(err, 'busy')) {
    return 'Auf dem Gameserver läuft gerade etwas (Setup, Backup oder Neustart). Kurz warten.';
  }
  if (isApiError(err, 'conflict')) {
    return 'Name oder Port ist auf diesem Server schon vergeben. Anderen wählen.';
  }
  if (isApiError(err, 'confirm_mismatch')) return 'Der Name stimmt nicht. Genau so eintippen.';
  return errorText(err);
}

export interface GameActionVars {
  id: string;
  action: GameAction;
}

/** Start, stop, restart or backup. The answer (busy) goes into the cache at once. */
export function useGameAction(): UseMutationResult<GameSummary, unknown, GameActionVars> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: GameActionVars) => gameAction(id, action),
    onSuccess: (game, { action }) => {
      qc.setQueryData<GameSummary[]>(gamesKey, (old) => (old ? mergeById(old, [game]) : old));
      if (action === 'backup') void qc.invalidateQueries({ queryKey: backupsKey(game.id) });
    },
  });
}

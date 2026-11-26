import type { GameSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { formatBytes, formatWhen } from '../../lib/format.js';
import { restoreBackup } from '../../lib/gameFeatures.js';
import { deleteConfirmed, gamesKey, type GameBackup } from '../../lib/games.js';
import { mergeById } from '../../lib/live.js';
import { gameErrorText } from './useGameAction.js';

export interface RestoreDialogProps {
  game: GameSummary;
  backup: GameBackup;
  now: Date;
  /** Called once the core accepted (202). */
  onStarted: () => void;
  onClose: () => void;
}

/**
 * "Wiederherstellen" (M12): confirmed by typing the name, step-up comes from lib/api.
 * The core takes a fresh backup first, stops the game, restores and starts it again
 * if it ran before. Progress arrives on topic game:<id>.
 */
export function RestoreDialog({
  game,
  backup,
  now,
  onStarted,
  onClose,
}: RestoreDialogProps): ReactElement {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const match = deleteConfirmed(typed, game.name);
  const run = useMutation({
    mutationFn: () => restoreBackup(game.id, backup.id, game.name),
    onSuccess: (saved) => {
      qc.setQueryData<GameSummary[]>(gamesKey, (old) => (old ? mergeById(old, [saved]) : old));
      onStarted();
      onClose();
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (match && !run.isPending) run.mutate();
  }

  const when = formatWhen(new Date(backup.createdAt), now);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Backup von ${when} wiederherstellen`}
      dismissable={false}
    >
      <form className="hz-dialog-body" onSubmit={submit} noValidate>
        <p className="hz-dialog-text">
          {backup.fileName} ({formatBytes(backup.sizeBytes)}) ersetzt die Welt von {game.name}.
          Vorher sichert die Zentrale den jetzigen Stand als neues Backup, stoppt den Server und
          startet ihn danach wieder, wenn er lief.
        </p>
        <Alert tone="warn" title="Alles seit diesem Backup ist aus der Welt weg.">
          Es steckt dann nur noch im frischen Backup von eben.
        </Alert>
        <Field
          label="Name des Gameservers"
          mono
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={game.name}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          data-autofocus=""
        />
        {run.error && !isApiError(run.error, 'step_up_required') ? (
          <FormError title={gameErrorText(run.error)} />
        ) : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="danger" type="submit" disabled={!match || run.isPending}>
            {run.isPending ? 'Startet …' : 'Wiederherstellen'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

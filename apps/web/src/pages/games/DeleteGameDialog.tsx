import type { GameSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { backupsKey, deleteConfirmed, deleteGame, gamesKey } from '../../lib/games.js';
import { gameErrorText } from './useGameAction.js';

export interface DeleteGameDialogProps {
  game: GameSummary;
  onClose: () => void;
}

/**
 * SPEC 6.3: Danger, confirmed by typing the name. The core backs the world up first.
 * Step-up (TOTP) comes from lib/api like for the other step-up routes.
 */
export function DeleteGameDialog({ game, onClose }: DeleteGameDialogProps): ReactElement {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const match = deleteConfirmed(typed, game.name);
  const del = useMutation({
    mutationFn: () => deleteGame(game.id, game.name),
    onSuccess: () => {
      qc.setQueryData<GameSummary[]>(gamesKey, (old) => old?.filter((g) => g.id !== game.id));
      qc.removeQueries({ queryKey: backupsKey(game.id) });
      onClose();
      void navigate('/games');
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (match && !del.isPending) del.mutate();
  }

  return (
    <Dialog open onClose={onClose} title={`${game.name} löschen`} dismissable={false}>
      <form className="hz-dialog-body" onSubmit={submit} noValidate>
        <p className="hz-dialog-text">
          Die Zentrale sichert zuerst die Welt nach /opt/homelab/backups/. Danach stoppt sie den
          Container auf {game.serverName} und entfernt /opt/homelab/games/{game.name}/. Zum
          Bestätigen den Namen eintippen.
        </p>
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
        {del.error ? <FormError title={gameErrorText(del.error)} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="danger" type="submit" disabled={!match || del.isPending}>
            {del.isPending ? 'Sichert und löscht …' : 'Löschen'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

import type { ContainerSummary, GameSummary, Priority } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Tile, Toggle } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { containersKey } from '../../lib/containers.js';
import { errorText } from '../../lib/errors.js';
import { gamesKey } from '../../lib/games.js';
import {
  PRIORITY_OPTIONS,
  isPriority,
  priorityBody,
  saveContainerPriority,
  saveGamePriority,
  topConsumersKey,
} from '../../lib/throttle.js';

const HELP: Record<Priority, string> = {
  wichtig: 'Wird nie gedrosselt oder gestoppt. Fällt er aus, startet die Zentrale ihn neu.',
  normal: 'Wird nicht automatisch angefasst.',
  niedrig: 'Wird gedrosselt, wenn der Server knapp wird.',
};

interface PriorityState {
  priority: Priority;
  allowStop: boolean;
  allowStopWithPlayers: boolean;
}

/** The form for both kinds. `game` adds "auch mit Spielern online". */
function PriorityForm({
  initial,
  game,
  save,
}: {
  initial: PriorityState;
  game: boolean;
  save: {
    mutate: (body: PriorityState) => void;
    isPending: boolean;
    isSuccess: boolean;
    error: unknown;
    reset: () => void;
  };
}): ReactElement {
  const [draft, setDraft] = useState<PriorityState>(initial);
  const niedrig = draft.priority === 'niedrig';
  const body = priorityBody(draft.priority, draft.allowStop, draft.allowStopWithPlayers);
  const dirty =
    body.priority !== initial.priority ||
    body.allowStop !== initial.allowStop ||
    (game && body.allowStopWithPlayers !== initial.allowStopWithPlayers);

  function change(next: Partial<PriorityState>): void {
    setDraft((d) => ({ ...d, ...next }));
    save.reset();
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    save.mutate(body);
  }

  return (
    <form className="hz-form" onSubmit={submit} noValidate>
      <SelectField
        label="Priorität"
        value={draft.priority}
        options={PRIORITY_OPTIONS}
        hint={HELP[draft.priority]}
        onChange={(e) => {
          const v = e.target.value;
          if (isPriority(v)) change({ priority: v });
        }}
      />
      <Toggle
        label="darf gestoppt werden"
        hint={
          niedrig
            ? 'Bleibt der Server trotz Drosselung über der Schwelle, wird gestoppt.'
            : 'nur bei Priorität niedrig'
        }
        checked={body.allowStop}
        disabled={!niedrig}
        onChange={(v) => change({ allowStop: v })}
      />
      {game ? (
        <Toggle
          label="auch mit Spielern online"
          hint={
            body.allowStop
              ? 'Ohne das bleibt der Gameserver an, solange jemand spielt.'
              : 'braucht „darf gestoppt werden“'
          }
          checked={body.allowStopWithPlayers}
          disabled={!body.allowStop}
          onChange={(v) => change({ allowStopWithPlayers: v })}
        />
      ) : null}
      {save.error ? <FormError title={errorText(save.error)} /> : null}
      {save.isSuccess && !dirty ? <Alert tone="ok" title="Priorität gespeichert." /> : null}
      <div className="hz-form-actions">
        <Button type="submit" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Speichert …' : 'Speichern'}
        </Button>
      </div>
    </form>
  );
}

/** Container detail (SPEC 6a): priority, protected containers read only, games link away. */
export function ContainerPriorityTile({ c }: { c: ContainerSummary }): ReactElement {
  return (
    <Tile title="Priorität" icon="cpu" span={2}>
      <ContainerPriorityBody c={c} />
    </Tile>
  );
}

export function ContainerPriorityBody({ c }: { c: ContainerSummary }): ReactElement {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (b: PriorityState) =>
      saveContainerPriority(c.id, { priority: b.priority, allowStop: b.allowStop }),
    onSuccess: (res) => {
      qc.setQueryData<ContainerSummary[]>(containersKey, (old) =>
        old?.map((x) =>
          x.id === res.containerId ? { ...x, priority: res.priority, allowStop: res.allowStop } : x,
        ),
      );
      void qc.invalidateQueries({ queryKey: topConsumersKey });
    },
  });

  if (c.protected) {
    return (
      <>
        <dl className="app-kv">
          <dt>Priorität</dt>
          <dd>wichtig</dd>
        </dl>
        <p className="app-text">
          Zentrale/Agent: immer wichtig. {c.name} wird nie gedrosselt oder gestoppt.
        </p>
      </>
    );
  }
  if (c.gameId) {
    return (
      <>
        <dl className="app-kv">
          <dt>Priorität</dt>
          <dd>{c.priority}</dd>
        </dl>
        <p className="app-text">
          {c.name} gehört zu einem Gameserver. Die Priorität stellst du dort ein.
        </p>
        <div className="hz-form-actions">
          <Link className="hz-btn hz-btn-secondary hz-btn-md" to={`/games/${c.gameId}`}>
            Zum Gameserver
          </Link>
        </div>
      </>
    );
  }
  return (
    <PriorityForm
      key={`${c.id}:${c.priority}:${String(c.allowStop)}`}
      initial={{ priority: c.priority, allowStop: c.allowStop, allowStopWithPlayers: false }}
      game={false}
      save={save}
    />
  );
}

/** Game detail (SPEC 6a): priority with "auch mit Spielern online". */
export function GamePriorityTile({ game }: { game: GameSummary }): ReactElement {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (b: PriorityState) => saveGamePriority(game.id, b),
    onSuccess: (res) => {
      qc.setQueryData<GameSummary[]>(gamesKey, (old) =>
        old?.map((g) =>
          g.id === res.gameId
            ? {
                ...g,
                priority: res.priority,
                allowStop: res.allowStop,
                allowStopWithPlayers: res.allowStopWithPlayers,
              }
            : g,
        ),
      );
      void qc.invalidateQueries({ queryKey: containersKey });
      void qc.invalidateQueries({ queryKey: topConsumersKey });
    },
  });
  return (
    <Tile title="Priorität" icon="cpu" span={2}>
      <PriorityForm
        key={`${game.id}:${game.priority}:${String(game.allowStop)}:${String(game.allowStopWithPlayers)}`}
        initial={{
          priority: game.priority,
          allowStop: game.allowStop,
          allowStopWithPlayers: game.allowStopWithPlayers,
        }}
        game
        save={save}
      />
    </Tile>
  );
}

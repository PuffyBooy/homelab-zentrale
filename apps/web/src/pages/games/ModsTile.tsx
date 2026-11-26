import type { GameSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Badge, Button, Tile } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes } from '../../lib/format.js';
import {
  downloadsText,
  fetchMods,
  installMod,
  modSearchKey,
  modsKey,
  modsWord,
  removeMod,
  searchMods,
  type GameMods,
} from '../../lib/gameFeatures.js';
import { gameErrorText, useGameAction } from './useGameAction.js';

/**
 * Mods/Plugins (M12, SPEC 6.5): Paper plugins or Fabric mods from Modrinth. Files come
 * only from cdn.modrinth.com with sha512 (checked by core and agent). Changes need a
 * restart, the tile says so and offers the button.
 */
export function ModsTile({
  game,
  kind,
}: {
  game: GameSummary;
  kind: 'plugins' | 'mods';
}): ReactElement {
  const qc = useQueryClient();
  const word = modsWord(kind);
  const mods = useQuery({
    queryKey: modsKey(game.id),
    queryFn: ({ signal }) => fetchMods(game.id, signal),
  });
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const hits = useQuery({
    queryKey: modSearchKey(game.id, query ?? ''),
    queryFn: ({ signal }) => searchMods(game.id, query ?? '', signal),
    enabled: query !== null,
    staleTime: 60_000,
  });
  const done = (next: GameMods): void => {
    qc.setQueryData(modsKey(game.id), next);
    void qc.invalidateQueries({ queryKey: ['games', 'mods', game.id, 'search'] });
  };
  const install = useMutation({
    mutationFn: (projectId: string) => installMod(game.id, projectId),
    onSuccess: done,
  });
  const restart = useGameAction();

  function search(e: FormEvent): void {
    e.preventDefault();
    setQuery(typed.trim());
  }

  const files = mods.data?.files ?? [];
  const busy = game.status === 'busy' || restart.isPending;

  return (
    <Tile
      title={word.title}
      icon="plug"
      count={mods.data ? String(files.length) : undefined}
      span={2}
      flush
      footer={
        <span className="app-foot-text">
          Modrinth
          {mods.data
            ? ` · ${mods.data.loader}${mods.data.gameVersion ? ` ${mods.data.gameVersion}` : ''}`
            : ''}{' '}
          · nur cdn.modrinth.com, sha512 geprüft
        </span>
      }
    >
      {mods.error && !mods.data ? (
        <div className="app-pad">
          <FormError title={errorText(mods.error)} />
        </div>
      ) : null}
      {mods.data?.restartNeeded ? (
        <div className="app-pad">
          <Alert
            tone="warn"
            title="Neustart nötig."
            action={
              <Button
                size="sm"
                icon="refresh"
                disabled={busy}
                onClick={() => restart.mutate({ id: game.id, action: 'restart' })}
              >
                {restart.isPending ? 'Startet neu …' : 'Neu starten'}
              </Button>
            }
          >
            {word.title} sind geändert. Sie wirken erst nach dem Neustart von {game.name}.
          </Alert>
        </div>
      ) : null}
      {restart.error ? (
        <div className="app-pad">
          <FormError title={gameErrorText(restart.error)} />
        </div>
      ) : null}
      {mods.data && files.length === 0 ? (
        <p className="app-empty app-pad">Noch keine {word.title}.</p>
      ) : null}
      {files.map((f) => (
        <div key={f.fileName} className="hz-row" data-testid="mod-file">
          <div className="hz-row-main">
            <span className="hz-row-name app-break">{f.title ?? f.fileName}</span>
            <span className="hz-row-sub app-break">
              {f.title ? `${f.fileName} · ` : ''}
              {formatBytes(f.sizeBytes)}
            </span>
          </div>
          <div className="hz-row-actions">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${f.title ?? f.fileName} entfernen`}
              onClick={() => setRemoving(f.fileName)}
            >
              Entfernen
            </Button>
          </div>
        </div>
      ))}
      <form className="app-pad hz-form" onSubmit={search} noValidate role="search">
        <Field
          label={`${word.title} suchen`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={kind === 'plugins' ? 'z. B. EssentialsX' : 'z. B. Lithium'}
          maxLength={80}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="hz-form-actions">
          <Button type="submit" disabled={hits.isFetching}>
            {hits.isFetching ? 'Sucht …' : 'Suchen'}
          </Button>
        </div>
        {hits.error ? <FormError title={errorText(hits.error)} /> : null}
        {install.error ? <FormError title={gameErrorText(install.error)} /> : null}
      </form>
      {query !== null && hits.data && hits.data.length === 0 ? (
        <p className="app-empty app-pad">
          Nichts gefunden, das zu {mods.data?.loader ?? 'diesem Server'} passt.
        </p>
      ) : null}
      {hits.data?.map((h) => (
        <div key={h.projectId} className="hz-row" data-testid="mod-hit">
          <div className="hz-row-main">
            <span className="hz-row-name">{h.title}</span>
            <span className="hz-row-sub">
              {h.description} · {downloadsText(h.downloads)}
            </span>
          </div>
          <div className="hz-row-actions">
            {h.installed ? (
              <Badge tone="ok">installiert</Badge>
            ) : (
              <Button
                size="sm"
                disabled={install.isPending}
                aria-label={`${h.title} installieren`}
                onClick={() => install.mutate(h.projectId)}
              >
                {install.isPending && install.variables === h.projectId
                  ? 'Installiert …'
                  : 'Installieren'}
              </Button>
            )}
          </div>
        </div>
      ))}
      {removing ? (
        <RemoveModDialog
          game={game}
          fileName={removing}
          title={files.find((f) => f.fileName === removing)?.title ?? null}
          onDone={done}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </Tile>
  );
}

function RemoveModDialog({
  game,
  fileName,
  title,
  onDone,
  onClose,
}: {
  game: GameSummary;
  fileName: string;
  title: string | null;
  onDone: (next: GameMods) => void;
  onClose: () => void;
}): ReactElement {
  const del = useMutation({
    mutationFn: () => removeMod(game.id, fileName),
    onSuccess: (next) => {
      onDone(next);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`${title ?? fileName} entfernen`}>
      <div className="hz-dialog-body">
        <p className="hz-dialog-text">
          Löscht {fileName} aus dem Ordner von {game.name}. Wirkt nach dem nächsten Neustart.
        </p>
        {del.error ? <FormError title={gameErrorText(del.error)} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose} data-autofocus="">
            Abbrechen
          </Button>
          <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate()}>
            {del.isPending ? 'Entfernt …' : 'Entfernen'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

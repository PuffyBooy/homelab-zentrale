import type { GameSummary, MigrationSuggestResponse, ServerSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes } from '../../lib/format.js';
import { portLabel } from '../../lib/games.js';
import {
  changedPortLines,
  fetchMigrationSuggest,
  migrateErrorText,
  migrationKey,
  migrationSuggestKey,
  migrationTargets,
  startMigration,
} from '../../lib/migrate.js';

export interface MigrateDialogProps {
  game: GameSummary;
  onClose: () => void;
}

/**
 * "Umziehen …" (ROADMAP M11): pick an online target, see the new ports and RAM, then
 * confirm (step-up via api()). Progress is shown by MigrationTile on the game page.
 */
export function MigrateDialog({ game, onClose }: MigrateDialogProps): ReactElement {
  const servers = useServers();
  const targets = migrationTargets(servers.data ?? [], game);
  const [targetId, setTargetId] = useState('');
  const target = targets.find((s) => s.id === targetId);
  const qc = useQueryClient();
  const suggest = useQuery({
    queryKey: migrationSuggestKey(game.id, targetId),
    queryFn: ({ signal }) => fetchMigrationSuggest(game.id, targetId, signal),
    enabled: targetId !== '',
    staleTime: 0,
  });
  const migrate = useMutation({
    mutationFn: () => startMigration(game.id, { targetServerId: targetId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: migrationKey(game.id) });
      onClose();
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (target && suggest.data && !migrate.isPending) migrate.mutate();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${game.name} umziehen`}
      className="app-dialog-wide"
      dismissable={false}
    >
      <form className="hz-dialog-body" onSubmit={submit} noValidate data-testid="migrate-dialog">
        <MigrateIntro game={game} />
        {servers.data && targets.length === 0 ? (
          <p className="app-empty">
            Kein anderer Server ist gerade verbunden. Ein Umzug braucht einen zweiten Server mit
            laufendem Agent.
          </p>
        ) : (
          <SelectField
            label="Zielserver"
            value={targetId}
            onChange={(e) => {
              setTargetId(e.target.value);
              migrate.reset();
            }}
            options={[
              { value: '', label: 'Server wählen …' },
              ...targets.map((s) => ({ value: s.id, label: targetLabel(s) })),
            ]}
            data-autofocus=""
          />
        )}
        {target && suggest.isPending ? <p className="app-empty">Prüft {target.name} …</p> : null}
        {suggest.error ? <FormError title={errorText(suggest.error)} /> : null}
        {target && suggest.data ? (
          <SuggestView game={game} target={target} s={suggest.data} />
        ) : null}
        {migrateErrorText(migrate.error) ? (
          <FormError title={migrateErrorText(migrate.error) ?? ''} />
        ) : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!target || !suggest.data || migrate.isPending}
          >
            {migrate.isPending ? 'Startet …' : target ? `Nach ${target.name} umziehen` : 'Umziehen'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function targetLabel(s: ServerSummary): string {
  return s.location ? `${s.name} · ${s.location}` : s.name;
}

export function MigrateIntro({ game }: { game: Pick<GameSummary, 'name' | 'serverName'> }) {
  return (
    <p className="hz-dialog-text">
      Die Zentrale speichert und stoppt {game.name} auf {game.serverName}, überträgt die Welt und
      startet sie am Ziel. Bricht etwas ab, bleibt {game.name} auf {game.serverName}. Braucht einen
      Code aus der Authenticator-App.
    </p>
  );
}

/** Ports, forwarding and RAM on the target (pure, unit tested). */
export function SuggestView({
  game,
  target,
  s,
}: {
  game: Pick<GameSummary, 'name' | 'ports'> & Partial<Pick<GameSummary, 'relay'>>;
  target: Pick<ServerSummary, 'name'>;
  s: MigrationSuggestResponse;
}): ReactElement {
  const protocols = new Map(game.ports.map((p) => [p.name, p]));
  const changed = changedPortLines(s.changed);
  return (
    <div className="app-stack" data-testid="migrate-suggest">
      <dl className="app-kv">
        <dt>Ports am Ziel</dt>
        <dd>
          {Object.entries(s.ports)
            .map(([name, port]) => {
              const p = protocols.get(name);
              return p ? `${name} ${portLabel(port, p.protocol)}` : `${name} ${port}`;
            })
            .join(' · ') || '—'}
        </dd>
        <dt>Geändert</dt>
        <dd>{changed.length ? changed.join(' · ') : 'keine, gleiche Ports wie jetzt'}</dd>
        <dt>RAM frei</dt>
        <dd>
          {s.freeRamBytes == null ? '—' : `${formatBytes(s.freeRamBytes)} auf ${target.name}`}
        </dd>
      </dl>
      {s.ramWarning ? <Alert tone="warn" title={s.ramWarning} /> : null}
      {game.relay ? (
        <Alert tone="info" title={`Adresse bleibt gleich (über ${game.relay.ingressName}).`}>
          Die Zentrale stellt die Weiterleitung am Eingang auf {target.name} um. Keine
          Portweiterleitung nötig.
        </Alert>
      ) : s.forwardingHint ? (
        <Alert tone="warn" title={s.forwardingHint}>
          Freunde ohne Tailscale erreichen {game.name} erst wieder, wenn die Weiterleitung am Router
          (bzw. die Security List in der Cloud) für {target.name} eingerichtet ist.
        </Alert>
      ) : (
        <Alert tone="info" title="Keine neue Portweiterleitung nötig." />
      )}
    </div>
  );
}

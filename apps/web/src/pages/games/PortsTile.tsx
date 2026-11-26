import type { GamePortsUpdateResponse, GameSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, Tile } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import {
  changeGamePorts,
  gamesKey,
  portLabel,
  portsDraft,
  protocolText,
  validatePorts,
  withoutError,
  type CreateErrors,
  type TemplateInfo,
} from '../../lib/games.js';
import { mergeById } from '../../lib/live.js';
import { gameErrorText } from './useGameAction.js';

/** Error of the whole form; step-up cancelled shows nothing (the dialog said it all). */
function portsErrorText(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  if (isApiError(err, 'conflict')) {
    return 'Port ist auf diesem Server schon belegt (anderes Spiel, Container oder Dienst). Anderen wählen.';
  }
  if (isApiError(err, 'invalid_input') && !(isApiError(err) && err.hint)) {
    return 'Port ungültig: 1024 bis 65535, nicht doppelt und nicht der RCON-Port.';
  }
  return gameErrorText(err);
}

/**
 * "Ports ändern" (decision 2026-11-26): new host ports after setup, step-up. A running
 * game is recreated. Afterwards the port forwarding has to be adjusted by hand.
 */
export function PortsTile({
  game,
  tpl,
}: {
  game: GameSummary;
  tpl: TemplateInfo | undefined;
}): ReactElement {
  return (
    <Tile title="Ports ändern" icon="globe" span={2}>
      {tpl ? (
        <PortsForm key={game.id} game={game} tpl={tpl} />
      ) : (
        <p className="app-empty">
          Vorlage {game.templateId} fehlt in templates/games/. Ohne sie lassen sich die Ports nicht
          ändern.
        </p>
      )}
    </Tile>
  );
}

function PortsForm({ game, tpl }: { game: GameSummary; tpl: TemplateInfo }): ReactElement {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>(() => portsDraft(game));
  const [errors, setErrors] = useState<CreateErrors>({});
  const [done, setDone] = useState<GamePortsUpdateResponse | null>(null);
  const change = useMutation({
    mutationFn: (ports: Record<string, number>) => changeGamePorts(game.id, ports),
    onSuccess: (res) => {
      qc.setQueryData<GameSummary[]>(gamesKey, (old) => (old ? mergeById(old, [res.game]) : old));
      setDraft(portsDraft(res.game));
      setDone(res);
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = validatePorts(tpl.ports, draft);
    setErrors(res.errors);
    if (Object.keys(res.errors).length) return;
    setDone(null);
    change.mutate(res.ports);
  }

  const formError = portsErrorText(change.error);
  const current = new Map(game.ports.map((p) => [p.name, p.port]));

  return (
    <form className="hz-form" onSubmit={submit} noValidate data-testid="ports-form">
      <p className="app-text">
        Neue Ports gelten sofort, ein laufender Server startet dafür neu. Freunde ohne Tailscale
        erreichen ihn erst wieder, wenn die Portweiterleitung angepasst ist. Braucht einen Code.
      </p>
      <div className="app-fields">
        {tpl.ports.map((p) => (
          <Field
            key={p.name}
            label={`Port ${p.name} (${protocolText(p.protocol)})`}
            mono
            inputMode="numeric"
            value={draft[p.name] ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setDraft((d) => ({ ...d, [p.name]: v }));
              setErrors((x) => withoutError(x, `port:${p.name}`));
              change.reset();
            }}
            hint={
              p.local
                ? 'nur lokal (127.0.0.1), keine Weiterleitung nötig'
                : `jetzt ${portLabel(current.get(p.name) ?? p.default, p.protocol, p.count)}`
            }
            error={errors[`port:${p.name}`]}
            autoComplete="off"
          />
        ))}
      </div>
      {formError ? <FormError title={formError} /> : null}
      {done ? <PortsDone res={done} name={game.name} /> : null}
      <div className="hz-form-actions">
        <Button type="submit" icon="refresh" disabled={change.isPending || game.status === 'busy'}>
          {change.isPending ? 'Ändert …' : 'Ports ändern'}
        </Button>
      </div>
    </form>
  );
}

function PortsDone({ res, name }: { res: GamePortsUpdateResponse; name: string }): ReactElement {
  if (res.changed.length === 0) {
    return (
      <Alert tone="info" title="Keine Änderung.">
        Die Ports von {name} sind schon so eingestellt.
      </Alert>
    );
  }
  if (res.forwardingHint) {
    return (
      <div data-testid="forwarding-hint">
        <Alert tone="warn" title={res.forwardingHint}>
          Ports von {name} geändert. Bis die Weiterleitung am Router (bzw. die Security List in der
          Cloud) angepasst ist, erreichen Freunde ohne Tailscale den Server nicht.
        </Alert>
      </div>
    );
  }
  return (
    <Alert tone="ok" title="Ports geändert.">
      Nur lokale Ports, an der Weiterleitung ändert sich nichts.
    </Alert>
  );
}

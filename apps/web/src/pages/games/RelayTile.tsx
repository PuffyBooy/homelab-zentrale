import type { GameRelay, GameSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Alert, Button, StatusDot, Tile } from '@hz/ui';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { gamesKey } from '../../lib/games.js';
import {
  DIRECT,
  DOMAINS_PATH,
  fetchGameRelay,
  fetchIngresses,
  gameRelayErrorText,
  gameRelayKey,
  ingressesKey,
  parseDnsName,
  relayChoiceLabel,
  relayChoices,
  relayDnsStatus,
  relayStatus,
  saveGameRelay,
  type GameRelayInput,
} from '../../lib/relay.js';

/**
 * Gameserver → "Erreichbar über" (ROADMAP M15): direct, or through an ingress that relays
 * the game ports via Tailscale. Optional fixed DNS name. Changing it needs step-up.
 */
export function RelayTile({ game }: { game: GameSummary }): ReactElement {
  const relayQuery = useQuery({
    queryKey: gameRelayKey(game.id),
    queryFn: ({ signal }) => fetchGameRelay(game.id, signal),
    // Pending means "waiting for the ingress agent": ask again until it settles.
    refetchInterval: (q) => (q.state.data?.state === 'pending' ? 5000 : false),
  });
  const relay: GameRelay | null =
    relayQuery.data !== undefined ? relayQuery.data : (game.relay ?? null);

  return (
    <Tile
      title="Erreichbar über"
      icon="door"
      span={2}
      status={relay ? relayStatus(relay).status : 'off'}
      statusLabel={relay ? relayStatus(relay).label : 'DIREKT'}
    >
      {relayQuery.isError && relayQuery.data === undefined ? (
        <FormError title={gameRelayErrorText(relayQuery.error) ?? ''} />
      ) : null}
      {relay ? <RelayView relay={relay} /> : <DirectView game={game} />}
      <RelayForm key={relay?.ingressServerId ?? DIRECT} game={game} relay={relay} />
    </Tile>
  );
}

function DirectView({ game }: { game: GameSummary }): ReactElement {
  return (
    <p className="app-text">
      Direkt: Freunde verbinden sich mit {game.address}. Ohne Tailscale braucht das eine
      Portweiterleitung zu {game.serverName}. Mit einem Eingang ist sie nicht nötig, und die Adresse
      bleibt beim Umzug gleich.
    </p>
  );
}

function RelayView({ relay }: { relay: GameRelay }): ReactElement {
  const st = relayStatus(relay);
  const dns = relayDnsStatus(relay);
  return (
    <div className="app-stack" data-testid="game-relay">
      <dl className="app-kv">
        <dt>Eingang</dt>
        <dd>
          <Link to="/settings#eingaenge">{relay.ingressName}</Link>
        </dd>
        <dt>Zustand</dt>
        <dd>
          <StatusDot status={st.status} label={st.label} />
        </dd>
        <dt>DNS-Name</dt>
        <dd className="app-break">{relay.dnsName ?? 'keiner'}</dd>
        <dt>DNS</dt>
        <dd>{dns ? <StatusDot status={dns.status} label={dns.label} /> : 'kein Name'}</dd>
      </dl>
      {relay.dnsOk === false ? (
        <Alert
          tone="warn"
          title={relay.dnsError ?? 'DNS-Eintrag zeigt noch nicht auf den Eingang.'}
        >
          Anbieter und Einträge unter <Link to={DOMAINS_PATH}>Internet → Domains</Link>.
        </Alert>
      ) : null}
      {relay.address ? (
        <CopyBlock label="Adresse für Freunde" text={relay.address} inline />
      ) : (
        <p className="app-empty">Adresse fehlt: Der Eingang hat keine öffentliche IPv4.</p>
      )}
      {relay.state === 'error' ? (
        <Alert tone="crit" title="Weiterleitung am Eingang fehlgeschlagen.">
          {relay.error ?? 'Log des Agents am Eingang prüfen.'}
        </Alert>
      ) : null}
    </div>
  );
}

function RelayForm({ game, relay }: { game: GameSummary; relay: GameRelay | null }): ReactElement {
  const qc = useQueryClient();
  const ingresses = useQuery({
    queryKey: ingressesKey,
    queryFn: ({ signal }) => fetchIngresses(signal),
  });
  const [target, setTarget] = useState(relay?.ingressServerId ?? DIRECT);
  const [dnsName, setDnsName] = useState(relay?.dnsName ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: GameRelayInput) => saveGameRelay(game.id, body),
    onSuccess: (next) => {
      qc.setQueryData(gameRelayKey(game.id), next);
      void qc.invalidateQueries({ queryKey: gamesKey });
      void qc.invalidateQueries({ queryKey: ingressesKey });
    },
  });

  const choices = relayChoices(ingresses.data ?? [], game);
  const options = [
    { value: DIRECT, label: 'Direkt (ohne Eingang)' },
    ...choices.map((i) => ({ value: i.serverId, label: relayChoiceLabel(i) })),
  ];
  // Keep the current ingress selectable even if it is no longer capable.
  if (relay && !choices.some((i) => i.serverId === relay.ingressServerId)) {
    options.push({ value: relay.ingressServerId, label: `${relay.ingressName} · nicht bereit` });
  }
  const dirty =
    target !== (relay?.ingressServerId ?? DIRECT) ||
    (target !== DIRECT && dnsName.trim().toLowerCase() !== (relay?.dnsName ?? ''));

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (target === DIRECT) {
      save.mutate({ ingressServerId: null });
      return;
    }
    const name = parseDnsName(dnsName);
    if (!name.ok) {
      setNameError(name.error);
      return;
    }
    save.mutate({ ingressServerId: target, dnsName: name.name });
  }

  const err = gameRelayErrorText(save.error);
  const noChoice = ingresses.data !== undefined && choices.length === 0 && !relay;

  return (
    <form className="hz-form" onSubmit={submit} noValidate>
      {noChoice ? (
        <p className="app-empty">
          Kein Eingang bereit. Einen Server mit öffentlicher IPv4 unter{' '}
          <Link to="/settings#eingaenge">Einstellungen → Eingänge</Link> einschalten.{' '}
          {game.serverName} selbst geht nicht.
        </p>
      ) : (
        <SelectField
          label="Eingang"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            save.reset();
          }}
          options={options}
          hint={`Nur eingeschaltete Eingänge mit erlaubtem Relay, nicht ${game.serverName}.`}
        />
      )}
      {target !== DIRECT ? (
        <Field
          label="DNS-Name (optional)"
          mono
          autoComplete="off"
          spellCheck={false}
          maxLength={253}
          placeholder="mc.example.org"
          value={dnsName}
          onChange={(e) => {
            setDnsName(e.target.value);
            setNameError(null);
            save.reset();
          }}
          hint={
            <>
              Die Zentrale setzt den A-Record auf die IPv4 des Eingangs, beim Anbieter aus{' '}
              <Link to={DOMAINS_PATH}>Internet → Domains</Link>, dessen Zone den Namen enthält.
            </>
          }
          error={nameError}
        />
      ) : null}
      {err ? <FormError title={err} /> : null}
      {save.isSuccess && !dirty ? (
        <Alert tone="ok" title="Gespeichert.">
          {save.data
            ? `${game.name} läuft jetzt über ${save.data.ingressName}.`
            : `${game.name} ist wieder direkt erreichbar.`}
        </Alert>
      ) : null}
      {noChoice ? null : (
        <div className="hz-form-actions">
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Speichert …' : 'Speichern'}
          </Button>
        </div>
      )}
    </form>
  );
}

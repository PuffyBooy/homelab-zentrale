import type { GameSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Badge, Button, Tile, Toggle } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatWhen } from '../../lib/format.js';
import {
  discordUrlError,
  fetchNotify,
  NOTIFY_EVENT_TEXT,
  NOTIFY_EVENTS,
  notifyKey,
  saveNotify,
  testNotify,
  toggleEvent,
  type GameNotify,
  type GameNotifyEvent,
} from '../../lib/gameFeatures.js';

/** A closed step-up dialog is not an error to show. */
function shown(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return errorText(err);
}

/**
 * Discord (M12, SPEC 6.5): one webhook per game. The URL is a secret: it is sent once
 * (with step-up) and never shown again, the tile only knows "gesetzt".
 */
export function NotifyTile({ game, now }: { game: GameSummary; now: Date }): ReactElement {
  const q = useQuery({
    queryKey: notifyKey(game.id),
    queryFn: ({ signal }) => fetchNotify(game.id, signal),
  });
  return (
    <Tile
      title="Discord"
      icon="bell"
      span={2}
      actions={
        q.data ? (
          <Badge tone={q.data.discordSet ? 'ok' : 'neutral'}>
            {q.data.discordSet ? 'gesetzt' : 'nicht gesetzt'}
          </Badge>
        ) : null
      }
      footer={
        <span className="app-foot-text">
          Nachricht nur mit Name, Spiel, externer Adresse und Spielerzahl
        </span>
      }
    >
      {q.error && !q.data ? <FormError title={errorText(q.error)} /> : null}
      {q.data ? <NotifyForm game={game} data={q.data} now={now} /> : null}
    </Tile>
  );
}

function NotifyForm({
  game,
  data,
  now,
}: {
  game: GameSummary;
  data: GameNotify;
  now: Date;
}): ReactElement {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const done = (next: GameNotify): void => {
    qc.setQueryData(notifyKey(game.id), next);
  };
  const setHook = useMutation({
    mutationFn: (discordWebhookUrl: string | null) =>
      saveNotify(game.id, { discordWebhookUrl, events: data.events }),
    onSuccess: (next) => {
      done(next);
      setUrl('');
    },
  });
  const events = useMutation({
    mutationFn: (list: GameNotifyEvent[]) => saveNotify(game.id, { events: list }),
    onSuccess: done,
  });
  const test = useMutation({
    mutationFn: () => testNotify(game.id),
    onSettled: () => void qc.invalidateQueries({ queryKey: notifyKey(game.id) }),
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const err = discordUrlError(url);
    setUrlError(err);
    if (!err && !setHook.isPending) setHook.mutate(url.trim());
  }

  const current = events.isPending && events.variables ? events.variables : data.events;
  const hookErr = shown(setHook.error);

  return (
    <div className="hz-form">
      <form className="hz-form" onSubmit={submit} noValidate>
        <Field
          label={data.discordSet ? 'Neue Webhook-URL' : 'Webhook-URL'}
          mono
          type="password"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setUrlError(null);
            setHook.reset();
          }}
          placeholder="https://discord.com/api/webhooks/…"
          hint="Discord → Servereinstellungen → Integrationen → Webhooks. Wird verschlüsselt gespeichert und nicht mehr angezeigt."
          error={urlError}
          maxLength={300}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        {hookErr ? <FormError title={hookErr} /> : null}
        <div className="hz-form-actions">
          {data.discordSet ? (
            <Button
              variant="ghost"
              disabled={setHook.isPending}
              onClick={() => setHook.mutate(null)}
            >
              Webhook entfernen
            </Button>
          ) : null}
          <Button type="submit" disabled={setHook.isPending || !url.trim()}>
            {setHook.isPending ? 'Speichert …' : 'Webhook setzen'}
          </Button>
        </div>
      </form>
      <fieldset className="app-fieldset">
        <legend className="hz-label">Ereignisse</legend>
        {NOTIFY_EVENTS.map((ev) => (
          <Toggle
            key={ev}
            label={NOTIFY_EVENT_TEXT[ev]}
            checked={current.includes(ev)}
            disabled={events.isPending}
            onChange={(on) => events.mutate(toggleEvent(current, ev, on))}
          />
        ))}
      </fieldset>
      {shown(events.error) ? <FormError title={shown(events.error) ?? ''} /> : null}
      {data.lastError ? (
        <Alert tone="warn" title={`Letzte Nachricht ging nicht: ${data.lastError}`}>
          URL prüfen oder den Webhook in Discord neu anlegen.
        </Alert>
      ) : null}
      {test.data === true ? <Alert tone="ok" title="Testnachricht gesendet." /> : null}
      {test.data === false ? (
        <Alert tone="warn" title="Testnachricht ging nicht.">
          Discord hat abgelehnt. URL prüfen.
        </Alert>
      ) : null}
      {test.error ? <FormError title={errorText(test.error)} /> : null}
      <div className="hz-form-actions">
        <span className="app-foot-text">
          {data.lastSentAt
            ? `Zuletzt gesendet ${formatWhen(new Date(data.lastSentAt), now)}`
            : 'Noch nichts gesendet'}
        </span>
        <Button
          size="sm"
          disabled={!data.discordSet || test.isPending}
          onClick={() => test.mutate()}
        >
          {test.isPending ? 'Sendet …' : 'Testnachricht'}
        </Button>
      </div>
    </div>
  );
}

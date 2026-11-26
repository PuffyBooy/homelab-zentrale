import type { NotifyChannel, NotifyChannelId, NotifyChannelUpdateRequest } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, StatusDot, Tile, Toggle } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatWhen } from '../../lib/format.js';
import {
  CHANNEL_LABEL,
  MIN_LEVEL_OPTIONS,
  NTFY_DEFAULT_SERVER,
  buildChannelSecrets,
  channelStatus,
  channelStatusText,
  channelTestErrorText,
  channelToForm,
  deleteNotifyChannel,
  fetchNotifyChannels,
  notifyChannelsKey,
  saveNotifyChannel,
  testNotifyChannel,
  type ChannelErrors,
  type ChannelForm,
} from '../../lib/notifyChannels.js';

function shownError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return errorText(err);
}

/**
 * Einstellungen → Meldungskanäle (SPEC 16): Discord, Telegram, ntfy. Same push policy
 * (quiet hours, warn bundle) as the phone. Secrets never come back ("gesetzt").
 */
export function NotifyChannelsTile(): ReactElement {
  const channels = useQuery({
    queryKey: notifyChannelsKey,
    queryFn: ({ signal }) => fetchNotifyChannels(signal),
  });
  return (
    <Tile title="Meldungskanäle" icon="bell">
      <p className="app-text">
        Meldungen zusätzlich an Discord, Telegram oder ntfy. Es gelten dieselben Regeln wie für Push
        (Ruhezeit, Bündeln). IP-Adressen werden maskiert, die Nachricht verlässt das Tailnet.
      </p>
      {channels.isError && !channels.data ? <FormError title={errorText(channels.error)} /> : null}
      {channels.data ? (
        <div className="app-channels">
          {channels.data.map((c) => (
            <ChannelSection key={c.id} channel={c} />
          ))}
        </div>
      ) : channels.isPending ? (
        <p className="app-empty">Lade Meldungskanäle …</p>
      ) : null}
    </Tile>
  );
}

export function ChannelSection({ channel: c }: { channel: NotifyChannel }): ReactElement {
  const qc = useQueryClient();
  const [form, setForm] = useState<ChannelForm>(() => channelToForm(c));
  const [errors, setErrors] = useState<ChannelErrors>({});
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'sent' | null>(null);

  const store = (next: NotifyChannel): void => {
    qc.setQueryData<NotifyChannel[]>(notifyChannelsKey, (old) =>
      old ? old.map((x) => (x.id === next.id ? next : x)) : old,
    );
  };
  const save = useMutation({
    mutationFn: (body: NotifyChannelUpdateRequest) => saveNotifyChannel(c.id, body),
    onSuccess: (next, body) => {
      store(next);
      if (Object.keys(body).some((k) => k !== 'enabled' && k !== 'minLevel')) {
        setForm(channelToForm(next));
        setNotice('saved');
      }
    },
  });
  const test = useMutation({
    mutationFn: () => testNotifyChannel(c.id),
    onSuccess: () => setNotice('sent'),
    onSettled: () => void qc.invalidateQueries({ queryKey: notifyChannelsKey }),
  });
  const remove = useMutation({
    mutationFn: () => deleteNotifyChannel(c.id),
    onSuccess: () => {
      setRemoving(false);
      setNotice(null);
      void qc.invalidateQueries({ queryKey: notifyChannelsKey });
    },
  });

  const set = <K extends keyof ChannelForm>(k: K, v: ChannelForm[K]): void => {
    setForm((f) => ({ ...f, [k]: v }));
    setNotice(null);
  };

  function submit(e: FormEvent): void {
    e.preventDefault();
    const { patch, errors: next } = buildChannelSecrets(c, form);
    setErrors(next);
    if (Object.keys(next).length || Object.keys(patch).length === 0) return;
    // A freshly configured channel is switched on with it.
    save.mutate(c.configured ? patch : { ...patch, enabled: true });
  }

  const busy = save.isPending || test.isPending || remove.isPending;
  const err =
    shownError(save.error) ??
    (test.error && !isApiError(test.error, 'step_up_required')
      ? channelTestErrorText(test.error)
      : null);
  const label = CHANNEL_LABEL[c.id];
  const secretHint = 'Gesetzt. Leer lassen, um es zu behalten.';

  return (
    <section className="app-channel" aria-label={label} data-testid={`channel-${c.id}`}>
      <div className="app-channel-head">
        <Toggle
          label={label}
          hint={c.configured ? undefined : 'erst Zugangsdaten eintragen'}
          checked={c.enabled}
          disabled={!c.configured || busy}
          onChange={(next) => save.mutate({ enabled: next })}
        />
      </div>
      <dl className="app-kv">
        <dt>Status</dt>
        <dd>
          <StatusDot status={channelStatus(c)} label={channelStatusText(c)} />
        </dd>
        <dt>Zuletzt gesendet</dt>
        <dd>
          {c.lastSentAt
            ? `${formatWhen(new Date(c.lastSentAt))} · ${formatAgo(new Date(c.lastSentAt))}`
            : 'noch nie'}
        </dd>
        {c.lastError ? (
          <>
            <dt>Letzter Fehler</dt>
            <dd>{c.lastError}</dd>
          </>
        ) : null}
      </dl>
      <form className="hz-form" onSubmit={submit} noValidate>
        <SelectField
          label="Mindest-Level"
          value={c.minLevel}
          disabled={busy}
          onChange={(e) => save.mutate({ minLevel: e.target.value as NotifyChannel['minLevel'] })}
          options={MIN_LEVEL_OPTIONS}
          hint="Meldungen ab diesem Level gehen an den Kanal."
        />
        {c.id === 'discord' ? (
          <Field
            label="Webhook-URL"
            mono
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={300}
            value={form.discordWebhook}
            placeholder={c.configured ? 'gesetzt' : 'https://discord.com/api/webhooks/…'}
            onChange={(e) => set('discordWebhook', e.target.value)}
            hint={
              c.configured
                ? secretHint
                : 'Kanal-Einstellungen → Integrationen → Webhooks. Die URL ist das Geheimnis.'
            }
            error={errors.discordWebhook}
          />
        ) : null}
        {c.id === 'telegram' ? (
          <div className="app-fields">
            <Field
              label="Bot-Token"
              mono
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={100}
              value={form.telegramBotToken}
              placeholder={c.configured ? 'gesetzt' : '123456:ABC…'}
              onChange={(e) => set('telegramBotToken', e.target.value)}
              hint={c.configured ? secretHint : 'Von @BotFather. Geht nur an api.telegram.org.'}
              error={errors.telegramBotToken}
            />
            <Field
              label="Chat-ID"
              mono
              autoComplete="off"
              spellCheck={false}
              maxLength={40}
              value={form.telegramChatId}
              placeholder={c.configured ? 'gesetzt' : '-1001234567890'}
              onChange={(e) => set('telegramChatId', e.target.value)}
              hint={c.configured ? secretHint : 'Zahl (Gruppen negativ) oder @kanalname.'}
              error={errors.telegramChatId}
            />
          </div>
        ) : null}
        {c.id === 'ntfy' ? (
          <>
            <Field
              label="Server"
              mono
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
              value={form.ntfyServer}
              placeholder={NTFY_DEFAULT_SERVER}
              onChange={(e) => set('ntfyServer', e.target.value)}
              hint="Neuer Server: Thema und Token neu eintragen."
              error={errors.ntfyServer}
            />
            <div className="app-fields">
              <Field
                label="Thema"
                mono
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                value={form.ntfyTopic}
                placeholder={c.configured ? 'gesetzt' : 'homelab-a8f3k2'}
                onChange={(e) => set('ntfyTopic', e.target.value)}
                hint={c.configured ? secretHint : 'Lang und zufällig, das Thema ist der Zugang.'}
                error={errors.ntfyTopic}
              />
              <Field
                label="Token (optional)"
                mono
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                value={form.ntfyToken}
                placeholder={c.tokenSet ? 'gesetzt' : 'tk_…'}
                onChange={(e) => set('ntfyToken', e.target.value)}
                hint={c.tokenSet ? secretHint : 'Nur bei geschütztem Thema.'}
                error={errors.ntfyToken}
              />
            </div>
            {c.tokenSet ? (
              <label className="app-check app-check-line">
                <input
                  type="checkbox"
                  checked={form.removeNtfyToken}
                  onChange={(e) => set('removeNtfyToken', e.target.checked)}
                />
                <span>Token beim Speichern entfernen</span>
              </label>
            ) : null}
          </>
        ) : null}
        {err ? <FormError title={err} /> : null}
        {notice === 'saved' && !save.isPending ? (
          <Alert tone="ok" title={`${label} gespeichert.`}>
            Mit „Testnachricht“ prüfst du den Kanal sofort.
          </Alert>
        ) : null}
        {notice === 'sent' && !test.isPending ? (
          <Alert tone="ok" title={`Testnachricht an ${label} gesendet.`} />
        ) : null}
        <div className="hz-form-actions">
          {c.configured ? (
            <Button variant="danger" disabled={busy} onClick={() => setRemoving(true)}>
              Entfernen
            </Button>
          ) : null}
          <Button
            icon="bell"
            disabled={busy || !c.configured}
            onClick={() => {
              setNotice(null);
              test.mutate();
            }}
          >
            Testnachricht
          </Button>
          <Button type="submit" disabled={busy}>
            Speichern
          </Button>
        </div>
      </form>
      {removing ? (
        <RemoveChannelDialog
          id={c.id}
          busy={remove.isPending}
          error={shownError(remove.error)}
          onConfirm={() => remove.mutate()}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </section>
  );
}

function RemoveChannelDialog({
  id,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  id: NotifyChannelId;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog open onClose={onClose} title={`${CHANNEL_LABEL[id]} entfernen`}>
      <div className="hz-dialog-body">
        <p className="hz-dialog-text">
          Alle Zugangsdaten des Kanals werden gelöscht und der Kanal ausgeschaltet.
        </p>
        {error ? <FormError title={error} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose} data-autofocus="">
            Abbrechen
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            Entfernen
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

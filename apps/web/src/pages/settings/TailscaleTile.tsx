import {
  TAILSCALE_DEFAULT_TAG,
  tailscaleClientIdSchema,
  tailscaleClientSecretSchema,
  tailscaleTagSchema,
  type TailscaleSettings,
  type TailscaleSettingsRequest,
} from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, Tile } from '@hz/ui';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo } from '../../lib/format.js';
import {
  clearTailscale,
  fetchTailscale,
  saveTailscale,
  tailscaleKey,
  testTailscale,
} from '../../lib/onboarding.js';

/** The user closed the step-up dialog: no error line for that. */
function shownError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return errorText(err);
}

/** ACL snippet for the tag (Access controls → tagOwners). */
export function tagOwnersSnippet(tag: string): string {
  return `"tagOwners": {\n  "${tag}": ["autogroup:admin"]\n}`;
}

/**
 * Settings → Tailscale (M11b): OAuth client for "Server hinzufügen". With it, the
 * command for a new server carries a single-use auth key and joins without a login.
 * Secret write-only; saving and removing need step-up.
 */
export function TailscaleTile(): ReactElement {
  const q = useQuery({ queryKey: tailscaleKey, queryFn: ({ signal }) => fetchTailscale(signal) });
  if (!q.data) {
    return (
      <Tile title="Tailscale (Server automatisch anmelden)" icon="lock">
        {q.isError ? (
          <FormError title={shownError(q.error) ?? 'Fehler.'} />
        ) : (
          <p className="app-empty">Lade Tailscale …</p>
        )}
      </Tile>
    );
  }
  // Keyed by the stored values, so a save resets the draft.
  return <TailscaleBody key={`${q.data.clientId ?? ''}:${q.data.tag}`} state={q.data} />;
}

export function TailscaleBody({ state }: { state: TailscaleSettings }): ReactElement {
  const qc = useQueryClient();
  const [clientId, setClientId] = useState(state.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [tag, setTag] = useState(state.tag);
  const [errors, setErrors] = useState<{ clientId?: string; secret?: string; tag?: string }>({});
  const onSuccess = (next: TailscaleSettings): void => {
    setSecret('');
    qc.setQueryData(tailscaleKey, next);
  };
  const save = useMutation({ mutationFn: saveTailscale, onSuccess });
  const test = useMutation({ mutationFn: testTailscale, onSuccess });
  const clear = useMutation({ mutationFn: clearTailscale, onSuccess });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const next: typeof errors = {};
    const id = clientId.trim();
    const sec = secret.trim();
    const tg = tag.trim() || TAILSCALE_DEFAULT_TAG;
    if (!tailscaleClientIdSchema.safeParse(id).success)
      next.clientId = 'Client-ID aus der Tailscale-Konsole.';
    if (sec && !tailscaleClientSecretSchema.safeParse(sec).success)
      next.secret = 'Das Secret beginnt mit tskey-client-.';
    if (!sec && (!state.secretSet || id !== state.clientId))
      next.secret = 'Secret eintragen (wird nur einmal angezeigt).';
    if (!tailscaleTagSchema.safeParse(tg).success) next.tag = 'Ein Tag wie tag:homelab-server.';
    setErrors(next);
    if (Object.keys(next).length) return;
    const body: TailscaleSettingsRequest = { clientId: id, tag: tg };
    if (sec) body.clientSecret = sec;
    save.mutate(body);
  }

  const err = shownError(save.error) ?? shownError(test.error) ?? shownError(clear.error);
  const configured = state.status !== 'off';

  return (
    <Tile
      title="Tailscale (Server automatisch anmelden)"
      icon="lock"
      status={state.status === 'ok' ? 'ok' : state.status === 'error' ? 'crit' : 'off'}
      statusLabel={state.status === 'ok' ? 'bereit' : state.status === 'error' ? 'Fehler' : 'aus'}
    >
      <dl className="app-kv">
        <dt>Status</dt>
        <dd data-testid="tailscale-status">
          {state.status === 'ok'
            ? `Neue Server melden sich selbst an${state.lastOkAt ? ` · geprüft ${formatAgo(new Date(state.lastOkAt))}` : ''}`
            : state.status === 'error'
              ? (state.error ?? 'Fehler')
              : 'Aus: der Befehl zeigt am neuen Server einen Login-Link'}
        </dd>
        <dt>Secret</dt>
        <dd>{state.secretSet ? 'gespeichert' : 'kein Secret'}</dd>
      </dl>
      <ol className="app-howto">
        <li>
          In der Tailscale-Konsole unter Access controls den Tag freigeben (Snippet unten in
          tagOwners einfügen, speichern).
        </li>
        <li>
          Unter Settings → OAuth clients (neuere Konsole: Trust credentials) einen OAuth-Client
          anlegen: Scope Auth Keys mit Schreibrecht, Tag {tag.trim() || TAILSCALE_DEFAULT_TAG}.
        </li>
        <li>Client-ID und Secret hier eintragen. Die Zentrale prüft sie sofort.</li>
      </ol>
      <CopyBlock
        label="Snippet für Access controls"
        text={tagOwnersSnippet(tag.trim() || TAILSCALE_DEFAULT_TAG)}
      />
      <form className="hz-form" onSubmit={submit} noValidate>
        <div className="app-fields">
          <Field
            label="Client-ID"
            mono
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            error={errors.clientId}
          />
          <Field
            label="Tag"
            mono
            autoComplete="off"
            spellCheck={false}
            maxLength={60}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            hint="Bekommen alle neuen Server. Getaggte Geräte laufen nicht ab."
            error={errors.tag}
          />
          <Field
            className="app-fields-wide"
            label={state.secretSet ? 'Neues Secret' : 'Secret'}
            mono
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={220}
            value={secret}
            placeholder={state.secretSet ? 'gespeichert' : 'tskey-client-…'}
            onChange={(e) => setSecret(e.target.value)}
            hint={
              state.secretSet
                ? 'Gespeichert. Leer lassen, um es zu behalten. Es wird nie wieder angezeigt.'
                : 'Wird verschlüsselt gespeichert und nie wieder angezeigt.'
            }
            error={errors.secret}
          />
        </div>
        {err ? <FormError title={err} /> : null}
        {save.isSuccess && !save.isPending && state.status === 'ok' ? (
          <Alert tone="ok" title="Gespeichert und geprüft.">
            Der Befehl unter Server hinzufügen meldet neue Server jetzt selbst bei Tailscale an.
          </Alert>
        ) : null}
        <div className="hz-form-actions">
          {configured ? (
            <>
              <Button variant="danger" disabled={clear.isPending} onClick={() => clear.mutate()}>
                Entfernen
              </Button>
              <Button disabled={test.isPending} onClick={() => test.mutate()}>
                Prüfen
              </Button>
            </>
          ) : null}
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Speichern
          </Button>
        </div>
      </form>
    </Tile>
  );
}

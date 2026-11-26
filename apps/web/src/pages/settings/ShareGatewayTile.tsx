import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useLocation } from 'react-router';
import { Alert, Button, Tile, Toggle } from '@hz/ui';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatWhen } from '../../lib/format.js';
import {
  createGatewayToken,
  fetchShareGateway,
  publicUrlError,
  saveShareGateway,
  shareGatewayKey,
  type ShareGatewaySettings,
} from '../../lib/shares.js';

/** The user closed the step-up dialog: no error line for that. */
function shownError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return errorText(err);
}

/**
 * Settings → Share-Gateway (SPEC 6.4, NETWORK.md). Off by default: links then work only in
 * the tailnet. On: links also get <publicUrl>/s/<token>, served by apps/share on oracle-a1.
 * Saving and the token need step-up (api() asks for the code).
 */
export function ShareGatewayTile(): ReactElement {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: shareGatewayKey,
    queryFn: ({ signal }) => fetchShareGateway(signal),
  });
  const { hash } = useLocation();
  const anchor = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [confirmToken, setConfirmToken] = useState(false);
  const loaded = useRef(false);

  const s = settings.data;
  useEffect(() => {
    if (!s || loaded.current) return;
    loaded.current = true;
    setEnabled(s.enabled);
    setUrl(s.publicUrl ?? '');
  }, [s]);

  useEffect(() => {
    if (hash === '#share-gateway' && s) anchor.current?.scrollIntoView({ block: 'start' });
  }, [hash, s]);

  const save = useMutation({
    mutationFn: saveShareGateway,
    onSuccess: (next) => {
      qc.setQueryData<ShareGatewaySettings>(shareGatewayKey, next);
      setEnabled(next.enabled);
      setUrl(next.publicUrl ?? '');
    },
  });
  const gen = useMutation({
    mutationFn: createGatewayToken,
    onSuccess: (t) => {
      setConfirmToken(false);
      setToken(t);
      void qc.invalidateQueries({ queryKey: shareGatewayKey });
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const err = publicUrlError(url, enabled);
    setUrlError(err);
    if (!err) save.mutate({ enabled, publicUrl: url.trim() || null });
  }

  const dirty = !!s && (enabled !== s.enabled || url.trim() !== (s.publicUrl ?? ''));

  return (
    <div id="share-gateway" ref={anchor} className="app-anchor">
      <Tile
        title="Share-Gateway"
        icon="globe"
        status={s ? (s.enabled ? (s.tokenSet ? 'ok' : 'warn') : 'off') : undefined}
        statusLabel={s ? (s.enabled ? (s.tokenSet ? 'AN' : 'KEIN TOKEN') : 'AUS') : undefined}
      >
        {settings.isError && !s ? <FormError title={errorText(settings.error)} /> : null}
        {settings.isPending ? <p className="app-empty">Lade Share-Gateway …</p> : null}
        {s ? (
          <>
            <p className="app-text">
              {s.enabled
                ? 'An. Neue Benutzerlinks gehen zusätzlich über die öffentliche Adresse. Das Gateway auf oracle-a1 reicht nur die Share-API an die Zentrale weiter.'
                : 'Aus. Benutzerlinks funktionieren dann nur im Tailnet. Das ist der Standard.'}
            </p>
            <dl className="app-kv">
              <dt>Token</dt>
              <dd>{s.tokenSet ? 'hinterlegt' : 'noch keiner'}</dd>
              <dt>Gateway</dt>
              <dd>
                {s.lastSeenAt
                  ? `zuletzt gemeldet ${formatWhen(new Date(s.lastSeenAt))} · ${formatAgo(new Date(s.lastSeenAt))}`
                  : 'noch nie gemeldet'}
              </dd>
            </dl>
            <form className="hz-form" onSubmit={submit} noValidate>
              <Toggle
                label="Share-Gateway"
                hint="Links auch von außen erreichbar"
                checked={enabled}
                onChange={(v) => {
                  setEnabled(v);
                  setUrlError(null);
                }}
              />
              <Field
                label="Öffentliche Adresse"
                mono
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
                placeholder="https://spiel.example.duckdns.org"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setUrlError(null);
                }}
                hint="Nur https. Links heißen dann <Adresse>/s/<Token>."
                error={urlError}
              />
              {shownError(save.error) ? <FormError title={shownError(save.error) ?? ''} /> : null}
              {save.isSuccess && !dirty ? (
                <Alert tone="ok" title="Gespeichert.">
                  {save.data.enabled ? 'Share-Gateway ist an.' : 'Share-Gateway ist aus.'}
                </Alert>
              ) : null}
              <div className="hz-form-actions">
                <Button
                  onClick={() => (s.tokenSet ? setConfirmToken(true) : gen.mutate())}
                  disabled={gen.isPending}
                >
                  {s.tokenSet ? 'Neuen Token erzeugen' : 'Token erzeugen'}
                </Button>
                <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
                  Speichern
                </Button>
              </div>
              {!confirmToken && shownError(gen.error) ? (
                <FormError title={shownError(gen.error) ?? ''} />
              ) : null}
            </form>
            {token ? (
              <div className="app-stack">
                <Alert tone="warn" title="Der Token wird nur jetzt angezeigt.">
                  Trag ihn auf oracle-a1 in die .env des Share-Gateways ein und starte den Container
                  neu. Der alte Token gilt ab sofort nicht mehr.
                </Alert>
                <CopyBlock
                  label="Zeile für die .env"
                  text={`HZ_SHARE_GATEWAY_TOKEN=${token}`}
                  inline
                />
                <div className="hz-form-actions">
                  <Button onClick={() => setToken(null)}>Ich habe ihn eingetragen</Button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </Tile>
      {confirmToken ? (
        <Dialog open onClose={() => setConfirmToken(false)} title="Neuen Gateway-Token erzeugen">
          <div className="hz-dialog-body">
            <p className="hz-dialog-text">
              Der alte Token hört sofort auf zu funktionieren. Bis der neue auf oracle-a1
              eingetragen ist, gehen Links nur im Tailnet.
            </p>
            {shownError(gen.error) ? <FormError title={shownError(gen.error) ?? ''} /> : null}
            <div className="hz-dialog-foot">
              <Button onClick={() => setConfirmToken(false)} data-autofocus="">
                Abbrechen
              </Button>
              <Button variant="danger" disabled={gen.isPending} onClick={() => gen.mutate()}>
                Neu erzeugen
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

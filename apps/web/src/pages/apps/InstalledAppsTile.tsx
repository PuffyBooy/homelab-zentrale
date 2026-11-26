import type { InstalledApp } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, ServiceRow, Tile, Toggle } from '@hz/ui';
import { shownError } from '../../components/ConfirmDialog.js';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import {
  APP_STATUS,
  BIND_SHORT,
  appAction,
  appErrorText,
  appStatus,
  appStatusText,
  appsKey,
  fetchAppSecrets,
  portsText,
  removeApp,
  sortApps,
  type AppAction,
  type AppSecrets,
} from '../../lib/apps.js';
import { errorText } from '../../lib/errors.js';
import { plural } from '../../lib/format.js';

const text = (err: unknown): string => appErrorText(err, errorText);

const ACTION_PENDING: Record<AppAction, string> = {
  start: 'startet …',
  stop: 'stoppt …',
  restart: 'startet neu …',
  update: 'aktualisiert …',
};

/** Installed apps with status (shape + text), ports, "Öffnen" and the actions. */
export function InstalledAppsTile({ apps }: { apps: readonly InstalledApp[] }): ReactElement {
  const list = sortApps(apps);
  const bad = list.filter((a) => ['crit', 'warn'].includes(appStatus(a))).length;
  return (
    <Tile
      title="Installierte Apps"
      className="app-wrap-tile"
      icon="container"
      count={bad ? `${list.length} · ${plural(bad, 'Problem', 'Probleme')}` : String(list.length)}
      span={4}
      flush
      footer={
        <span className="app-foot-text">
          Liegen unter /opt/homelab/apps/&lt;ordner&gt;/ · Container tragen das Label homelab.app
        </span>
      }
    >
      {list.length === 0 ? (
        <p className="app-empty app-pad">
          Noch keine App installiert. Unten im Katalog eine Vorlage wählen.
        </p>
      ) : (
        list.map((a) => <AppRow key={a.id} app={a} />)
      )}
    </Tile>
  );
}

export function AppRow({ app: a }: { app: InstalledApp }): ReactElement {
  const qc = useQueryClient();
  const [secrets, setSecrets] = useState(false);
  const [removing, setRemoving] = useState(false);
  const act = useMutation({
    mutationFn: (action: AppAction) => appAction(a.id, action),
    onSuccess: (next) =>
      qc.setQueryData<InstalledApp[]>(appsKey, (old) =>
        old?.map((x) => (x.id === next.id ? next : x)),
      ),
  });
  const busy = act.isPending || APP_STATUS[a.status] === 'busy';
  const running = a.status === 'running';
  const err = shownError(act.error, text);
  const host = [
    a.serverName,
    `${a.templateName} ${a.version}`.trim(),
    BIND_SHORT[a.bind],
    portsText(a.ports),
  ].join(' · ');

  return (
    <>
      <ServiceRow
        name={a.name}
        host={host}
        status={act.isPending ? 'busy' : appStatus(a)}
        meta={act.isPending ? ACTION_PENDING[act.variables] : appStatusText(a)}
        actions={
          <>
            {a.url && running ? (
              <a
                className="hz-btn hz-btn-ghost hz-btn-sm"
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${a.name} öffnen (neuer Tab)`}
              >
                <span>Öffnen</span>
              </a>
            ) : null}
            {running ? (
              <Button
                size="sm"
                variant="ghost"
                icon="stop"
                aria-label={`${a.name} stoppen`}
                title="Stoppen"
                disabled={busy}
                onClick={() => act.mutate('stop')}
              />
            ) : (
              <Button
                size="sm"
                variant="ghost"
                icon="play"
                aria-label={`${a.name} starten`}
                title="Starten"
                disabled={busy}
                onClick={() => act.mutate('start')}
              />
            )}
            <Button
              size="sm"
              variant="ghost"
              icon="refresh"
              aria-label={`${a.name} neu starten`}
              title="Neu starten"
              disabled={busy || !running}
              onClick={() => act.mutate('restart')}
            />
            <Button
              size="sm"
              variant="ghost"
              icon="cloud"
              aria-label={`${a.name} aktualisieren`}
              title="Aktualisieren (Images neu laden)"
              disabled={busy}
              onClick={() => act.mutate('update')}
            />
            {a.hasSecrets ? (
              <Button
                size="sm"
                variant="ghost"
                icon="lock"
                aria-label={`Passwörter von ${a.name} anzeigen (mit Code)`}
                title="Passwörter"
                onClick={() => setSecrets(true)}
              />
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${a.name} entfernen`}
              disabled={a.status === 'removing'}
              onClick={() => setRemoving(true)}
            >
              Entfernen
            </Button>
          </>
        }
      />
      {a.lastError ? (
        <div className="app-ctr-error">
          <Alert tone="crit" title={`${a.name}: ${a.lastError}`} />
        </div>
      ) : null}
      {err ? (
        <div className="app-ctr-error">
          <Alert tone="crit" title={`${a.name}: ${err}`} />
        </div>
      ) : null}
      {secrets ? <SecretsDialog app={a} onClose={() => setSecrets(false)} /> : null}
      {removing ? <RemoveAppDialog app={a} onClose={() => setRemoving(false)} /> : null}
    </>
  );
}

/** Passwords of the app; the request needs step-up (api() asks). */
export function SecretsDialog({
  app,
  onClose,
}: {
  app: InstalledApp;
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog open onClose={onClose} title={`Passwörter von ${app.name}`}>
      <SecretsBody app={app} onClose={onClose} />
    </Dialog>
  );
}

function SecretsBody({ app, onClose }: { app: InstalledApp; onClose: () => void }): ReactElement {
  const load = useMutation({ mutationFn: () => fetchAppSecrets(app.id) });
  const { mutate } = load;
  useEffect(() => mutate(), [mutate]);
  const cancelled = isApiError(load.error, 'step_up_required');
  const err = shownError(load.error, text);
  const values: AppSecrets['values'] = load.data?.values ?? {};
  const keys = Object.keys(values).sort();
  return (
    <div className="hz-dialog-body">
      {load.isPending ? <p className="hz-dialog-text">Wartet auf den Code …</p> : null}
      {cancelled ? (
        <p className="hz-dialog-text">Ohne Code bleiben die Passwörter verborgen.</p>
      ) : null}
      {err ? <FormError title={err} /> : null}
      {load.data && keys.length === 0 ? (
        <p className="hz-dialog-text">Diese App hat keine gespeicherten Passwörter.</p>
      ) : null}
      {keys.map((k) => (
        <CopyBlock key={k} label={k} text={values[k] ?? ''} inline />
      ))}
      {load.data ? (
        <p className="app-text">Nicht weitergeben. Fenster schließen, wenn du fertig bist.</p>
      ) : null}
      <div className="hz-dialog-foot">
        {cancelled ? (
          <Button icon="lock" onClick={() => load.mutate()}>
            Mit Code anzeigen
          </Button>
        ) : null}
        <Button onClick={onClose} data-autofocus="">
          Schließen
        </Button>
      </div>
    </div>
  );
}

/** Remove with step-up and the folder name typed again; data only on request. */
export function RemoveAppDialog({
  app,
  onClose,
}: {
  app: InstalledApp;
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog open onClose={onClose} title={`${app.name} entfernen`} dismissable={false}>
      <RemoveForm app={app} onClose={onClose} />
    </Dialog>
  );
}

export function RemoveForm({
  app,
  onClose,
}: {
  app: InstalledApp;
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const [deleteData, setDeleteData] = useState(false);
  const match = typed.trim() === app.appId;
  const del = useMutation({
    mutationFn: () => removeApp(app.id, app.appId, deleteData),
    onSuccess: () => {
      qc.setQueryData<InstalledApp[]>(appsKey, (old) =>
        old?.map((x) => (x.id === app.id ? { ...x, status: 'removing' as const } : x)),
      );
      void qc.invalidateQueries({ queryKey: appsKey });
      onClose();
    },
  });
  function submit(e: FormEvent): void {
    e.preventDefault();
    if (match && !del.isPending) del.mutate();
  }
  const err = shownError(del.error, text);
  const dir = `/opt/homelab/apps/${app.appId}/`;
  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <p className="hz-dialog-text">
        Stoppt und entfernt die Container von {app.name} auf {app.serverName} (compose down, ohne
        Volumes). Zum Bestätigen den Ordnernamen <code>{app.appId}</code> eintippen.
      </p>
      <Field
        label="Ordnername"
        mono
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={app.appId}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        data-autofocus=""
      />
      <Toggle
        label="Daten löschen"
        hint={`Löscht auch ${dir} mit data/, .env und compose.yml. Nicht rückgängig zu machen.`}
        checked={deleteData}
        onChange={setDeleteData}
      />
      {deleteData ? (
        <Alert tone="crit" title={`Alle Daten in ${dir} gehen verloren.`}>
          Fotos, Datenbanken, Einstellungen: alles, was die App gespeichert hat. Vorher sichern.
        </Alert>
      ) : (
        <p className="app-text">
          Ohne Haken bleibt {dir} liegen, eine neue Installation findet die Daten wieder.
        </p>
      )}
      {err ? <FormError title={err} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="danger" type="submit" icon="lock" disabled={!match || del.isPending}>
          {del.isPending
            ? 'Entfernt …'
            : deleteData
              ? 'Mit Code samt Daten entfernen'
              : 'Mit Code entfernen'}
        </Button>
      </div>
    </form>
  );
}

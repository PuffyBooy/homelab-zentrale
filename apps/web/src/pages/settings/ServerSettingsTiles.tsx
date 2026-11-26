import type { ServerDetail, ServerSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Alert, Button, StatusDot, Tile, Toggle } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo } from '../../lib/format.js';
import { fetchServer, serverKey, serversKey } from '../../lib/servers.js';
import {
  changedThresholds,
  deleteServer,
  parseThresholds,
  revokeAgent,
  thresholdDraft,
  THRESHOLD_FIELDS,
  updateServer,
  type ThresholdDraft,
  type ThresholdKey,
} from '../../lib/settings.js';

/** The user closed the step-up dialog: no error line for that. */
function shownError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return errorText(err);
}

type ServerDialog =
  | { kind: 'edit'; server: ServerSummary }
  | { kind: 'delete'; server: ServerSummary }
  | { kind: 'revoke'; server: ServerSummary };

/** Settings → Server (SPEC 13): thresholds, console allowed, remove. */
export function ServersSettingsTile(): ReactElement {
  const servers = useServers();
  const [dialog, setDialog] = useState<ServerDialog | null>(null);
  const list = [...(servers.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <Tile title="Server" icon="server" count={servers.data ? list.length : undefined} flush>
        {servers.isPending ? <p className="app-empty app-pad">Lade Server …</p> : null}
        {servers.isError ? (
          <div className="app-pad">
            <FormError title={errorText(servers.error)} />
          </div>
        ) : null}
        {servers.data && list.length === 0 ? (
          <p className="app-empty app-pad">
            Noch kein Server. <Link to="/servers">Server hinzufügen</Link>
          </p>
        ) : null}
        {list.map((s) => (
          <div className="hz-row" key={s.id} data-testid="settings-server">
            <div className="hz-row-main">
              <span className="hz-row-name">{s.name}</span>
              <span className="hz-row-sub">
                {s.location || 'kein Ort'} · Konsole {s.allowTerminal ? 'erlaubt' : 'aus'}
              </span>
            </div>
            <div className="hz-row-actions">
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${s.name} bearbeiten`}
                onClick={() => setDialog({ kind: 'edit', server: s })}
              >
                Bearbeiten
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${s.name} entfernen`}
                onClick={() => setDialog({ kind: 'delete', server: s })}
              >
                Entfernen
              </Button>
            </div>
          </div>
        ))}
      </Tile>
      {dialog?.kind === 'edit' ? (
        <EditServerDialog server={dialog.server} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteServerDialog server={dialog.server} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}

/** Settings → Agents (SPEC 13): who is connected, revoke a token. */
export function AgentsSettingsTile(): ReactElement {
  const servers = useServers();
  const [revoke, setRevoke] = useState<ServerSummary | null>(null);
  const list = [...(servers.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <Tile title="Agents" icon="plug" count={servers.data ? list.length : undefined} flush>
        {servers.data && list.length === 0 ? (
          <p className="app-empty app-pad">Noch kein Agent verbunden.</p>
        ) : null}
        {list.map((s) => (
          <div className="hz-row" key={s.id} data-testid="settings-agent">
            <StatusDot status={s.connected ? 'ok' : 'off'} />
            <div className="hz-row-main">
              <span className="hz-row-name">{s.name}</span>
              <span className="hz-row-sub">
                {s.agentVersion ? `Agent ${s.agentVersion}` : 'Agent-Version unbekannt'} ·{' '}
                {s.connected
                  ? 'verbunden'
                  : s.lastSeen
                    ? `zuletzt ${formatAgo(new Date(s.lastSeen))}`
                    : 'noch nie verbunden'}
              </span>
            </div>
            <div className="hz-row-actions">
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Token widerrufen für ${s.name}`}
                onClick={() => setRevoke(s)}
              >
                Token widerrufen
              </Button>
            </div>
          </div>
        ))}
      </Tile>
      {revoke ? <RevokeAgentDialog server={revoke} onClose={() => setRevoke(null)} /> : null}
    </>
  );
}

function EditServerDialog({
  server,
  onClose,
}: {
  server: ServerSummary;
  onClose: () => void;
}): ReactElement {
  const detail = useQuery({
    queryKey: serverKey(server.id),
    queryFn: ({ signal }) => fetchServer(server.id, signal),
  });
  return (
    <Dialog open onClose={onClose} title={`${server.name} bearbeiten`}>
      {detail.data ? (
        <EditServerForm detail={detail.data} onClose={onClose} />
      ) : detail.isError ? (
        <div className="hz-dialog-body">
          <FormError title={errorText(detail.error)} />
          <div className="hz-dialog-foot">
            <Button onClick={onClose}>Schließen</Button>
          </div>
        </div>
      ) : (
        <div className="hz-dialog-body">
          <p className="hz-dialog-text" role="status">
            Lade Einstellungen …
          </p>
        </div>
      )}
    </Dialog>
  );
}

function EditServerForm({
  detail,
  onClose,
}: {
  detail: ServerDetail;
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const s = detail.server;
  const [location, setLocation] = useState(s.location);
  const [draft, setDraft] = useState<ThresholdDraft>(() => thresholdDraft(detail.thresholds));
  const [errors, setErrors] = useState<Partial<Record<ThresholdKey, string>>>({});
  const [terminal, setTerminal] = useState(s.allowTerminal);

  const done = (next: ServerDetail): void => {
    qc.setQueryData(serverKey(s.id), next);
    void qc.invalidateQueries({ queryKey: serversKey });
  };
  const save = useMutation({
    mutationFn: (body: Parameters<typeof updateServer>[1]) => updateServer(s.id, body),
    onSuccess: (next) => {
      done(next);
      onClose();
    },
  });
  const term = useMutation({
    mutationFn: (allow: boolean) => updateServer(s.id, { allowTerminal: allow }),
    onSuccess: (next) => {
      done(next);
      setTerminal(next.server.allowTerminal);
    },
    onError: () => setTerminal(s.allowTerminal),
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const parsed = parseThresholds(draft);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    const changed = changedThresholds(detail.thresholds, parsed.value);
    const body = {
      ...(location.trim() !== s.location ? { location: location.trim() } : {}),
      ...(Object.keys(changed).length ? { thresholds: changed } : {}),
    };
    if (!Object.keys(body).length) {
      onClose();
      return;
    }
    save.mutate(body);
  }

  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <Toggle
        label="Konsole erlaubt"
        hint="Web-Terminal über den Agent. Ändern braucht einen Code."
        checked={terminal}
        disabled={term.isPending}
        onChange={(v) => {
          setTerminal(v);
          term.mutate(v);
        }}
      />
      {shownError(term.error) ? <FormError title={shownError(term.error) ?? ''} /> : null}
      {terminal ? (
        <p className="hz-dialog-text">
          Der Agent braucht zusätzlich HZ_AGENT_ALLOW_TERMINAL=1, sonst bleibt die Konsole zu.
        </p>
      ) : null}
      <Field
        label="Ort"
        value={location}
        maxLength={60}
        onChange={(e) => setLocation(e.target.value)}
        placeholder="Wien"
        data-autofocus=""
      />
      <fieldset className="app-fieldset">
        <legend className="hz-label">Schwellen</legend>
        <div className="app-threshold-grid">
          {THRESHOLD_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={`${f.label} (${f.unit})`}
              mono
              inputMode="decimal"
              value={draft[f.key]}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              error={errors[f.key]}
            />
          ))}
        </div>
      </fieldset>
      {shownError(save.error) ? <FormError title={shownError(save.error) ?? ''} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" type="submit" disabled={save.isPending}>
          Speichern
        </Button>
      </div>
    </form>
  );
}

function DeleteServerDialog({
  server,
  onClose,
}: {
  server: ServerSummary;
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const del = useMutation({
    mutationFn: () => deleteServer(server.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: serversKey });
      onClose();
    },
  });
  const match = typed.trim() === server.name;
  return (
    <Dialog open onClose={onClose} title={`${server.name} entfernen`} dismissable={false}>
      <form
        className="hz-dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (match) del.mutate();
        }}
        noValidate
      >
        <p className="hz-dialog-text">
          Der Server verschwindet aus der Zentrale, sein Agent-Token gilt sofort nicht mehr.
          Verläufe und Meldungen von {server.name} werden gelöscht. Auf dem Server selbst ändert
          sich nichts. Zum Bestätigen den Servernamen eintippen.
        </p>
        <Field
          label="Servername"
          mono
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={server.name}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          data-autofocus=""
        />
        {shownError(del.error) ? <FormError title={shownError(del.error) ?? ''} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="danger" type="submit" disabled={!match || del.isPending}>
            Entfernen
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RevokeAgentDialog({
  server,
  onClose,
}: {
  server: ServerSummary;
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeAgent(server.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: serversKey }),
  });
  return (
    <Dialog open onClose={onClose} title={`Token von ${server.name} widerrufen`}>
      <div className="hz-dialog-body">
        {revoke.isSuccess ? (
          <>
            <Alert tone="ok" title={`Token von ${server.name} widerrufen.`}>
              Der Agent ist getrennt. Zum Wiederverbinden unter Server einen neuen Agent anmelden.
            </Alert>
            <div className="hz-dialog-foot">
              <Button variant="primary" onClick={onClose} data-autofocus="">
                Fertig
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="hz-dialog-text">
              Der Agent auf {server.name} wird sofort getrennt und kann sich mit diesem Token nicht
              mehr melden. Der Server bleibt mit seinem Verlauf in der Liste.
            </p>
            {shownError(revoke.error) ? <FormError title={shownError(revoke.error) ?? ''} /> : null}
            <div className="hz-dialog-foot">
              <Button onClick={onClose} data-autofocus="">
                Abbrechen
              </Button>
              <Button variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
                Widerrufen
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

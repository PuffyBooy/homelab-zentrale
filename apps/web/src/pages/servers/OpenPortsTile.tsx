import type { AllowedPort, OpenPort, PortAuditResponse } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Button, StatusDot, Tile } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { alertsKey } from '../../lib/alerts.js';
import { errorText } from '../../lib/errors.js';
import {
  MAX_ALLOWED_PORTS,
  PORT_NOTE_MAX,
  allowPort,
  draftFromAllowed,
  draftRow,
  fetchPortAudit,
  portAuditKey,
  portAuditSummary,
  portText,
  saveAllowedPorts,
  validateAllowed,
  type AllowedErrors,
  type AllowedRowDraft,
} from '../../lib/ports.js';

/**
 * "Offene Ports" (ROADMAP M11): public listening ports of the latest inventory against
 * the allowed list. "Erlauben" adds one entry; "Bearbeiten" edits the whole list.
 */
export function OpenPortsTile({
  serverId,
  serverName,
}: {
  serverId: string;
  serverName: string;
}): ReactElement {
  const qc = useQueryClient();
  const audit = useQuery({
    queryKey: portAuditKey(serverId),
    queryFn: ({ signal }) => fetchPortAudit(serverId, signal),
    refetchInterval: 30_000,
  });
  const done = (res: PortAuditResponse): void => {
    qc.setQueryData(portAuditKey(serverId), res);
    void qc.invalidateQueries({ queryKey: alertsKey });
  };
  const allow = useMutation({
    mutationFn: (p: Pick<OpenPort, 'port' | 'proto'>) =>
      allowPort(serverId, { port: p.port, proto: p.proto }),
    onSuccess: done,
  });
  const [editing, setEditing] = useState(false);

  if (!audit.data) {
    return (
      <Tile title="Offene Ports" icon="lock" span={4}>
        {audit.error ? (
          <FormError title={errorText(audit.error)} />
        ) : (
          <p className="app-empty">Lade Ports …</p>
        )}
      </Tile>
    );
  }
  return (
    <OpenPortsView
      serverName={serverName}
      audit={audit.data}
      allowing={allow.isPending ? allow.variables : null}
      allowError={allow.error ? errorText(allow.error) : null}
      onAllow={(p) => allow.mutate(p)}
      editor={
        editing ? (
          <AllowedEditor
            serverId={serverId}
            allowed={audit.data.allowed}
            onDone={(res) => {
              if (res) done(res);
              setEditing(false);
            }}
          />
        ) : null
      }
      onEdit={() => setEditing(true)}
    />
  );
}

export interface OpenPortsViewProps {
  serverName: string;
  audit: PortAuditResponse;
  allowing?: Pick<OpenPort, 'port' | 'proto'> | null | undefined;
  allowError?: string | null;
  onAllow: (p: Pick<OpenPort, 'port' | 'proto'>) => void;
  /** The edit form, when open; replaces the read-only list. */
  editor?: ReactElement | null;
  onEdit: () => void;
}

/** Pure view (unit tested). */
export function OpenPortsView({
  serverName,
  audit,
  allowing,
  allowError,
  onAllow,
  editor,
  onEdit,
}: OpenPortsViewProps): ReactElement {
  const sum = portAuditSummary(audit);
  return (
    <Tile
      title="Offene Ports"
      icon="lock"
      span={4}
      count={String(audit.open.length)}
      status={sum.status}
      statusLabel={sum.label}
    >
      <div className="app-stack" data-testid="open-ports">
        <p className="app-text">
          Ports, die auf {serverName} von außen erreichbar lauschen (0.0.0.0, :: oder öffentliche
          Adresse). Ein neuer Port, der nicht erlaubt ist, gibt eine Meldung.
        </p>
        {audit.open.length ? (
          <ul className="app-rows app-open-ports" aria-label="Öffentliche Ports">
            {audit.open.map((p) => {
              const busy = allowing?.port === p.port && allowing.proto === p.proto;
              return (
                <li key={portText(p)} className="hz-row" data-allowed={p.allowed}>
                  <StatusDot
                    status={p.allowed ? 'ok' : 'warn'}
                    label={p.allowed ? 'erlaubt' : 'nicht erlaubt'}
                    className="app-status-auto"
                  />
                  <div className="hz-row-main">
                    <span className="hz-row-name app-port">{portText(p)}</span>
                    <span className="hz-row-sub">
                      {p.process ?? 'Prozess unbekannt'} · {p.addresses.join(', ')}
                    </span>
                  </div>
                  <div className="hz-row-actions">
                    {p.allowed ? null : (
                      <Button
                        size="sm"
                        icon="check"
                        disabled={busy}
                        aria-label={`${portText(p)} erlauben`}
                        onClick={() => onAllow(p)}
                      >
                        {busy ? 'Erlaubt …' : 'Erlauben'}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="app-empty">
            {audit.seeded
              ? 'Kein Port lauscht öffentlich.'
              : 'Noch kein Inventar. Die Soll-Liste kommt aus dem ersten Inventar.'}
          </p>
        )}
        {allowError ? <FormError title={allowError} /> : null}
        {editor ?? <AllowedList allowed={audit.allowed} seeded={audit.seeded} onEdit={onEdit} />}
      </div>
    </Tile>
  );
}

function AllowedList({
  allowed,
  seeded,
  onEdit,
}: {
  allowed: readonly AllowedPort[];
  seeded: boolean;
  onEdit: () => void;
}): ReactElement {
  return (
    <div className="app-stack">
      <div className="app-allowed-head">
        <span className="hz-label">
          Erlaubt · {allowed.length} von {MAX_ALLOWED_PORTS}
        </span>
        <Button size="sm" onClick={onEdit}>
          Bearbeiten
        </Button>
      </div>
      {allowed.length ? (
        <ul className="app-ports" aria-label="Erlaubte Ports">
          {allowed.map((p) => (
            <li key={portText(p)}>
              <span className="app-port">{portText(p)}</span>
              <span className="app-port-proc">{p.note ?? ''}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="app-empty">{seeded ? 'Kein Port erlaubt.' : 'Noch keine Soll-Liste.'}</p>
      )}
    </div>
  );
}

/** Edits the whole allowed list (PUT). */
function AllowedEditor({
  serverId,
  allowed,
  onDone,
}: {
  serverId: string;
  allowed: readonly AllowedPort[];
  onDone: (res: PortAuditResponse | null) => void;
}): ReactElement {
  const [rows, setRows] = useState<AllowedRowDraft[]>(() => draftFromAllowed(allowed));
  const [errors, setErrors] = useState<AllowedErrors>({});
  const save = useMutation({
    mutationFn: (ports: AllowedPort[]) => saveAllowedPorts(serverId, ports),
    onSuccess: (res) => onDone(res),
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = validateAllowed(rows);
    setErrors(res.errors);
    if (Object.keys(res.errors).length) return;
    save.mutate(res.ports);
  }

  return (
    <AllowedEditorView
      rows={rows}
      errors={errors}
      saving={save.isPending}
      saveError={save.error ? errorText(save.error) : null}
      onChange={(next) => {
        setRows(next);
        save.reset();
      }}
      onSubmit={submit}
      onCancel={() => onDone(null)}
    />
  );
}

export function AllowedEditorView({
  rows,
  errors,
  saving,
  saveError,
  onChange,
  onSubmit,
  onCancel,
}: {
  rows: readonly AllowedRowDraft[];
  errors: AllowedErrors;
  saving?: boolean;
  saveError?: string | null;
  onChange: (rows: AllowedRowDraft[]) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}): ReactElement {
  const set = (key: string, patch: Partial<AllowedRowDraft>): void =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <form className="hz-form" onSubmit={onSubmit} noValidate aria-label="Erlaubte Ports bearbeiten">
      <span className="hz-label">
        Erlaubt · {rows.length} von {MAX_ALLOWED_PORTS}
      </span>
      {rows.map((r, i) => (
        <fieldset key={r.key} className="app-form-row app-allowed-row">
          <legend className="hz-sr">Port {i + 1}</legend>
          <Field
            label="Port"
            mono
            inputMode="numeric"
            value={r.port}
            onChange={(e) => set(r.key, { port: e.target.value })}
            error={errors[`${r.key}:port`]}
            autoComplete="off"
          />
          <SelectField
            label="Protokoll"
            value={r.proto}
            onChange={(e) => set(r.key, { proto: e.target.value === 'udp' ? 'udp' : 'tcp' })}
            options={[
              { value: 'tcp', label: 'TCP' },
              { value: 'udp', label: 'UDP' },
            ]}
          />
          <Field
            label="Notiz"
            value={r.note}
            onChange={(e) => set(r.key, { note: e.target.value })}
            error={errors[`${r.key}:note`]}
            maxLength={PORT_NOTE_MAX}
            placeholder="z. B. nginx"
          />
          <Button
            variant="ghost"
            size="sm"
            icon="stop"
            aria-label={`Port ${r.port || i + 1} entfernen`}
            onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
          />
        </fieldset>
      ))}
      {errors.list ? <FormError title={errors.list} /> : null}
      {saveError ? <FormError title={saveError} /> : null}
      <div className="hz-form-actions">
        <Button
          icon="plus"
          disabled={rows.length >= MAX_ALLOWED_PORTS}
          onClick={() => onChange([...rows, draftRow()])}
        >
          Port hinzufügen
        </Button>
        <Button onClick={onCancel}>Abbrechen</Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Speichert …' : 'Speichern'}
        </Button>
      </div>
    </form>
  );
}

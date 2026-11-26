import type {
  AcmeCa,
  Certificate,
  DomainSettings,
  DomainsResponse,
  ServerSummary,
} from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, ServiceRow, Tile, Toggle } from '@hz/ui';
import { ConfirmDialog, shownError } from '../../components/ConfirmDialog.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { formatWhen } from '../../lib/format.js';
import {
  CA_LABEL,
  CERT_RENEW_DAYS,
  CERT_STATUS_TEXT,
  certStatus,
  createCertificate,
  defaultCertName,
  deleteCertificate,
  domainsKey,
  expiryText,
  isCertName,
  parseNames,
  renewCertificate,
  saveDomainSettings,
  updateCertificate,
  deployAddsTarget,
  zoneOf,
  type CertDeployTarget,
} from '../../lib/domains.js';

type Qc = ReturnType<typeof useQueryClient>;

function patch(qc: Qc, fn: (old: DomainsResponse) => DomainsResponse): void {
  qc.setQueryData<DomainsResponse>(domainsKey, (old) => (old ? fn(old) : old));
}

function replaceCert(qc: Qc, c: Certificate): void {
  patch(qc, (old) => ({
    ...old,
    certificates: old.certificates.some((x) => x.id === c.id)
      ? old.certificates.map((x) => (x.id === c.id ? c : x))
      : [...old.certificates, c],
  }));
}

/** Zertifikate (ACME DNS-01): names, provider, CA, status, expiry, deployment, renew. */
export function CertificatesTile({
  data,
  servers,
  now,
}: {
  data: DomainsResponse;
  servers: readonly ServerSummary[];
  now: Date;
}): ReactElement {
  const [creating, setCreating] = useState(false);
  const [deploying, setDeploying] = useState<Certificate | null>(null);
  const rank = (c: Certificate): number => {
    const s = certStatus(c, now);
    return s === 'crit' ? 0 : s === 'warn' ? 1 : 2;
  };
  const certs = [...data.certificates].sort(
    (a, b) => rank(a) - rank(b) || (a.names[0] ?? '').localeCompare(b.names[0] ?? '', 'de'),
  );
  return (
    <Tile
      title="Zertifikate"
      className="app-wrap-tile"
      icon="lock"
      count={String(certs.length)}
      span={4}
      flush
      actions={
        <Button
          size="sm"
          icon="plus"
          disabled={data.providers.length === 0}
          onClick={() => setCreating(true)}
        >
          Zertifikat anlegen
        </Button>
      }
      footer={
        <span className="app-foot-text">
          Erneuerung {CERT_RENEW_DAYS} Tage vor Ablauf · verteilt nach /opt/homelab/certs/
          &lt;name&gt;/ · private Schlüssel verlassen die Zentrale nur zum Server
        </span>
      }
    >
      {certs.length === 0 ? (
        <p className="app-empty app-pad">
          {data.providers.length
            ? 'Noch kein Zertifikat. Wildcards wie *.example.com gehen auch.'
            : 'Zuerst einen DNS-Anbieter anlegen.'}
        </p>
      ) : (
        certs.map((c) => (
          <CertRow
            key={c.id}
            c={c}
            data={data}
            servers={servers}
            now={now}
            onDeploy={() => setDeploying(c)}
          />
        ))
      )}
      <AcmeEmailForm settings={data.settings} />
      {creating ? (
        <CertDialog data={data} servers={servers} onClose={() => setCreating(false)} />
      ) : null}
      {deploying ? (
        <DeployDialog cert={deploying} servers={servers} onClose={() => setDeploying(null)} />
      ) : null}
    </Tile>
  );
}

export function CertRow({
  c,
  data,
  servers,
  now,
  onDeploy,
}: {
  c: Certificate;
  data: DomainsResponse;
  servers: readonly ServerSummary[];
  now: Date;
  onDeploy: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const renew = useMutation({
    mutationFn: () => renewCertificate(c.id),
    onSuccess: (next) => replaceCert(qc, next),
  });
  const del = useMutation({
    mutationFn: () => deleteCertificate(c.id),
    onSuccess: () => {
      patch(qc, (old) => ({
        ...old,
        certificates: old.certificates.filter((x) => x.id !== c.id),
      }));
      setConfirm(false);
    },
  });
  const provider = data.providers.find((p) => p.id === c.providerId);
  const name = c.names[0] ?? 'Zertifikat';
  const serverName = (id: string): string => servers.find((s) => s.id === id)?.name ?? id;
  const deployText = c.deploy.length
    ? `auf ${c.deploy.map((d) => `${serverName(d.serverId)}${d.lastError ? ' (Fehler)' : ''}`).join(', ')}`
    : 'nicht verteilt';
  const status = certStatus(c, now);
  const busy = c.status === 'pending' || c.status === 'renewing' || renew.isPending;
  const meta =
    c.status === 'valid' || c.status === 'expired'
      ? expiryText(c.notAfter, now)
      : `${CERT_STATUS_TEXT[c.status]}${c.nextAttemptAt ? ` · neuer Versuch ${formatWhen(new Date(c.nextAttemptAt), now)}` : ''}`;
  const err = shownError(renew.error);
  const deployErrors = c.deploy.filter((d) => d.lastError);
  return (
    <>
      <ServiceRow
        name={c.names.join(', ')}
        host={`${CA_LABEL[c.ca]} · ${provider?.label ?? 'Anbieter gelöscht'} · ${deployText}${c.autoRenew ? '' : ' · ohne Auto-Erneuerung'}`}
        status={renew.isPending ? 'busy' : status}
        meta={<span data-testid="cert-meta">{meta}</span>}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              icon="refresh"
              aria-label={`${name} jetzt erneuern`}
              title="Erneuern"
              disabled={busy}
              onClick={() => renew.mutate()}
            />
            <Button
              size="sm"
              variant="ghost"
              icon="server"
              aria-label={`${name} auf Server verteilen`}
              title="Verteilen"
              onClick={onDeploy}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${name} entfernen`}
              onClick={() => setConfirm(true)}
            >
              Entfernen
            </Button>
          </>
        }
      />
      {c.lastError ? (
        <div className="app-ctr-error">
          <Alert tone="crit" title={`${name}: ${c.lastError}`} />
        </div>
      ) : null}
      {deployErrors.map((d) => (
        <div className="app-ctr-error" key={d.serverId}>
          <Alert
            tone="warn"
            title={`${name} auf ${serverName(d.serverId)}: ${d.lastError ?? ''}`}
          />
        </div>
      ))}
      {err ? (
        <div className="app-ctr-error">
          <Alert tone="crit" title={`${name}: ${err}`} />
        </div>
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={`${name} entfernen?`}
          action="Mit Code entfernen"
          busy={del.isPending}
          error={del.error}
          onConfirm={() => del.mutate()}
          onClose={() => setConfirm(false)}
        >
          Löscht das Zertifikat und den Schlüssel in der Zentrale und die Dateien unter
          /opt/homelab/certs/ auf{' '}
          {c.deploy.length ? deployText.replace(/^auf /, '') : 'keinem Server'}. Dienste, die es
          nutzen, starten danach nicht mehr mit HTTPS.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function AcmeEmailForm({ settings }: { settings: DomainSettings }): ReactElement {
  const qc = useQueryClient();
  const [edited, setEdited] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = edited ?? settings.acmeEmail ?? '';
  const save = useMutation({
    mutationFn: saveDomainSettings,
    onSuccess: (s) => {
      patch(qc, (old) => ({ ...old, settings: s }));
      setEdited(null);
    },
  });
  function submit(e: FormEvent): void {
    e.preventDefault();
    const v = value.trim();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      setError('E-Mail-Adresse prüfen.');
      return;
    }
    setError(null);
    save.mutate({ acmeEmail: v || null });
  }
  const err = shownError(save.error);
  return (
    <form className="app-pad hz-form" onSubmit={submit} noValidate>
      <Field
        label="E-Mail für Let’s Encrypt (optional)"
        type="email"
        value={value}
        onChange={(e) => {
          setEdited(e.target.value);
          save.reset();
        }}
        autoComplete="email"
        hint="Let’s Encrypt schreibt hierhin, bevor ein Zertifikat abläuft."
        error={error}
      />
      {err ? <FormError title={err} /> : null}
      <div className="hz-form-actions">
        <Button type="submit" disabled={save.isPending || edited === null}>
          Speichern
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Create

export function CertDialog(props: {
  data: DomainsResponse;
  servers: readonly ServerSummary[];
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open
      onClose={props.onClose}
      title="Zertifikat anlegen"
      className="app-dialog-wide hz-dialog-sheet"
      dismissable={false}
    >
      <CertForm {...props} />
    </Dialog>
  );
}

export function CertForm({
  data,
  servers,
  onClose,
}: {
  data: DomainsResponse;
  servers: readonly ServerSummary[];
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const [providerId, setProviderId] = useState(data.providers[0]?.id ?? '');
  const [names, setNames] = useState('');
  const [ca, setCa] = useState<AcmeCa>('letsencrypt');
  const [autoRenew, setAutoRenew] = useState(true);
  const [deploy, setDeploy] = useState<CertDeployTarget[]>([]);
  const [errors, setErrors] = useState<Partial<Record<'names' | 'deploy', string>>>({});
  const provider = data.providers.find((p) => p.id === providerId);
  const parsed = parseNames(names);
  const save = useMutation({
    mutationFn: createCertificate,
    onSuccess: (c) => {
      replaceCert(qc, c);
      onClose();
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const errs: typeof errors = {};
    if (parsed.bad.length) errs.names = `Kein gültiger Name: ${parsed.bad.join(', ')}`;
    else if (parsed.names.length === 0 || parsed.names.length > 10) errs.names = '1 bis 10 Namen.';
    else if (provider) {
      const outside = parsed.names.filter((n) => !zoneOf(n, provider));
      if (outside.length)
        errs.names = `Nicht in einer Zone von ${provider.label}: ${outside.join(', ')}`;
    }
    if (deploy.some((d) => !isCertName(d.name))) {
      errs.deploy = 'Ordnernamen: Kleinbuchstaben, Ziffern und -';
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate({ providerId, names: parsed.names, ca, autoRenew, deploy });
  }

  const err = shownError(save.error);
  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <SelectField
        label="DNS-Anbieter (für DNS-01)"
        value={providerId}
        options={data.providers.map((p) => ({ value: p.id, label: p.label }))}
        onChange={(e) => setProviderId(e.target.value)}
        data-autofocus=""
      />
      <Field
        label="Namen"
        mono
        value={names}
        onChange={(e) => setNames(e.target.value)}
        placeholder={
          provider?.zones[0]
            ? `${provider.zones[0]}, *.${provider.zones[0]}`
            : 'example.com, *.example.com'
        }
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        hint="Mit Komma getrennt, bis zu 10. Der erste ist der Hauptname."
        error={errors.names}
      />
      <SelectField
        label="Zertifizierungsstelle"
        value={ca}
        options={(['letsencrypt', 'letsencrypt-staging'] as const).map((v) => ({
          value: v,
          label: CA_LABEL[v],
        }))}
        onChange={(e) => setCa(e.target.value as AcmeCa)}
        hint="Erst mit Staging testen: kein Limit, aber Browser vertrauen dem Zertifikat nicht. Let’s Encrypt erlaubt nur 5 gleiche Zertifikate pro Woche."
      />
      {ca === 'letsencrypt-staging' ? (
        <Alert tone="info" title="Staging ist nur zum Testen.">
          Klappt es, ein zweites Zertifikat mit Let’s Encrypt anlegen.
        </Alert>
      ) : null}
      <Toggle
        label="Automatisch erneuern"
        hint={`${CERT_RENEW_DAYS} Tage vor Ablauf, danach neu verteilen.`}
        checked={autoRenew}
        onChange={setAutoRenew}
      />
      <DeployFields
        servers={servers}
        value={deploy}
        names={parsed.names}
        onChange={setDeploy}
        error={errors.deploy}
      />
      {err ? <FormError title={err} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" type="submit" icon="lock" disabled={save.isPending}>
          {save.isPending ? 'Legt an …' : 'Mit Code anlegen'}
        </Button>
      </div>
    </form>
  );
}

/** One switch per server plus the folder name below /opt/homelab/certs/. */
function DeployFields({
  servers,
  value,
  names,
  onChange,
  error,
}: {
  servers: readonly ServerSummary[];
  value: CertDeployTarget[];
  names: readonly string[];
  onChange: (next: CertDeployTarget[]) => void;
  error?: string | undefined;
}): ReactElement {
  const fallback = defaultCertName(names);
  return (
    <fieldset className="app-fieldset">
      <legend className="hz-field-label">Verteilen auf</legend>
      {servers.length === 0 ? <p className="app-text">Noch kein Server verbunden.</p> : null}
      {servers.map((s) => {
        const target = value.find((d) => d.serverId === s.id);
        return (
          <div key={s.id} className="app-form-row">
            <Toggle
              label={s.name}
              checked={!!target}
              onChange={(on) =>
                onChange(
                  on
                    ? [...value, { serverId: s.id, name: fallback }]
                    : value.filter((d) => d.serverId !== s.id),
                )
              }
            />
            {target ? (
              <Field
                label={`Ordner auf ${s.name}`}
                mono
                value={target.name}
                onChange={(e) =>
                  onChange(
                    value.map((d) =>
                      d.serverId === s.id ? { ...d, name: e.target.value.trim().toLowerCase() } : d,
                    ),
                  )
                }
                hint={`/opt/homelab/certs/${target.name || '…'}/fullchain.pem und privkey.pem`}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            ) : null}
          </div>
        );
      })}
      {error ? <span className="hz-field-error">{error}</span> : null}
    </fieldset>
  );
}

export function DeployDialog({
  cert,
  servers,
  onClose,
}: {
  cert: Certificate;
  servers: readonly ServerSummary[];
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${cert.names[0] ?? 'Zertifikat'} verteilen`}
      className="app-dialog-wide hz-dialog-sheet"
      dismissable={false}
    >
      <DeployForm cert={cert} servers={servers} onClose={onClose} />
    </Dialog>
  );
}

function DeployForm({
  cert,
  servers,
  onClose,
}: {
  cert: Certificate;
  servers: readonly ServerSummary[];
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const [deploy, setDeploy] = useState<CertDeployTarget[]>(() =>
    cert.deploy.map((d) => ({ serverId: d.serverId, name: d.name })),
  );
  const [autoRenew, setAutoRenew] = useState(cert.autoRenew);
  const [error, setError] = useState<string | undefined>(undefined);
  const save = useMutation({
    mutationFn: () => updateCertificate(cert.id, { deploy, autoRenew }),
    onSuccess: (c) => {
      replaceCert(qc, c);
      onClose();
    },
  });
  function submit(e: FormEvent): void {
    e.preventDefault();
    if (deploy.some((d) => !isCertName(d.name))) {
      setError('Ordnernamen: Kleinbuchstaben, Ziffern und -');
      return;
    }
    setError(undefined);
    save.mutate();
  }
  const err = shownError(save.error);
  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <p className="hz-dialog-text">
        Nicht mehr gewählte Server: die Dateien dort werden gelöscht. Neue bekommen das Zertifikat
        gleich.
      </p>
      <DeployFields
        servers={servers}
        value={deploy}
        names={cert.names}
        onChange={setDeploy}
        error={error}
      />
      <Toggle label="Automatisch erneuern" checked={autoRenew} onChange={setAutoRenew} />
      {err ? <FormError title={err} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" type="submit" disabled={save.isPending}>
          {save.isPending
            ? 'Speichert …'
            : deployAddsTarget(cert, deploy)
              ? 'Mit Code speichern'
              : 'Speichern'}
        </Button>
      </div>
    </form>
  );
}

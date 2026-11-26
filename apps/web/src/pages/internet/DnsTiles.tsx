import type {
  DnsProvider,
  DnsProviderKind,
  DnsRecord,
  DnsRecordCreate,
  DnsRecordType,
  DomainsResponse,
  ServerSummary,
} from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Badge, Button, ServiceRow, Tile, Toggle } from '@hz/ui';
import { ConfirmDialog, shownError } from '../../components/ConfirmDialog.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField, type SelectOption } from '../../components/SelectField.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatWhen } from '../../lib/format.js';
import {
  PROVIDER_LABEL,
  RECORD_STATUS,
  RECORD_STATUS_TEXT,
  RECORD_TYPES,
  createProvider,
  createRecord,
  deleteProvider,
  deleteRecord,
  domainsKey,
  isFqdn,
  syncRecord,
  targetText,
  testProvider,
  ttlText,
  updateRecord,
  zoneOf,
} from '../../lib/domains.js';

type Qc = ReturnType<typeof useQueryClient>;

function patch(qc: Qc, fn: (old: DomainsResponse) => DomainsResponse): void {
  qc.setQueryData<DomainsResponse>(domainsKey, (old) => (old ? fn(old) : old));
}

function domainErrorText(err: unknown): string {
  if (isApiError(err, 'in_use')) return 'Wird noch von Einträgen oder Zertifikaten benutzt.';
  if (isApiError(err, 'exists')) return 'Den Namen gibt es beim Anbieter schon.';
  return errorText(err);
}

// ---------------------------------------------------------------------------
// Providers

/** DNS-Anbieter: token only as input, shown as hint (last 4 characters). */
export function ProvidersTile({ data, now }: { data: DomainsResponse; now: Date }): ReactElement {
  const [adding, setAdding] = useState(false);
  return (
    <Tile
      title="DNS-Anbieter"
      className="app-wrap-tile"
      icon="cloud"
      count={String(data.providers.length)}
      span={4}
      flush
      actions={
        <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
          Anbieter anlegen
        </Button>
      }
      footer={
        <span className="app-foot-text">Tokens verschlüsselt gespeichert · anlegen mit Code</span>
      }
    >
      {data.providers.length === 0 ? (
        <p className="app-empty app-pad">
          Noch kein Anbieter. Cloudflare braucht einen API-Token mit Zone:DNS:Edit, DuckDNS den
          Token von duckdns.org.
        </p>
      ) : (
        data.providers.map((p) => <ProviderRow key={p.id} p={p} now={now} />)
      )}
      {adding ? <ProviderDialog onClose={() => setAdding(false)} /> : null}
    </Tile>
  );
}

function providerStatus(p: DnsProvider): 'ok' | 'crit' | 'info' {
  if (p.lastError) return 'crit';
  return p.lastOkAt ? 'ok' : 'info';
}

export function ProviderRow({ p, now }: { p: DnsProvider; now: Date }): ReactElement {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const test = useMutation({
    mutationFn: () => testProvider(p.id),
    onSuccess: (r) =>
      patch(qc, (old) => ({
        ...old,
        providers: old.providers.map((x) =>
          x.id === p.id
            ? {
                ...x,
                zones: r.ok ? r.zones : x.zones,
                lastOkAt: r.ok ? Date.now() : x.lastOkAt,
                lastError: r.ok ? null : r.error,
              }
            : x,
        ),
      })),
  });
  const del = useMutation({
    mutationFn: () => deleteProvider(p.id),
    onSuccess: () => {
      patch(qc, (old) => ({ ...old, providers: old.providers.filter((x) => x.id !== p.id) }));
      setConfirm(false);
    },
  });
  const zones = p.zones.length ? p.zones.join(', ') : 'keine Zonen';
  const state = p.lastError
    ? p.lastError
    : p.lastOkAt
      ? `OK ${formatWhen(new Date(p.lastOkAt), now)}`
      : 'nicht getestet';
  const err = shownError(test.error);
  return (
    <>
      <ServiceRow
        name={p.label}
        host={`${PROVIDER_LABEL[p.kind]} · Token …${p.tokenHint} · ${zones}`}
        status={test.isPending ? 'busy' : providerStatus(p)}
        meta={state}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              icon="check"
              aria-label={`${p.label} testen`}
              title="Testen"
              disabled={test.isPending}
              onClick={() => test.mutate()}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${p.label} entfernen`}
              onClick={() => setConfirm(true)}
            >
              Entfernen
            </Button>
          </>
        }
      />
      {err ? (
        <div className="app-ctr-error">
          <Alert tone="crit" title={`${p.label}: ${err}`} />
        </div>
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={`${p.label} entfernen?`}
          action="Mit Code entfernen"
          busy={del.isPending}
          error={del.error}
          errorTextOf={domainErrorText}
          onConfirm={() => del.mutate()}
          onClose={() => setConfirm(false)}
        >
          Der Token wird gelöscht. Geht nur, wenn kein Eintrag und kein Zertifikat den Anbieter mehr
          nutzt.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

export function ProviderDialog({ onClose }: { onClose: () => void }): ReactElement {
  return (
    <Dialog open onClose={onClose} title="DNS-Anbieter anlegen" dismissable={false}>
      <ProviderForm onClose={onClose} />
    </Dialog>
  );
}

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;
const LABEL_RE = /^[\p{L}\p{N} .,:()_+/-]{1,60}$/u;

export function ProviderForm({ onClose }: { onClose: () => void }): ReactElement {
  const qc = useQueryClient();
  const [kind, setKind] = useState<DnsProviderKind>('cloudflare');
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [subs, setSubs] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'label' | 'token' | 'subs', string>>>({});
  const save = useMutation({
    mutationFn: createProvider,
    onSuccess: (p) => {
      patch(qc, (old) => ({ ...old, providers: [...old.providers, p] }));
      setToken('');
      onClose();
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const errs: typeof errors = {};
    const name = label.trim() || PROVIDER_LABEL[kind];
    if (!LABEL_RE.test(name)) errs.label = 'Höchstens 60 Zeichen, ohne Sonderzeichen.';
    if (!TOKEN_RE.test(token.trim()))
      errs.token = '20 bis 200 Zeichen: Buchstaben, Ziffern, - und _';
    const subdomains = subs
      .split(/[,\s]+/)
      .map((x) =>
        x
          .trim()
          .toLowerCase()
          .replace(/\.duckdns\.org$/, ''),
      )
      .filter(Boolean);
    if (
      kind === 'duckdns' &&
      (subdomains.length === 0 ||
        subdomains.length > 5 ||
        !subdomains.every((x) => SUBDOMAIN_RE.test(x)))
    ) {
      errs.subs = '1 bis 5 Namen ohne .duckdns.org, z. B. meinheim';
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate(
      kind === 'duckdns'
        ? { kind, label: name, token: token.trim(), subdomains }
        : { kind, label: name, token: token.trim() },
    );
  }

  const err = shownError(save.error, domainErrorText);
  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <SelectField
        label="Anbieter"
        value={kind}
        options={[
          { value: 'cloudflare', label: 'Cloudflare' },
          { value: 'duckdns', label: 'DuckDNS' },
        ]}
        onChange={(e) => setKind(e.target.value as DnsProviderKind)}
        data-autofocus=""
      />
      <Field
        label="Bezeichnung"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={PROVIDER_LABEL[kind]}
        maxLength={60}
        autoComplete="off"
        error={errors.label}
      />
      <Field
        label={kind === 'cloudflare' ? 'API-Token' : 'Token'}
        mono
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        hint={
          kind === 'cloudflare'
            ? 'Cloudflare → Profil → API-Tokens, Vorlage „Edit zone DNS“. Wird nie wieder angezeigt.'
            : 'Steht oben auf duckdns.org nach dem Anmelden. Wird nie wieder angezeigt.'
        }
        error={errors.token}
      />
      {kind === 'duckdns' ? (
        <Field
          label="Subdomains"
          mono
          value={subs}
          onChange={(e) => setSubs(e.target.value)}
          placeholder="meinheim, spiele"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          hint="Bis zu 5, ohne .duckdns.org."
          error={errors.subs}
        />
      ) : null}
      {err ? <FormError title={err} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" type="submit" icon="lock" disabled={save.isPending}>
          {save.isPending ? 'Prüft …' : 'Mit Code anlegen'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Records

/** DNS-Einträge; relay records are read only ("vom Game-Relay verwaltet"). */
export function RecordsTile({
  data,
  servers,
  now,
}: {
  data: DomainsResponse;
  servers: readonly ServerSummary[];
  now: Date;
}): ReactElement {
  const [editing, setEditing] = useState<DnsRecord | 'new' | null>(null);
  const bad = data.records.filter((r) => r.status === 'error').length;
  const records = [...data.records].sort(
    (a, b) =>
      (a.status === 'error' ? 0 : 1) - (b.status === 'error' ? 0 : 1) ||
      a.name.localeCompare(b.name, 'de'),
  );
  return (
    <Tile
      title="DNS-Einträge"
      className="app-wrap-tile"
      icon="globe"
      count={bad ? `${records.length} · ${bad} Fehler` : String(records.length)}
      span={4}
      flush
      actions={
        <Button
          size="sm"
          icon="plus"
          disabled={data.providers.length === 0}
          onClick={() => setEditing('new')}
        >
          Eintrag anlegen
        </Button>
      }
      footer={
        <span className="app-foot-text">
          Ziel „Server“ folgt der öffentlichen IP (geprüft jede Minute) · nur eigene Einträge werden
          geändert
        </span>
      }
    >
      {records.length === 0 ? (
        <p className="app-empty app-pad">
          {data.providers.length
            ? 'Noch kein Eintrag. Zum Beispiel home.example.com auf die IP des Heimservers.'
            : 'Zuerst einen DNS-Anbieter anlegen.'}
        </p>
      ) : (
        records.map((r) => (
          <RecordRow
            key={r.id}
            r={r}
            data={data}
            servers={servers}
            now={now}
            onEdit={() => setEditing(r)}
          />
        ))
      )}
      {editing ? (
        <RecordDialog
          data={data}
          servers={servers}
          record={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Tile>
  );
}

export function RecordRow({
  r,
  data,
  servers,
  now,
  onEdit,
}: {
  r: DnsRecord;
  data: DomainsResponse;
  servers: readonly ServerSummary[];
  now: Date;
  onEdit: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const sync = useMutation({
    mutationFn: () => syncRecord(r.id),
    onSuccess: (next) =>
      patch(qc, (old) => ({
        ...old,
        records: old.records.map((x) => (x.id === next.id ? next : x)),
      })),
  });
  const del = useMutation({
    mutationFn: () => deleteRecord(r.id),
    onSuccess: () => {
      patch(qc, (old) => ({ ...old, records: old.records.filter((x) => x.id !== r.id) }));
      setConfirm(false);
    },
  });
  const provider = data.providers.find((p) => p.id === r.providerId);
  const relay = r.owner === 'relay';
  const host = [
    `${r.type} → ${targetText(r, servers)}`,
    ttlText(r.ttl),
    r.proxied ? 'Proxy' : null,
    provider?.label ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
  const meta = r.lastError
    ? r.lastError
    : `${RECORD_STATUS_TEXT[r.status]}${r.value ? ` · ${r.value}` : ''}${r.lastSyncAt ? ` · ${formatWhen(new Date(r.lastSyncAt), now)}` : ''}`;
  const err = shownError(sync.error, domainErrorText);
  return (
    <>
      <ServiceRow
        name={r.name}
        host={host}
        status={sync.isPending ? 'busy' : RECORD_STATUS[r.status]}
        meta={
          relay ? (
            <>
              <Badge tone="neutral">vom Game-Relay verwaltet</Badge> {meta}
            </>
          ) : (
            meta
          )
        }
        actions={
          relay ? undefined : (
            <>
              <Button
                size="sm"
                variant="ghost"
                icon="refresh"
                aria-label={`${r.name} jetzt abgleichen`}
                title="Jetzt abgleichen"
                disabled={sync.isPending}
                onClick={() => sync.mutate()}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${r.name} bearbeiten`}
                onClick={onEdit}
              >
                Bearbeiten
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${r.name} löschen`}
                onClick={() => setConfirm(true)}
              >
                Löschen
              </Button>
            </>
          )
        }
      />
      {err ? (
        <div className="app-ctr-error">
          <Alert tone="crit" title={`${r.name}: ${err}`} />
        </div>
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={`${r.name} löschen?`}
          action="Löschen"
          busy={del.isPending}
          error={del.error}
          errorTextOf={domainErrorText}
          onConfirm={() => del.mutate()}
          onClose={() => setConfirm(false)}
        >
          Der Eintrag wird auch bei {provider?.label ?? 'dem Anbieter'} gelöscht. Wer den Namen
          nutzt, erreicht danach nichts mehr.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

export function RecordDialog(props: {
  data: DomainsResponse;
  servers: readonly ServerSummary[];
  record?: DnsRecord | undefined;
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={props.record ? `${props.record.name} bearbeiten` : 'DNS-Eintrag anlegen'}
      className="app-dialog-wide hz-dialog-sheet"
      dismissable={false}
    >
      <RecordForm {...props} />
    </Dialog>
  );
}

type RecordErrors = Partial<Record<'name' | 'target' | 'ttl', string>>;

export function RecordForm({
  data,
  servers,
  record,
  onClose,
}: {
  data: DomainsResponse;
  servers: readonly ServerSummary[];
  record?: DnsRecord | undefined;
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const [providerId, setProviderId] = useState(record?.providerId ?? data.providers[0]?.id ?? '');
  const [name, setName] = useState(record?.name ?? '');
  const [type, setType] = useState<DnsRecordType>(record?.type ?? 'A');
  const [targetKind, setTargetKind] = useState<'server' | 'static'>(
    record?.target.kind ?? 'server',
  );
  const [serverId, setServerId] = useState(
    record?.target.kind === 'server' ? record.target.serverId : (servers[0]?.id ?? ''),
  );
  const [value, setValue] = useState(record?.target.kind === 'static' ? record.target.value : '');
  const [ttl, setTtl] = useState(String(record?.ttl ?? 300));
  const [proxied, setProxied] = useState(record?.proxied ?? false);
  const [errors, setErrors] = useState<RecordErrors>({});
  const [exists, setExists] = useState(false);
  const provider = data.providers.find((p) => p.id === providerId);
  const cname = type === 'CNAME';
  const kind = cname ? 'static' : targetKind;

  const save = useMutation({
    mutationFn: (v: { body: DnsRecordCreate }) =>
      record
        ? updateRecord(record.id, {
            target: v.body.target,
            ttl: v.body.ttl,
            proxied: v.body.proxied,
          })
        : createRecord(v.body),
    onSuccess: (saved) => {
      patch(qc, (old) => ({
        ...old,
        records: old.records.some((x) => x.id === saved.id)
          ? old.records.map((x) => (x.id === saved.id ? saved : x))
          : [...old.records, saved],
      }));
      onClose();
    },
    onError: (err) => setExists(isApiError(err, 'exists')),
  });

  function body(adopt: boolean): DnsRecordCreate | null {
    const errs: RecordErrors = {};
    const n = name.trim().toLowerCase().replace(/\.$/, '');
    if (!isFqdn(n) || n.startsWith('*.')) errs.name = 'Voller Name ohne *, z. B. home.example.com';
    else if (provider && !zoneOf(n, provider)) {
      errs.name = `Liegt in keiner Zone von ${provider.label}: ${provider.zones.join(', ') || 'keine'}`;
    }
    const t = Number(ttl);
    if (!Number.isInteger(t) || t < 60 || t > 86_400) errs.ttl = '60 bis 86400 s';
    const v = value.trim();
    if (kind === 'static') {
      const ok =
        type === 'A'
          ? /^(?:\d{1,3}\.){3}\d{1,3}$/.test(v)
          : type === 'AAAA'
            ? v.includes(':')
            : isFqdn(v);
      if (!ok)
        errs.target =
          type === 'CNAME' ? 'Ziel-Name, z. B. ziel.example.net' : `${type}-Adresse eintragen`;
    } else if (!serverId) errs.target = 'Server wählen.';
    setErrors(errs);
    if (Object.keys(errs).length) return null;
    return {
      providerId,
      name: n,
      type,
      target: kind === 'static' ? { kind: 'static', value: v } : { kind: 'server', serverId },
      ttl: t,
      proxied: provider?.kind === 'cloudflare' ? proxied : false,
      adopt,
    };
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const b = body(false);
    if (b) save.mutate({ body: b });
  }

  const serverOptions: SelectOption[] = servers.map((s) => ({
    value: s.id,
    label: s.publicIp ? `${s.name} · ${s.publicIp}` : `${s.name} · IP noch unbekannt`,
  }));
  const err = exists ? null : shownError(save.error, domainErrorText);

  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <div className="app-form-row">
        <SelectField
          label="Anbieter"
          value={providerId}
          options={data.providers.map((p) => ({
            value: p.id,
            label: `${p.label} · ${PROVIDER_LABEL[p.kind]}`,
          }))}
          onChange={(e) => setProviderId(e.target.value)}
          disabled={!!record}
          data-autofocus=""
        />
        <SelectField
          label="Typ"
          value={type}
          options={RECORD_TYPES.filter((t) => provider?.kind !== 'duckdns' || t !== 'CNAME').map(
            (t) => ({ value: t, label: t }),
          )}
          onChange={(e) => setType(e.target.value as DnsRecordType)}
          disabled={!!record}
        />
      </div>
      <Field
        label="Name"
        mono
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={provider?.zones[0] ? `home.${provider.zones[0]}` : 'home.example.com'}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        disabled={!!record}
        hint={
          provider ? `Zonen: ${provider.zones.join(', ') || 'keine (Anbieter testen)'}` : undefined
        }
        error={errors.name}
      />
      {cname ? null : (
        <div className="app-range" role="group" aria-label="Ziel">
          <Button
            size="sm"
            variant={kind === 'server' ? 'secondary' : 'ghost'}
            aria-pressed={kind === 'server'}
            onClick={() => setTargetKind('server')}
          >
            Öffentliche IP eines Servers
          </Button>
          <Button
            size="sm"
            variant={kind === 'static' ? 'secondary' : 'ghost'}
            aria-pressed={kind === 'static'}
            onClick={() => setTargetKind('static')}
          >
            Fester Wert
          </Button>
        </div>
      )}
      {kind === 'server' ? (
        <SelectField
          label="Server"
          value={serverId}
          options={serverOptions}
          onChange={(e) => setServerId(e.target.value)}
          hint="Ändert sich die IP (DynDNS), zieht der Eintrag nach, höchstens einmal pro Minute."
          error={errors.target}
        />
      ) : (
        <Field
          label={cname ? 'Ziel-Name' : 'Wert'}
          mono
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={cname ? 'ziel.example.net' : type === 'AAAA' ? '2001:db8::1' : '203.0.113.7'}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          error={errors.target}
        />
      )}
      <div className="app-form-row">
        <Field
          label="TTL in s"
          mono
          inputMode="numeric"
          value={ttl}
          onChange={(e) => setTtl(e.target.value)}
          error={errors.ttl}
        />
        {provider?.kind === 'cloudflare' ? (
          <Toggle
            label="Cloudflare-Proxy"
            hint="Nur für Websites. Gameserver und andere Ports brauchen ihn aus."
            checked={proxied}
            onChange={setProxied}
          />
        ) : null}
      </div>
      {exists ? (
        <Alert
          tone="warn"
          title={`${name.trim()} gibt es bei ${provider?.label ?? 'dem Anbieter'} schon.`}
        >
          Die Zentrale ändert nur eigene Einträge. Übernehmen ersetzt den vorhandenen Wert und
          braucht einen Code.
        </Alert>
      ) : null}
      {err ? <FormError title={err} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        {exists ? (
          <Button
            variant="danger"
            icon="lock"
            disabled={save.isPending}
            onClick={() => {
              const b = body(true);
              if (b) save.mutate({ body: b });
            }}
          >
            Mit Code übernehmen
          </Button>
        ) : (
          <Button variant="primary" type="submit" disabled={save.isPending}>
            {save.isPending ? 'Speichert …' : 'Speichern'}
          </Button>
        )}
      </div>
    </form>
  );
}

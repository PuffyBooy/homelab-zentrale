import type {
  AppBind,
  AppParam,
  AppPreviewResponse,
  AppTemplateDetail,
  InstalledApp,
  ServerSummary,
} from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, Toggle } from '@hz/ui';
import { shownError } from '../../components/ConfirmDialog.js';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import {
  BIND_OPTIONS,
  appErrorText,
  appTemplateKey,
  appsKey,
  draftToInstall,
  fetchAppTemplate,
  installApp,
  paramDefaults,
  previewApp,
  serverChoice,
  suggestAppId,
  type InstallDraft,
  type InstallErrors,
  type ParamValue,
} from '../../lib/apps.js';
import { errorText } from '../../lib/errors.js';

export interface InstallDialogProps {
  templateId: string;
  servers: readonly ServerSummary[];
  apps: readonly InstalledApp[];
  onClose: () => void;
}

/** Install a template: server, name, folder, bind address, parameters, preview (M21). */
export function InstallDialog(props: InstallDialogProps): ReactElement {
  const q = useQuery({
    queryKey: appTemplateKey(props.templateId),
    queryFn: ({ signal }) => fetchAppTemplate(props.templateId, signal),
  });
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={q.data ? `${q.data.meta.name} installieren` : 'App installieren'}
      className="app-dialog-wide hz-dialog-sheet"
      dismissable={false}
    >
      {q.data ? (
        <InstallForm {...props} tpl={q.data} />
      ) : (
        <div className="hz-dialog-body">
          {q.error ? (
            <FormError title={errorText(q.error)} />
          ) : (
            <p className="hz-dialog-text">Lade Vorlage …</p>
          )}
          <div className="hz-dialog-foot">
            <Button onClick={props.onClose}>Abbrechen</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function InstallForm({
  tpl,
  servers,
  apps,
  onClose,
}: InstallDialogProps & { tpl: AppTemplateDetail }): ReactElement {
  const qc = useQueryClient();
  const choices = servers.map((s) => serverChoice(s, tpl.meta));
  const first = choices.find((c) => !c.disabled)?.value ?? '';
  const [draft, setDraft] = useState<InstallDraft>(() => ({
    serverId: first,
    appId: suggestAppId(tpl.meta.id, first, apps),
    name: tpl.meta.name,
    bind: 'tailnet',
    params: paramDefaults(tpl.meta.params),
  }));
  const [errors, setErrors] = useState<InstallErrors>({});
  /** The preview belongs to this exact draft; any change drops it. */
  const [preview, setPreview] = useState<AppPreviewResponse | null>(null);

  const check = useMutation({ mutationFn: previewApp, onSuccess: setPreview });
  const install = useMutation({
    mutationFn: installApp,
    onSuccess: (app) => {
      qc.setQueryData<InstalledApp[]>(appsKey, (old) => [...(old ?? []), app]);
      void qc.invalidateQueries({ queryKey: appsKey });
      onClose();
    },
  });

  function change(patch: Partial<InstallDraft>): void {
    setDraft((d) => {
      const next = { ...d, ...patch };
      // Folder follows the server while the user did not type one.
      if (patch.serverId && d.appId === suggestAppId(tpl.meta.id, d.serverId, apps)) {
        next.appId = suggestAppId(tpl.meta.id, patch.serverId, apps);
      }
      return next;
    });
    setErrors({});
    setPreview(null);
    check.reset();
    install.reset();
  }

  const setParam = (key: string, value: ParamValue): void =>
    change({ params: { ...draft.params, [key]: value } });

  function body(): ReturnType<typeof draftToInstall> {
    const res = draftToInstall(draft, tpl);
    if (!res.ok) setErrors(res.errors);
    return res;
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = body();
    if (res.ok) install.mutate(res.body);
  }

  const problems = preview?.problems ?? [];
  const err = shownError(install.error, (x) => appErrorText(x, errorText));
  const previewErr = shownError(check.error, (x) => appErrorText(x, errorText));

  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <p className="hz-dialog-text">{tpl.meta.description}</p>
      {tpl.meta.hints.length ? (
        <Alert tone="info" title="Vor dem Installieren">
          {tpl.meta.hints.map((h) => (
            <span key={h} className="app-alert-line">
              {h}
            </span>
          ))}
        </Alert>
      ) : null}
      <div className="app-form-row">
        <SelectField
          label="Server"
          value={draft.serverId}
          options={
            choices.length
              ? choices
              : [{ value: '', label: 'Kein Server verbunden', disabled: true }]
          }
          onChange={(e) => change({ serverId: e.target.value })}
          hint={`Läuft auf ${tpl.meta.arch.join(' und ')}. Braucht etwa ${tpl.meta.minRamMb} MB RAM.`}
          error={errors.serverId}
          data-autofocus=""
        />
        <Field
          label="Name"
          value={draft.name}
          onChange={(e) => change({ name: e.target.value })}
          maxLength={60}
          autoComplete="off"
          error={errors.name}
        />
      </div>
      <div className="app-form-row">
        <Field
          label="App-Ordner"
          mono
          value={draft.appId}
          onChange={(e) => change({ appId: e.target.value.trim().toLowerCase() })}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={32}
          hint={`/opt/homelab/apps/${draft.appId || '…'}/ mit compose.yml, .env und data/`}
          error={errors.appId}
        />
        <SelectField
          label="Erreichbar über"
          value={draft.bind}
          options={BIND_OPTIONS}
          onChange={(e) => change({ bind: e.target.value as AppBind })}
        />
      </div>
      {draft.bind === 'all' ? (
        <Alert tone="warn" title="Ports offen für alle Netze.">
          Die App lauscht auf 0.0.0.0. Mit Portweiterleitung im Router ist sie aus dem Internet
          erreichbar. Die Ports kommen zu den erlaubten Ports des Servers. Lieber Tailnet nehmen,
          wenn nur du sie brauchst.
        </Alert>
      ) : null}

      {tpl.meta.params.length ? (
        <fieldset className="app-fieldset">
          <legend className="hz-field-label">Einstellungen</legend>
          <div className="app-fields">
            {tpl.meta.params.map((p) => (
              <ParamField
                key={p.key}
                p={p}
                value={draft.params[p.key]}
                error={errors.params?.[p.key]}
                onChange={(v) => setParam(p.key, v)}
              />
            ))}
          </div>
        </fieldset>
      ) : null}

      {preview ? (
        problems.length ? (
          <Alert tone="crit" title="So geht die Installation nicht:">
            {problems.map((p) => (
              <span key={p} className="app-alert-line" data-testid="preview-problem">
                {p}
              </span>
            ))}
          </Alert>
        ) : (
          <Alert tone="ok" title="Vorschau ohne Probleme." />
        )
      ) : null}
      {preview ? (
        <>
          <CopyBlock label="compose.yml" text={preview.compose} />
          <CopyBlock label=".env (Passwörter verdeckt)" text={preview.env} />
        </>
      ) : null}
      {previewErr ? <FormError title={previewErr} /> : null}
      {err ? <FormError title={err} /> : null}

      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button
          disabled={check.isPending}
          onClick={() => {
            const res = body();
            if (res.ok) check.mutate(res.body);
          }}
        >
          {check.isPending ? 'Prüft …' : 'Vorschau'}
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={install.isPending || problems.length > 0 || !draft.serverId}
        >
          {install.isPending ? 'Installiert …' : 'Installieren'}
        </Button>
      </div>
    </form>
  );
}

function ParamField({
  p,
  value,
  error,
  onChange,
}: {
  p: AppParam;
  value: ParamValue | undefined;
  error: string | undefined;
  onChange: (v: ParamValue) => void;
}): ReactElement {
  const text = typeof value === 'string' ? value : '';
  switch (p.type) {
    case 'bool':
      return <Toggle label={p.label} checked={value === true} onChange={onChange} />;
    case 'select':
      return (
        <SelectField
          label={p.label}
          value={text}
          options={p.options}
          onChange={(e) => onChange(e.target.value)}
          error={error}
        />
      );
    case 'password':
      return (
        <Field
          label={p.label}
          mono
          type="password"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          hint={
            p.generate
              ? 'Leer lassen: die Zentrale erzeugt eins. Später unter „Passwörter“ (mit Code).'
              : `Mindestens ${p.minLength} Zeichen.`
          }
          error={error}
        />
      );
    case 'port':
      return (
        <Field
          label={p.label}
          mono
          inputMode="numeric"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          hint={`${p.protocol.toUpperCase()}${p.web ? ' · Weboberfläche' : ''} · muss auf dem Server frei sein`}
          error={error}
        />
      );
    case 'number':
      return (
        <Field
          label={p.label}
          mono
          inputMode="numeric"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          hint={`${p.min} bis ${p.max}`}
          error={error}
        />
      );
    case 'string':
      return (
        <Field
          label={p.label}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          hint={p.required ? undefined : 'optional'}
          error={error}
        />
      );
  }
}

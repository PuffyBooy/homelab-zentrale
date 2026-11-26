import type { CheckKind, CheckSummary, ServerSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Button, Toggle } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField, type SelectOption } from '../../components/SelectField.js';
import {
  KIND_LABEL,
  checkToForm,
  checksKey,
  createCheck,
  defaultName,
  emptyCheckForm,
  formToDef,
  updateCheck,
  type CheckForm,
  type CheckFormErrors,
} from '../../lib/checks.js';
import { errorText } from '../../lib/errors.js';
import { mergeById } from '../../lib/live.js';

export interface CheckDialogProps {
  open: boolean;
  onClose: () => void;
  servers: ServerSummary[];
  /** Edit this check; create a new one without. */
  check?: CheckSummary | undefined;
  onSaved?: (c: CheckSummary) => void;
}

/** Create or edit an http/tcp/ping check (SPEC 8). */
export function CheckDialog(props: CheckDialogProps): ReactElement {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.check ? `${props.check.def.name} bearbeiten` : 'Check anlegen'}
      className="app-dialog-wide hz-dialog-sheet"
      dismissable={false}
    >
      <CheckFormBody {...props} />
    </Dialog>
  );
}

const KINDS: readonly CheckKind[] = ['http', 'tcp', 'ping'];

function CheckFormBody({ onClose, servers, check, onSaved }: CheckDialogProps): ReactElement {
  const qc = useQueryClient();
  const [form, setForm] = useState<CheckForm>(() =>
    check ? checkToForm(check.def) : emptyCheckForm(),
  );
  const [errors, setErrors] = useState<CheckFormErrors>({});
  const save = useMutation({
    mutationFn: (def: Parameters<typeof createCheck>[0]) =>
      check ? updateCheck(check.id, def) : createCheck(def),
    onSuccess: (saved) => {
      qc.setQueryData<CheckSummary[]>(checksKey, (old) => mergeById(old, [saved]));
      onSaved?.(saved);
      onClose();
    },
  });

  function set<K extends keyof CheckForm>(key: K, value: CheckForm[K]): void {
    setForm((f) => {
      const next = { ...f, [key]: value };
      // Ping needs an agent; switching to ping picks the first server.
      if (key === 'kind' && value === 'ping' && next.runFrom === 'core' && servers[0]) {
        next.runFrom = servers[0].id;
      }
      return next;
    });
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = formToDef(form);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    save.mutate(res.def);
  }

  const runFromOptions: SelectOption[] = [
    ...(form.kind === 'ping' ? [] : [{ value: 'core', label: 'Zentrale' }]),
    ...servers.map((s) => ({ value: s.id, label: `${s.name} (Agent)` })),
  ];
  const serverOptions: SelectOption[] = [
    { value: '', label: 'keinem Server' },
    ...servers.map((s) => ({ value: s.id, label: s.name })),
  ];

  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <div className="app-form-row">
        <SelectField
          label="Art"
          value={form.kind}
          onChange={(e) => set('kind', e.target.value as CheckKind)}
          options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          disabled={!!check}
          hint={check ? 'Die Art lässt sich nachträglich nicht ändern.' : undefined}
          data-autofocus=""
        />
        <SelectField
          label="Prüft von"
          value={form.runFrom}
          onChange={(e) => set('runFrom', e.target.value)}
          options={runFromOptions}
          error={errors.runFrom}
          hint={
            form.kind === 'ping'
              ? 'Ping (ICMP) läuft immer über einen Agent.'
              : 'Ein Agent prüft von außen, z. B. oracle-a1 auf die Heim-IP.'
          }
        />
      </div>

      {form.kind === 'http' ? (
        <Field
          label="URL"
          mono
          type="url"
          inputMode="url"
          value={form.url}
          onChange={(e) => set('url', e.target.value)}
          placeholder="https://sc-ball.at"
          autoComplete="off"
          spellCheck={false}
          error={errors.url}
        />
      ) : (
        <div className="app-form-row">
          <Field
            label="Host"
            mono
            value={form.host}
            onChange={(e) => set('host', e.target.value)}
            placeholder={form.kind === 'tcp' ? 'mc.hoebe.at' : '192.168.1.20'}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            error={errors.host}
          />
          {form.kind === 'tcp' ? (
            <Field
              label="Port"
              mono
              inputMode="numeric"
              value={form.port}
              onChange={(e) => set('port', e.target.value)}
              placeholder="25565"
              autoComplete="off"
              error={errors.port}
            />
          ) : null}
        </div>
      )}

      <div className="app-form-row">
        <Field
          label="Name"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder={defaultName(form) || 'sc-ball.at'}
          hint="Leer lassen, dann gilt der Host."
          maxLength={80}
          autoComplete="off"
          error={errors.name}
        />
        <Field
          label="Intervall in s"
          mono
          inputMode="numeric"
          value={form.intervalS}
          onChange={(e) => set('intervalS', e.target.value)}
          hint="30 bis 3600, Standard 60"
          error={errors.intervalS}
        />
      </div>

      {form.kind === 'http' ? (
        <>
          <div className="app-form-row">
            <Field
              label="Erwarteter Status von"
              mono
              inputMode="numeric"
              value={form.expectStatusMin}
              onChange={(e) => set('expectStatusMin', e.target.value)}
              error={errors.expectStatusMin}
            />
            <Field
              label="bis"
              mono
              inputMode="numeric"
              value={form.expectStatusMax}
              onChange={(e) => set('expectStatusMax', e.target.value)}
              error={errors.expectStatusMax}
            />
          </div>
          <Field
            label="Text, der vorkommen muss"
            value={form.contains}
            onChange={(e) => set('contains', e.target.value)}
            hint="Optional, z. B. ein Wort aus dem Seitentitel."
            maxLength={200}
            autoComplete="off"
            error={errors.contains}
          />
          <Toggle
            label="SSL- und Domain-Ablauf prüfen"
            hint="Warnung unter 14 Tagen SSL bzw. 30 Tagen Domain"
            checked={form.certCheck}
            onChange={(v) => set('certCheck', v)}
          />
        </>
      ) : null}

      <SelectField
        label="Gehört zu"
        value={form.serverId}
        onChange={(e) => set('serverId', e.target.value)}
        options={serverOptions}
        hint="Für den Server-Filter und den Text der Meldung."
        error={errors.serverId}
      />
      <Toggle
        label="Check aktiv"
        hint="Pausierte Checks melden nichts"
        checked={form.enabled}
        onChange={(v) => set('enabled', v)}
      />

      {save.error ? <FormError title={errorText(save.error)} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="primary" type="submit" disabled={save.isPending}>
          {check ? 'Speichern' : 'Anlegen'}
        </Button>
      </div>
    </form>
  );
}

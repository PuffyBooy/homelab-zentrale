import type { AzureRegion, AzureSettings } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, StatusDot, Tile } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { isApiError } from '../../lib/api.js';
import {
  azureKey,
  azureStatus,
  azureToForm,
  buildAzurePatch,
  cloudKey,
  dropsSecret,
  regionOptions,
  saveAzure,
  testAzure,
  type AzureForm,
  type AzureFormErrors,
} from '../../lib/cloud.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo } from '../../lib/format.js';

/** The user closed the step-up dialog: no error line for that. */
function shownError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return errorText(err);
}

const GUID_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

/**
 * Azure-Zugang (M22): app registration, subscription, resource group, region, Tailscale
 * auth key and budget. Secret and key are write-only: the input stays empty, "gespeichert"
 * says one is stored, an empty input leaves it unchanged. Credential changes need a code
 * (api() asks on step_up_required).
 */
export function AzureTile({
  settings: s,
  now,
}: {
  settings: AzureSettings;
  now: Date;
}): ReactElement {
  const qc = useQueryClient();
  const [form, setForm] = useState<AzureForm>(() => azureToForm(s));
  const [errors, setErrors] = useState<AzureFormErrors>({});
  const [notice, setNotice] = useState<string | null>(null);

  const apply = (next: AzureSettings): void => {
    qc.setQueryData(azureKey, next);
    void qc.invalidateQueries({ queryKey: cloudKey });
  };
  const save = useMutation({
    mutationFn: saveAzure,
    onSuccess: (next) => {
      apply(next);
      setForm(azureToForm(next));
      setNotice('Gespeichert.');
    },
  });
  const test = useMutation({
    mutationFn: testAzure,
    onSuccess: (next) => {
      apply(next);
      setNotice(next.status === 'ok' ? 'Verbindung steht.' : null);
    },
  });

  const set = <K extends keyof AzureForm>(k: K, v: AzureForm[K]): void => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
    setNotice(null);
  };

  const { patch } = buildAzurePatch(s, form);
  const willDropSecret = dropsSecret(s, patch);

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = buildAzurePatch(s, form);
    setErrors(res.errors);
    if (Object.keys(res.errors).length) return;
    if (Object.keys(res.patch).length === 0) {
      setNotice('Nichts geändert.');
      return;
    }
    save.mutate(res.patch);
  }

  const st = azureStatus(s);
  const busy = save.isPending || test.isPending;
  const err = shownError(save.error) ?? shownError(test.error);
  const complete =
    !!s.tenantId && !!s.clientId && !!s.subscriptionId && !!s.resourceGroup && s.secretSet;

  return (
    <Tile title="Azure-Zugang" icon="lock" status={st.status} statusLabel={st.label} span={2}>
      <AzureStatusLine settings={s} now={now} />
      <form className="hz-form" onSubmit={submit} noValidate data-testid="azure-form">
        <div className="app-fields">
          <Field
            label="Tenant-ID"
            mono
            value={form.tenantId}
            onChange={(e) => set('tenantId', e.target.value)}
            placeholder={GUID_PLACEHOLDER}
            error={errors.tenantId}
            autoComplete="off"
            spellCheck={false}
            maxLength={36}
          />
          <Field
            label="App-ID (Client-ID)"
            mono
            value={form.clientId}
            onChange={(e) => set('clientId', e.target.value)}
            placeholder={GUID_PLACEHOLDER}
            error={errors.clientId}
            autoComplete="off"
            spellCheck={false}
            maxLength={36}
          />
          <Field
            label="Client-Secret"
            mono
            type="password"
            autoComplete="new-password"
            value={form.clientSecret}
            onChange={(e) => set('clientSecret', e.target.value)}
            placeholder={s.secretSet ? 'gespeichert' : ''}
            hint={
              willDropSecret
                ? 'Tenant, App oder Abo geändert: das gespeicherte Secret wird verworfen, bitte neu eintragen.'
                : s.secretSet
                  ? 'gespeichert · leer lassen = unverändert'
                  : 'noch keins gespeichert'
            }
            error={errors.clientSecret}
            maxLength={200}
            spellCheck={false}
          />
          <Field
            label="Abo-ID (Subscription)"
            mono
            value={form.subscriptionId}
            onChange={(e) => set('subscriptionId', e.target.value)}
            placeholder={GUID_PLACEHOLDER}
            error={errors.subscriptionId}
            autoComplete="off"
            spellCheck={false}
            maxLength={36}
          />
          <Field
            label="Ressourcengruppe"
            mono
            value={form.resourceGroup}
            onChange={(e) => set('resourceGroup', e.target.value)}
            placeholder="homelab-zentrale"
            hint="Die App braucht dort die Rolle Mitwirkender, sonst nichts."
            error={errors.resourceGroup}
            autoComplete="off"
            spellCheck={false}
            maxLength={90}
          />
          <SelectField
            label="Region"
            value={form.region}
            onChange={(e) => set('region', e.target.value as AzureRegion)}
            options={regionOptions}
            hint="Standard für neue Server"
          />
          <Field
            label="Tailscale-Auth-Key"
            mono
            type="password"
            autoComplete="new-password"
            value={form.tailscaleAuthKey}
            onChange={(e) => set('tailscaleAuthKey', e.target.value)}
            placeholder={s.tailscaleKeySet ? 'gespeichert' : 'tskey-auth-…'}
            hint={
              s.tailscaleKeySet
                ? 'gespeichert · leer lassen = unverändert'
                : 'Wiederverwendbar und vorab freigegeben, am besten mit tag:homelab-cloud.'
            }
            error={errors.tailscaleAuthKey}
            maxLength={220}
            spellCheck={false}
          />
          <Field
            label="Budget €/Monat"
            mono
            inputMode="decimal"
            value={form.budgetEurPerMonth}
            onChange={(e) => set('budgetEurPerMonth', e.target.value)}
            hint="Warnung ab 80 %, ab 100 % keine automatischen Starts."
            error={errors.budgetEurPerMonth}
            autoComplete="off"
          />
        </div>
        <p className="app-text">
          Anleitung: docs/OFFENE-FRAGEN-UND-IDEEN.md, Abschnitt Azure (Punkt 27). Zugangsdaten
          ändern braucht einen Code.
        </p>
        {err ? <FormError title={err} /> : null}
        {notice ? <Alert tone="ok" title={notice} /> : null}
        <div className="hz-form-actions">
          <Button
            icon="refresh"
            disabled={busy || !complete}
            onClick={() => {
              setNotice(null);
              test.mutate();
            }}
          >
            {test.isPending ? 'Wird getestet …' : 'Verbindung testen'}
          </Button>
          <Button
            type="submit"
            variant={s.status === 'ok' ? 'secondary' : 'primary'}
            disabled={busy}
          >
            {save.isPending ? 'Wird gespeichert …' : 'Speichern'}
          </Button>
        </div>
      </form>
    </Tile>
  );
}

/** Status first: verbunden / Fehler with the fixed text / not complete. */
export function AzureStatusLine({
  settings: s,
  now,
}: {
  settings: AzureSettings;
  now: Date;
}): ReactElement {
  const st = azureStatus(s);
  const last = s.lastOkAt ? new Date(s.lastOkAt) : null;
  let text: string;
  if (s.status === 'ok')
    text = `Azure verbunden${last ? `, zuletzt geprüft ${formatAgo(last, now)}` : ''}.`;
  else if (s.status === 'error')
    text = `Azure-Fehler: ${s.error ?? 'Unerwartete Antwort von Azure'}${last ? `. Zuletzt ok ${formatAgo(last, now)}` : ''}.`;
  else text = 'Azure ist noch nicht eingerichtet. Alle Felder ausfüllen, speichern und testen.';
  return (
    <p className="app-cost-budget" data-testid="azure-status">
      <StatusDot status={st.status} label={st.label} className="app-status-auto" />
      <span>{text}</span>
    </p>
  );
}

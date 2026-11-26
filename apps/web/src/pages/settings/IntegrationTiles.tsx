import {
  INTEGRATIONS,
  type DnsFilterVariant,
  type IntegrationId,
  type IntegrationSettings,
  type Modules,
} from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useLocation } from 'react-router';
import { Alert, Button, StatusDot, Tile } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { TextareaField } from '../../components/TextareaField.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import {
  INTEGRATION_ICON,
  INTEGRATION_TITLE,
  SECRET_HINT,
  URL_NOTE,
  URL_PLACEHOLDER,
  VARIANT_LABEL,
  buildIntegrationPatch,
  deleteIntegrationSettings,
  hasErrors,
  integrationSettingsKey,
  integrationStatusText,
  integrationTileStatus,
  integrationToForm,
  lastOkText,
  saveIntegrationSettings,
  secretLabel,
  testIntegration,
  useIntegrationSettings,
  usernameLabel,
  type IntegrationForm,
  type IntegrationFormErrors,
} from '../../lib/integrations.js';
import { dnsFilterStatusKey, fritzStatusKey } from '../../lib/network.js';
import { kumaMonitorsKey } from '../../lib/kuma.js';
import { proxmoxGuestsKey } from '../../lib/proxmox.js';

/** The user closed the step-up dialog: no error line for that. */
function shownError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return errorText(err);
}

/** Data queries of an integration, refetched after a settings change. */
const DATA_KEY: Record<IntegrationId, readonly string[]> = {
  proxmox: proxmoxGuestsKey,
  dnsfilter: dnsFilterStatusKey,
  fritzbox: fritzStatusKey,
  uptimekuma: kumaMonitorsKey,
};

export const anchorOf = (id: IntegrationId): string => `anbindung-${id}`;

/** Integrations whose module is on, in contract order. */
export function enabledIntegrations(modules: Modules): IntegrationId[] {
  return INTEGRATIONS.filter((id) => modules[id]);
}

/**
 * Einstellungen → Anbindungen (SPEC 16): one tile per switched-on integration. The
 * group heading is the anchor `#anbindungen`; each tile has `#anbindung-<id>`.
 */
export function IntegrationTiles({ modules }: { modules: Modules }): ReactElement | null {
  const ids = enabledIntegrations(modules);
  if (!ids.length) return null;
  return (
    <>
      {ids.map((id) => (
        <IntegrationTile key={id} id={id} />
      ))}
    </>
  );
}

export function IntegrationTile({ id }: { id: IntegrationId }): ReactElement {
  const { query } = useIntegrationSettings(id);
  const { hash } = useLocation();
  const anchor = useRef<HTMLDivElement>(null);
  const s = query.data;
  useEffect(() => {
    if (hash === `#${anchorOf(id)}` && s) anchor.current?.scrollIntoView({ block: 'start' });
  }, [hash, s, id]);

  return (
    <div id={anchorOf(id)} ref={anchor} className="app-anchor">
      {s ? (
        <IntegrationForm id={id} settings={s} />
      ) : (
        <Tile title={INTEGRATION_TITLE[id]} icon={INTEGRATION_ICON[id]}>
          {query.isError ? (
            <FormError title={errorText(query.error)} />
          ) : (
            <p className="app-empty">Lade {INTEGRATION_TITLE[id]} …</p>
          )}
        </Tile>
      )}
    </div>
  );
}

export function IntegrationForm({
  id,
  settings: s,
}: {
  id: IntegrationId;
  settings: IntegrationSettings;
}): ReactElement {
  const qc = useQueryClient();
  const [form, setForm] = useState<IntegrationForm>(() => integrationToForm(s));
  const [errors, setErrors] = useState<IntegrationFormErrors>({});
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'tested' | null>(null);

  const apply = (next: IntegrationSettings): void => {
    qc.setQueryData(integrationSettingsKey(id), next);
    void qc.invalidateQueries({ queryKey: DATA_KEY[id] });
  };
  const save = useMutation({
    mutationFn: (body: Parameters<typeof saveIntegrationSettings>[1]) =>
      saveIntegrationSettings(id, body),
    onSuccess: (next) => {
      apply(next);
      setForm(integrationToForm(next));
      setNotice('saved');
    },
  });
  const test = useMutation({
    mutationFn: () => testIntegration(id),
    onSuccess: (next) => {
      apply(next);
      setNotice('tested');
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteIntegrationSettings(id),
    onSuccess: () => {
      setRemoving(false);
      setForm({ ...integrationToForm(s), url: '', username: '' });
      setNotice(null);
      void qc.invalidateQueries({ queryKey: integrationSettingsKey(id) });
      void qc.invalidateQueries({ queryKey: DATA_KEY[id] });
    },
  });

  const set = <K extends keyof IntegrationForm>(k: K, v: IntegrationForm[K]): void => {
    setForm((f) => ({ ...f, [k]: v }));
    setNotice(null);
  };

  function submit(e: FormEvent): void {
    e.preventDefault();
    const { patch, errors: next } = buildIntegrationPatch(id, s, form);
    setErrors(next);
    if (hasErrors(next) || Object.keys(patch).length === 0) return;
    save.mutate(patch);
  }

  const variant: DnsFilterVariant | null = id === 'dnsfilter' ? form.variant : null;
  const userLabel = usernameLabel(id, variant);
  const configured = s.url !== null || s.secretSet;
  const busy = save.isPending || test.isPending || remove.isPending;
  const err = shownError(save.error) ?? shownError(test.error);

  return (
    <Tile
      title={INTEGRATION_TITLE[id]}
      icon={INTEGRATION_ICON[id]}
      status={integrationTileStatus(s)}
      statusLabel={integrationStatusText(s)}
    >
      <IntegrationStatus settings={s} />
      <form className="hz-form" onSubmit={submit} noValidate>
        {id === 'dnsfilter' ? (
          <SelectField
            label="System"
            value={form.variant}
            onChange={(e) => set('variant', e.target.value as DnsFilterVariant)}
            options={(['pihole', 'adguard'] as const).map((v) => ({
              value: v,
              label: VARIANT_LABEL[v],
            }))}
          />
        ) : null}
        <Field
          label="Adresse"
          mono
          value={form.url}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          placeholder={URL_PLACEHOLDER[id]}
          onChange={(e) => set('url', e.target.value)}
          hint={URL_NOTE}
          error={errors.url}
        />
        {userLabel ? (
          <Field
            label={userLabel}
            mono
            value={form.username}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={120}
            placeholder={id === 'proxmox' ? 'hz@pve!zentrale' : 'admin'}
            onChange={(e) => set('username', e.target.value)}
            hint={
              id === 'fritzbox'
                ? 'Leer lassen, wenn sich die Box nur mit Passwort anmeldet.'
                : id === 'proxmox'
                  ? 'Am besten ein eigener Benutzer mit der Rolle PVEVMUser statt root.'
                  : undefined
            }
            error={errors.username}
          />
        ) : null}
        <Field
          label={secretLabel(id, variant)}
          mono
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          maxLength={500}
          value={form.secret}
          placeholder={s.secretSet ? 'gesetzt' : ''}
          onChange={(e) => set('secret', e.target.value)}
          hint={
            s.secretSet
              ? 'Gesetzt. Leer lassen, um es zu behalten. Es wird nie wieder angezeigt.'
              : `${SECRET_HINT[id]} Wird verschlüsselt gespeichert.`
          }
          error={errors.secret}
        />
        <TextareaField
          label="CA-Zertifikat (PEM), nur bei selbst signiertem Zertifikat"
          value={form.caCert}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          maxLength={12_000}
          placeholder={s.caSet ? 'gesetzt' : '-----BEGIN CERTIFICATE-----'}
          onChange={(e) => set('caCert', e.target.value)}
          hint={
            s.caSet
              ? 'Ein CA-Zertifikat ist gesetzt. Leer lassen, um es zu behalten.'
              : id === 'proxmox'
                ? 'Die Prüfung des Zertifikats wird nie abgeschaltet. Bei Proxmox: /etc/pve/pve-root-ca.pem.'
                : 'Die Prüfung des Zertifikats wird nie abgeschaltet.'
          }
          error={errors.caCert}
        />
        {s.caSet ? (
          <label className="app-check app-check-line">
            <input
              type="checkbox"
              checked={form.removeCa}
              onChange={(e) => set('removeCa', e.target.checked)}
            />
            <span>CA-Zertifikat beim Speichern entfernen</span>
          </label>
        ) : null}
        {err ? <FormError title={err} /> : null}
        {notice === 'saved' && !save.isPending ? (
          <Alert tone="ok" title="Gespeichert.">
            {s.status === 'ok'
              ? `${INTEGRATION_TITLE[id]} antwortet.`
              : 'Mit „Verbindung testen“ prüfst du den Zugang sofort.'}
          </Alert>
        ) : null}
        {notice === 'tested' && !test.isPending ? (
          s.status === 'ok' ? (
            <Alert tone="ok" title="Verbindung OK." />
          ) : (
            <Alert tone="crit" title={integrationStatusText(s)} />
          )
        ) : null}
        <div className="hz-form-actions">
          {configured ? (
            <Button variant="danger" disabled={busy} onClick={() => setRemoving(true)}>
              Entfernen
            </Button>
          ) : null}
          <Button
            icon="refresh"
            disabled={busy || !s.url || !s.secretSet}
            onClick={() => {
              setNotice(null);
              test.mutate();
            }}
          >
            Verbindung testen
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Speichern
          </Button>
        </div>
      </form>
      {removing ? (
        <Dialog
          open
          onClose={() => setRemoving(false)}
          title={`${INTEGRATION_TITLE[id]}-Zugang entfernen`}
        >
          <div className="hz-dialog-body">
            <p className="hz-dialog-text">
              Adresse, Zugangsdaten und CA-Zertifikat werden gelöscht. Das Modul bleibt an, zeigt
              aber nichts mehr, bis du neue Zugangsdaten einträgst.
            </p>
            {shownError(remove.error) ? <FormError title={shownError(remove.error) ?? ''} /> : null}
            <div className="hz-dialog-foot">
              <Button onClick={() => setRemoving(false)} data-autofocus="">
                Abbrechen
              </Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Entfernen
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </Tile>
  );
}

/** Status line: OK / Fehler: text / nicht eingerichtet, last OK, what is stored. */
export function IntegrationStatus({
  settings: s,
  now,
}: {
  settings: IntegrationSettings;
  now?: Date;
}): ReactElement {
  return (
    <dl className="app-kv">
      <dt>Status</dt>
      <dd>
        <StatusDot status={integrationTileStatus(s) ?? 'off'} label={integrationStatusText(s)} />
      </dd>
      <dt>Zuletzt OK</dt>
      <dd>{lastOkText(s, now)}</dd>
      <dt>Zugangsdaten</dt>
      <dd>
        {s.secretSet ? 'gesetzt' : 'nicht gesetzt'}
        {s.caSet ? ' · eigenes CA-Zertifikat' : ''}
      </dd>
    </dl>
  );
}

import type { NotifySettings } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Badge, Button, Tile, Toggle } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { describeUserAgent, formatAgo, formatDateTime, plural } from '../../lib/format.js';
import {
  PUSH_ERROR_TEXT,
  PushSetupError,
  SUPPORT_TEXT,
  browserPushEnv,
  deletePushDevice,
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  fetchNotifySettings,
  fetchPushDevices,
  fetchVapidKey,
  notifyFormToPatch,
  notifySettingsKey,
  notifyToForm,
  patchNotifySettings,
  pushDevicesKey,
  pushSupport,
  sendTestPush,
  thisDeviceId,
  vapidKey,
  type NotifyErrors,
  type NotifyForm,
} from '../../lib/push.js';

function pushErrorText(err: unknown): string {
  return err instanceof PushSetupError ? PUSH_ERROR_TEXT[err.reason] : errorText(err);
}

/** SPEC 9 + 13: Push on this device, device list, test message. */
export function PushTile(): ReactElement {
  const qc = useQueryClient();
  const [support, setSupport] = useState(() => pushSupport(browserPushEnv()));
  const [mine, setMine] = useState(() => thisDeviceId());
  const vapid = useQuery({ queryKey: vapidKey, queryFn: ({ signal }) => fetchVapidKey(signal) });
  const devices = useQuery({
    queryKey: pushDevicesKey,
    queryFn: ({ signal }) => fetchPushDevices(signal),
  });

  const enable = useMutation({
    mutationFn: () =>
      enablePushOnThisDevice(vapid.data ?? null, describeUserAgent(navigator.userAgent)),
    onSettled: () => {
      setSupport(pushSupport(browserPushEnv()));
      setMine(thisDeviceId());
      void qc.invalidateQueries({ queryKey: pushDevicesKey });
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await deletePushDevice(id);
      if (id === thisDeviceId()) await disablePushOnThisDevice();
    },
    onSuccess: () => {
      setMine(thisDeviceId());
      void qc.invalidateQueries({ queryKey: pushDevicesKey });
    },
  });
  const test = useMutation({ mutationFn: sendTestPush });

  const list = devices.data ?? [];
  const registered = !!mine && list.some((d) => d.id === mine);
  const noKey = vapid.data === null;
  const blockedText = support === 'granted' || support === 'default' ? null : SUPPORT_TEXT[support];
  const blocked = blockedText !== null;

  return (
    <Tile
      title="Push"
      icon="bell"
      count={devices.data ? plural(list.length, 'Gerät', 'Geräte') : undefined}
      flush
    >
      <div className="app-pad app-stack">
        {blockedText ? (
          <Alert tone="warn" title="Push auf diesem Gerät nicht möglich.">
            {blockedText}
          </Alert>
        ) : noKey ? (
          <Alert tone="warn" title="Push ist in der Zentrale nicht eingerichtet.">
            Kein VAPID-Schlüssel. Der Core erzeugt ihn beim Start; Log des Core-Containers prüfen.
          </Alert>
        ) : registered ? (
          <p className="app-text">
            Push auf diesem Gerät ist an. CRIT kommt sofort, WARN gesammelt.
          </p>
        ) : (
          <p className="app-text">
            Meldungen kommen als Push mit demselben Text wie in der Zentrale. Am Handy die
            installierte App verwenden.
          </p>
        )}
        {enable.error ? <FormError title={pushErrorText(enable.error)} /> : null}
        {test.isSuccess ? (
          <Alert
            tone="ok"
            title={`Testnachricht an ${plural(test.data, 'Gerät', 'Geräte')} gesendet.`}
          >
            {test.data === 0 ? 'Kein Gerät angemeldet.' : undefined}
          </Alert>
        ) : null}
        {test.error ? <FormError title={errorText(test.error)} /> : null}
        <div className="hz-form-actions">
          <Button onClick={() => test.mutate()} disabled={test.isPending || list.length === 0}>
            Testnachricht senden
          </Button>
          {registered ? null : (
            <Button
              variant="primary"
              icon="bell"
              onClick={() => enable.mutate()}
              disabled={blocked || noKey || vapid.isPending || enable.isPending}
            >
              Push auf diesem Gerät einschalten
            </Button>
          )}
        </div>
      </div>
      {devices.isError ? (
        <div className="app-pad">
          <FormError title={errorText(devices.error)} />
        </div>
      ) : null}
      {list.map((d) => (
        <div className="hz-row" key={d.id} data-testid="push-device">
          <div className="hz-row-main">
            <span className="hz-row-name">{d.label || d.endpointHost}</span>
            <span className="hz-row-sub">
              {d.endpointHost} · seit {formatDateTime(new Date(d.createdAt))} ·{' '}
              {d.lastOkAt
                ? `zuletzt zugestellt ${formatAgo(new Date(d.lastOkAt))}`
                : 'noch nichts zugestellt'}
            </span>
          </div>
          <div className="hz-row-meta">{d.id === mine ? <Badge>dieses Gerät</Badge> : null}</div>
          <div className="hz-row-actions">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${d.label || d.endpointHost} entfernen`}
              disabled={remove.isPending && remove.variables === d.id}
              onClick={() => remove.mutate(d.id)}
            >
              Entfernen
            </Button>
          </div>
        </div>
      ))}
      {remove.error ? (
        <div className="app-pad">
          <FormError title={errorText(remove.error)} />
        </div>
      ) : null}
    </Tile>
  );
}

/** SPEC 9: quiet hours, warn bundling, weekly report. */
export function NotifyTile(): ReactElement {
  const settings = useQuery({
    queryKey: notifySettingsKey,
    queryFn: ({ signal }) => fetchNotifySettings(signal),
  });
  return (
    <Tile title="Benachrichtigungen" icon="alert">
      {settings.data ? (
        <NotifyFormBody settings={settings.data} />
      ) : settings.isError ? (
        <FormError title={errorText(settings.error)} />
      ) : (
        <p className="app-empty">Lade Einstellungen …</p>
      )}
    </Tile>
  );
}

function NotifyFormBody({ settings }: { settings: NotifySettings }): ReactElement {
  const qc = useQueryClient();
  const [form, setForm] = useState<NotifyForm>(() => notifyToForm(settings));
  const [errors, setErrors] = useState<NotifyErrors>({});
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: patchNotifySettings,
    onSuccess: (next) => {
      qc.setQueryData(notifySettingsKey, next);
      setForm(notifyToForm(next));
      setSaved(true);
    },
  });

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 4000);
    return () => clearTimeout(t);
  }, [saved]);

  function set<K extends keyof NotifyForm>(key: K, value: NotifyForm[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setSaved(false);
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const res = notifyFormToPatch(form);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    save.mutate(res.patch);
  }

  return (
    <form className="hz-form" onSubmit={submit} noValidate>
      <div className="app-form-row">
        <Field
          label="Ruhezeit von"
          mono
          inputMode="numeric"
          value={form.quietStart}
          onChange={(e) => set('quietStart', e.target.value)}
          placeholder="23:00"
          hint="Dann nur CRIT als Push, Wiener Zeit."
          error={errors.quietStart}
        />
        <Field
          label="bis"
          mono
          inputMode="numeric"
          value={form.quietEnd}
          onChange={(e) => set('quietEnd', e.target.value)}
          placeholder="07:00"
          error={errors.quietEnd}
        />
      </div>
      <Field
        label="WARN sammeln, höchstens eine Push alle … Min"
        mono
        inputMode="numeric"
        value={form.warnBundleMinutes}
        onChange={(e) => set('warnBundleMinutes', e.target.value)}
        hint="5 bis 240, Standard 30. CRIT kommt immer sofort."
        error={errors.warnBundleMinutes}
      />
      <Toggle
        label="Wochenbericht"
        hint="Sonntag 19:00: Uptime, Ausfälle, Deploys, Backups, Speicher"
        checked={form.weeklyReport}
        onChange={(v) => set('weeklyReport', v)}
      />
      {save.error ? <FormError title={errorText(save.error)} /> : null}
      <div className="hz-form-actions">
        {saved ? (
          <span className="app-foot-text" role="status">
            Gespeichert.
          </span>
        ) : null}
        <Button type="submit" disabled={save.isPending}>
          Speichern
        </Button>
      </div>
    </form>
  );
}

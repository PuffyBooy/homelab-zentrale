import type { ServerSummary, WolConfig } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, Tile } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import {
  buildWolBody,
  fetchWol,
  saveWol,
  wakeServer,
  wakeErrorText,
  wolKey,
  wolToForm,
  type WolErrors,
  type WolForm,
} from '../../lib/wol.js';

export function useWol(serverId: string) {
  return useQuery({
    queryKey: wolKey(serverId),
    queryFn: ({ signal }) => fetchWol(serverId, signal),
    staleTime: 60_000,
  });
}

/** "Aufwecken" (SPEC 16): magic packet via the core or the agent of another server. */
export function useWake(serverId: string) {
  return useMutation({ mutationFn: () => wakeServer(serverId) });
}

export function wakeErrorOf(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return wakeErrorText(err);
}

/** Sender options: the core, or another server's agent (same LAN). */
export function senderOptions(
  serverId: string,
  servers: readonly ServerSummary[],
  current: string,
): { value: string; label: string }[] {
  const opts = [{ value: 'core', label: 'Zentrale' }];
  for (const s of servers) {
    if (s.id === serverId) continue;
    opts.push({ value: s.id, label: s.connected ? s.name : `${s.name} (offline)` });
  }
  if (current !== 'core' && !opts.some((o) => o.value === current))
    opts.push({ value: current, label: 'entfernter Server' });
  return opts;
}

/** Server detail → Wake-on-LAN: MAC, broadcast, port 7/9, sender. Empty MAC removes it. */
export function WolTile({
  serverId,
  serverName,
  servers,
}: {
  serverId: string;
  serverName: string;
  servers: readonly ServerSummary[];
}): ReactElement {
  const qc = useQueryClient();
  const wol = useWol(serverId);
  return (
    <Tile title="Wake-on-LAN" icon="power" span={2}>
      {wol.data ? (
        <WolFormBody
          key={serverId}
          serverId={serverId}
          serverName={serverName}
          servers={servers}
          config={wol.data}
          onSaved={(next) => qc.setQueryData(wolKey(serverId), next)}
        />
      ) : wol.isError ? (
        <FormError title={errorText(wol.error)} />
      ) : (
        <p className="app-empty">Lade Wake-on-LAN …</p>
      )}
    </Tile>
  );
}

function WolFormBody({
  serverId,
  serverName,
  servers,
  config,
  onSaved,
}: {
  serverId: string;
  serverName: string;
  servers: readonly ServerSummary[];
  config: WolConfig;
  onSaved: (next: WolConfig) => void;
}): ReactElement {
  const [form, setForm] = useState<WolForm>(() => wolToForm(config));
  const [errors, setErrors] = useState<WolErrors>({});
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof saveWol>[1]) => saveWol(serverId, body),
    onSuccess: (next) => {
      onSaved(next);
      setForm(wolToForm(next));
      setSaved(true);
    },
  });

  const set = <K extends keyof WolForm>(k: K, v: WolForm[K]): void => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  };

  function submit(e: FormEvent): void {
    e.preventDefault();
    const { body, errors: next } = buildWolBody(form);
    setErrors(next);
    if (body) save.mutate(body);
  }

  const err =
    save.error && !isApiError(save.error, 'step_up_required') ? errorText(save.error) : null;

  return (
    <form className="hz-form" onSubmit={submit} noValidate>
      <p className="app-text">
        {config.mac
          ? `Ist ${serverName} aus, weckt „Aufwecken“ ihn mit einem Magic Packet.`
          : `Mit MAC-Adresse lässt sich ${serverName} aufwecken, wenn er aus ist. BIOS und Netzwerkkarte müssen Wake-on-LAN erlauben.`}
      </p>
      <div className="app-fields">
        <Field
          label="MAC-Adresse"
          mono
          value={form.mac}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={17}
          placeholder="AA:BB:CC:DD:EE:FF"
          onChange={(e) => set('mac', e.target.value)}
          hint="Leer lassen schaltet Wake-on-LAN für diesen Server ab."
          error={errors.mac}
        />
        <Field
          label="Broadcast-Adresse"
          mono
          value={form.broadcast}
          autoComplete="off"
          spellCheck={false}
          maxLength={15}
          placeholder="255.255.255.255"
          inputMode="decimal"
          onChange={(e) => set('broadcast', e.target.value)}
          hint="255.255.255.255 oder die des Netzes, z. B. 192.168.1.255."
          error={errors.broadcast}
        />
        <SelectField
          label="Port"
          value={form.port}
          onChange={(e) => set('port', e.target.value === '7' ? '7' : '9')}
          options={[
            { value: '9', label: '9 (Standard)' },
            { value: '7', label: '7' },
          ]}
        />
        <SelectField
          label="Sender"
          value={form.via}
          onChange={(e) => set('via', e.target.value)}
          options={senderOptions(serverId, servers, form.via)}
          hint="Muss im selben Netz wie der Server sein."
        />
      </div>
      {err ? <FormError title={err} /> : null}
      {saved && !save.isPending ? <Alert tone="ok" title="Gespeichert." /> : null}
      <div className="hz-form-actions">
        <Button type="submit" disabled={save.isPending}>
          Speichern
        </Button>
      </div>
    </form>
  );
}

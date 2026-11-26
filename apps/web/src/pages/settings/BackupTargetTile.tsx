import type { BackupTargetSettings } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, ServiceRow, Tile, Toggle } from '@hz/ui';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import {
  backupTargetKey,
  fetchBackupTarget,
  runBackupTarget,
  runLine,
  saveBackupTarget,
  targetLine,
  targetStatus,
} from '../../lib/backup-target.js';
import { useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatDateTime } from '../../lib/format.js';

/**
 * Settings → Backup → "NAS als Backup-Ziel" (ROADMAP M13b). Which servers copy
 * their game backups to the share mounted at /opt/homelab/backup-target, which
 * one receives the nightly database copy, when and how many copies stay.
 */
export function BackupTargetTile(): ReactElement {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: backupTargetKey,
    queryFn: ({ signal }) => fetchBackupTarget(signal),
    refetchInterval: (query) => (query.state.data?.running ? 3000 : 60_000),
  });
  const servers = useServers();
  // Edits; until the first edit the form shows the saved settings.
  const [form, setForm] = useState<BackupTargetSettings | null>(null);

  const save = useMutation({
    mutationFn: (s: BackupTargetSettings) => saveBackupTarget(s),
    onSuccess: (data) => {
      qc.setQueryData(backupTargetKey, data);
      setForm(data.settings);
    },
  });
  const run = useMutation({
    mutationFn: () => runBackupTarget(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: backupTargetKey }),
  });

  const data = q.data;
  const f = form ?? data?.settings ?? null;
  const list = servers.data ?? [];
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (f) save.mutate(f);
  };
  const toggleServer = (id: string, on: boolean) =>
    f &&
    setForm({
      ...f,
      serverIds: on ? [...new Set([...f.serverIds, id])] : f.serverIds.filter((x) => x !== id),
    });
  const saveErr = save.error && !isApiError(save.error, 'step_up_required') ? save.error : null;

  return (
    <Tile
      title="NAS als Backup-Ziel"
      icon="cloud"
      status={data?.settings.enabled ? (data.running ? 'busy' : undefined) : 'off'}
    >
      <p className="app-text">
        Kopiert jede Nacht die Gameserver-Backups und eine Kopie der Datenbank auf eine
        NAS-Freigabe. Die Freigabe wird auf dem Server unter /opt/homelab/backup-target eingebunden
        (Anleitung in deploy/README.md). Ist sie nicht eingebunden, wird nichts geschrieben und du
        bekommst eine Meldung.
      </p>
      {q.error ? <FormError title={errorText(q.error)} /> : null}
      {f ? (
        <form className="hz-form" onSubmit={onSubmit}>
          <Toggle
            label="Nachts aufs NAS kopieren"
            checked={f.enabled}
            onChange={(on) => setForm({ ...f, enabled: on })}
          />
          {list.map((s) => (
            <div key={s.id}>
              <Toggle
                label={`Gameserver-Backups von ${s.name}`}
                hint="Freigabe auf diesem Server eingebunden"
                checked={f.serverIds.includes(s.id)}
                onChange={(on) => toggleServer(s.id, on)}
              />
              <Toggle
                label={`Datenbank-Kopie auf ${s.name}`}
                checked={f.dbServerId === s.id}
                onChange={(on) =>
                  setForm({
                    ...f,
                    dbServerId: on ? s.id : f.dbServerId === s.id ? null : f.dbServerId,
                  })
                }
              />
            </div>
          ))}
          <Field
            label="Uhrzeit"
            mono
            inputMode="numeric"
            placeholder="05:00"
            pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
            hint="Jede Nacht um diese Uhrzeit, Zeit der Zentrale."
            value={f.time}
            onChange={(e) => setForm({ ...f, time: e.target.value })}
            required
          />
          <Field
            label="Kopien behalten"
            type="number"
            min={1}
            max={100}
            value={f.keep}
            hint="Pro Gameserver und für die Datenbank"
            onChange={(e) =>
              setForm({ ...f, keep: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })
            }
          />
          {saveErr ? <FormError title={errorText(saveErr)} /> : null}
          {save.isSuccess ? <Alert tone="ok" title="Gespeichert." /> : null}
          <div className="hz-form-actions">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Speichere …' : 'Speichern'}
            </Button>
          </div>
        </form>
      ) : null}
      {data && (data.servers.length > 0 || data.db.lastRun) ? (
        <div className="app-rows">
          {data.servers.map((s) => (
            <ServiceRow
              key={s.serverId}
              name={s.name}
              host={`${targetLine(s)} · ${runLine(s.lastRun)}`}
              status={targetStatus(s)}
            />
          ))}
          {data.settings.dbServerId ? (
            <ServiceRow
              name="Datenbank"
              host={runLine(data.db.lastRun)}
              status={data.db.lastRun ? (data.db.lastRun.ok ? 'ok' : 'warn') : 'off'}
            />
          ) : null}
        </div>
      ) : null}
      {data?.settings.enabled ? (
        <>
          {run.error ? (
            <FormError
              title={isApiError(run.error, 'busy') ? 'Läuft schon.' : errorText(run.error)}
            />
          ) : null}
          <p className="app-text">
            {data.running
              ? 'Kopiert gerade …'
              : data.nextRunAt
                ? `Nächster Lauf ${formatDateTime(new Date(data.nextRunAt))}`
                : null}
          </p>
          <div className="hz-form-actions">
            <Button
              icon="cloud"
              onClick={() => run.mutate()}
              disabled={data.running || run.isPending}
            >
              Jetzt kopieren
            </Button>
          </div>
        </>
      ) : null}
    </Tile>
  );
}

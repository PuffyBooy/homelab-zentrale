import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button, Tile } from '@hz/ui';
import { CopyBlock } from '../../components/CopyBlock.js';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatDateTime } from '../../lib/format.js';
import { encodeQr, qrPath } from '../../lib/qr.js';
import {
  createWallDevice,
  deleteWallDevice,
  fetchWallDevices,
  wallDevicesKey,
  type WallDevice,
  type WallDeviceCreated,
} from '../../lib/wall.js';

const NAME_RE = /^[\p{L}\p{N} ._-]+$/u;

function shownError(err: unknown): string | null {
  if (!err || isApiError(err, 'step_up_required')) return null;
  return errorText(err);
}

/** Settings → Wandmodus-Geräte (SPEC 12/13): read-only device links for tablets. */
export function WallDevicesTile(): ReactElement {
  const qc = useQueryClient();
  const devices = useQuery({
    queryKey: wallDevicesKey,
    queryFn: ({ signal }) => fetchWallDevices(signal),
  });
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [created, setCreated] = useState<WallDeviceCreated | null>(null);
  const [remove, setRemove] = useState<WallDevice | null>(null);
  const create = useMutation({
    mutationFn: createWallDevice,
    onSuccess: (res) => {
      setCreated(res);
      setName('');
      void qc.invalidateQueries({ queryKey: wallDevicesKey });
    },
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    const n = name.trim();
    if (!n || n.length > 40 || !NAME_RE.test(n)) {
      setNameError('1 bis 40 Zeichen: Buchstaben, Ziffern, Leerzeichen, Punkt, - und _.');
      return;
    }
    setNameError(null);
    create.mutate(n);
  }

  const list = devices.data ?? [];
  return (
    <>
      <Tile title="Wandmodus-Geräte" icon="wifi" count={devices.data ? list.length : undefined}>
        <p className="app-text">
          Ein Tablet an der Wand bekommt einen eigenen Link, der nur den Wandmodus lesen darf. Kein
          Admin-Login auf dem Gerät.
        </p>
        {devices.isError ? <FormError title={errorText(devices.error)} /> : null}
        {list.length ? (
          <div className="app-rows">
            {list.map((d) => (
              <div className="hz-row" key={d.id} data-testid="wall-device">
                <div className="hz-row-main">
                  <span className="hz-row-name">{d.name}</span>
                  <span className="hz-row-sub">
                    seit {formatDateTime(new Date(d.createdAt))} ·{' '}
                    {d.lastSeenAt
                      ? `zuletzt ${formatAgo(new Date(d.lastSeenAt))}`
                      : 'noch nie verbunden'}
                  </span>
                </div>
                <div className="hz-row-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${d.name} widerrufen`}
                    onClick={() => setRemove(d)}
                  >
                    Widerrufen
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : devices.data ? (
          <p className="app-empty">Noch kein Gerät.</p>
        ) : null}
        <form className="hz-form" onSubmit={submit} noValidate>
          <Field
            label="Gerätename"
            value={name}
            maxLength={40}
            placeholder="Tablet Flur"
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            error={nameError}
          />
          {shownError(create.error) ? <FormError title={shownError(create.error) ?? ''} /> : null}
          <div className="hz-form-actions">
            <Button type="submit" icon="plus" disabled={create.isPending}>
              Gerät hinzufügen
            </Button>
          </div>
        </form>
      </Tile>
      {created ? <CreatedDialog created={created} onClose={() => setCreated(null)} /> : null}
      {remove ? <RemoveDialog device={remove} onClose={() => setRemove(null)} /> : null}
    </>
  );
}

function CreatedDialog({
  created,
  onClose,
}: {
  created: WallDeviceCreated;
  onClose: () => void;
}): ReactElement {
  const qr = useMemo(() => {
    try {
      return encodeQr(created.url);
    } catch {
      return null;
    }
  }, [created.url]);
  const box = qr ? qr.size + 8 : 0;
  return (
    <Dialog open onClose={onClose} title={`Link für ${created.device.name}`} dismissable={false}>
      <div className="hz-dialog-body">
        <Alert tone="warn" title="Der Link wird nur jetzt angezeigt.">
          Auf dem Tablet öffnen oder den QR-Code scannen. Wer den Link hat, sieht den Wandmodus,
          sonst nichts. Widerrufen geht jederzeit hier.
        </Alert>
        {qr ? (
          <div className="app-qr" data-theme="light">
            <svg
              className="app-qr-svg"
              viewBox={`0 0 ${box} ${box}`}
              role="img"
              aria-label={`QR-Code für den Link von ${created.device.name}`}
              shapeRendering="crispEdges"
            >
              <rect className="app-qr-light" width={box} height={box} />
              <path className="app-qr-dark" d={qrPath(qr)} />
            </svg>
          </div>
        ) : null}
        <CopyBlock label="Link für das Gerät" text={created.url} inline className="app-wall-url" />
        <div className="hz-dialog-foot">
          <Button variant="primary" onClick={onClose} data-autofocus="">
            Fertig
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RemoveDialog({ device, onClose }: { device: WallDevice; onClose: () => void }) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => deleteWallDevice(device.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: wallDevicesKey });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`${device.name} widerrufen`}>
      <div className="hz-dialog-body">
        <p className="hz-dialog-text">
          Das Gerät zeigt danach „Gerät nicht verbunden.“ und braucht einen neuen Link.
        </p>
        {shownError(del.error) ? <FormError title={shownError(del.error) ?? ''} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose} data-autofocus="">
            Abbrechen
          </Button>
          <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate()}>
            Widerrufen
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

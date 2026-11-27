import type { ContainerDetailsData, ContainerSummary } from '@hz/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Badge, Button, StatusDot } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import {
  containerDetailsKey,
  cpuText,
  dockerErrorText,
  fetchContainerDetails,
  memText,
  mountText,
  portText,
  restartPolicyText,
} from '../../lib/docker.js';
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatTime,
  formatUptimeShort,
} from '../../lib/format.js';
import { useNow } from '../../lib/useNow.js';

/** One sample per call (inspect + stats on the agent); refreshed while the dialog is open. */
const REFRESH_MS = 15_000;

export interface ContainerDetailsDialogProps {
  open: boolean;
  container: ContainerSummary;
  onClose: () => void;
}

/** "Details" of one container (SPEC 6.1b). Env values never reach the browser. */
export function ContainerDetailsDialog({
  open,
  container,
  onClose,
}: ContainerDetailsDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${container.name} · Details`}
      className="app-dialog-wide"
    >
      {open ? <DetailsBody container={container} onClose={onClose} /> : null}
    </Dialog>
  );
}

function DetailsBody({
  container: c,
  onClose,
}: Omit<ContainerDetailsDialogProps, 'open'>): ReactElement {
  const q = useQuery({
    queryKey: containerDetailsKey(c.id),
    queryFn: ({ signal }) => fetchContainerDetails(c.id, signal),
    refetchInterval: REFRESH_MS,
    retry: false,
  });
  return (
    <div className="hz-dialog-body">
      {q.data ? (
        <ContainerDetailsView d={q.data} />
      ) : q.isPending ? (
        <p className="app-line" aria-live="polite">
          <StatusDot status="busy" label="Lade Details vom Agent …" />
        </p>
      ) : null}
      {q.error ? <FormError title={dockerErrorText(q.error)} /> : null}
      <div className="hz-dialog-foot">
        <span className="app-foot-text" aria-live="polite">
          {q.dataUpdatedAt ? `Stand ${formatTime(new Date(q.dataUpdatedAt))}` : ''}
        </span>
        <Button icon="refresh" disabled={q.isFetching} onClick={() => void q.refetch()}>
          {q.isFetching ? 'Lädt …' : 'Aktualisieren'}
        </Button>
        <Button variant="primary" onClick={onClose} data-autofocus="">
          Schließen
        </Button>
      </div>
    </div>
  );
}

function stateLine(
  d: ContainerDetailsData,
  now: Date,
): { status: 'ok' | 'warn' | 'crit' | 'off' | 'busy'; text: string } {
  if (d.state === 'running') {
    const up = d.startedAt
      ? ` · seit ${formatUptimeShort((now.getTime() - new Date(d.startedAt).getTime()) / 1000)}`
      : '';
    if (d.health === 'unhealthy') return { status: 'crit', text: `läuft, unhealthy${up}` };
    if (d.health === 'starting') return { status: 'busy', text: `startet${up}` };
    return { status: 'ok', text: `läuft${up}` };
  }
  if (d.state === 'restarting') return { status: 'warn', text: 'Neustart' };
  if (d.state === 'paused') return { status: 'warn', text: 'pausiert' };
  const exit = d.exitCode == null ? 'gestoppt' : `gestoppt · exit ${d.exitCode}`;
  const when = d.finishedAt ? ` · ${formatDateTime(new Date(d.finishedAt))}` : '';
  return { status: d.exitCode ? 'crit' : 'off', text: `${exit}${when}` };
}

/** The details as a key-value list; exported for the unit tests. */
export function ContainerDetailsView({ d }: { d: ContainerDetailsData }): ReactElement {
  const now = useNow(30_000);
  const st = stateLine(d, now);
  const s = d.stats;
  return (
    <>
      <dl className="app-kv" data-testid="container-details">
        <dt>Status</dt>
        <dd>
          <StatusDot status={st.status} label={st.text} pulse={false} />
        </dd>
        <dt>Image</dt>
        <dd className="app-break">{d.image}</dd>
        <dt>Neustart-Regel</dt>
        <dd>
          {restartPolicyText(d.restartPolicy)}
          {d.restartCount ? ` · ${formatNumber(d.restartCount, 0)} Neustarts` : ''}
        </dd>
        {d.composeProject ? (
          <>
            <dt>Compose</dt>
            <dd>
              {d.composeProject}
              {d.composeService ? ` · ${d.composeService}` : ''}
            </dd>
          </>
        ) : null}
        <dt>Erstellt</dt>
        <dd>{formatDateTime(new Date(d.createdAt))}</dd>
        {d.protected ? (
          <>
            <dt>Schutz</dt>
            <dd>
              <Badge icon="lock">geschützt</Badge>
            </dd>
          </>
        ) : null}
      </dl>

      <h3 className="hz-label app-details-head">Messung</h3>
      {s ? (
        <dl className="app-kv" aria-label="Messung">
          <dt>CPU</dt>
          <dd>{cpuText(s.cpuPercent)}</dd>
          <dt>RAM</dt>
          <dd>{memText(s)}</dd>
          <dt>Netz</dt>
          <dd>
            {formatBytes(s.netRxBytes)} rein · {formatBytes(s.netTxBytes)} raus
          </dd>
          <dt>Disk-IO</dt>
          <dd>
            {formatBytes(s.blockReadBytes)} gelesen · {formatBytes(s.blockWriteBytes)} geschrieben
          </dd>
          <dt>Prozesse</dt>
          <dd>{formatNumber(s.pids, 0)}</dd>
        </dl>
      ) : (
        <p className="app-empty">Keine Messung, der Container läuft nicht.</p>
      )}

      <h3 className="hz-label app-details-head">Ports</h3>
      {d.ports.length ? (
        <ul className="app-details-list" aria-label="Ports">
          {d.ports.map((p) => (
            <li key={`${p.ip ?? ''}:${p.publicPort ?? ''}:${p.privatePort}/${p.protocol}`}>
              {portText(p)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="app-empty">Keine Ports.</p>
      )}

      <h3 className="hz-label app-details-head">Mounts</h3>
      {d.mounts.length ? (
        <ul className="app-details-list" aria-label="Mounts">
          {d.mounts.map((m) => (
            <li key={`${m.source}>${m.destination}`}>
              <span className="app-break">{mountText(m)}</span>{' '}
              <Badge tone={m.rw ? 'neutral' : 'info'}>{m.rw ? 'rw' : 'ro'}</Badge>{' '}
              <span className="app-foot-text">{m.type}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="app-empty">Keine Mounts.</p>
      )}

      <h3 className="hz-label app-details-head">Netzwerke</h3>
      {d.networks.length ? (
        <ul className="app-details-list" aria-label="Netzwerke">
          {d.networks.map((n) => (
            <li key={n.name}>
              {n.name} · {n.ip ?? 'keine IP'}
            </li>
          ))}
        </ul>
      ) : (
        <p className="app-empty">Kein Netzwerk.</p>
      )}

      <h3 className="hz-label app-details-head">Umgebungsvariablen</h3>
      <p className="app-foot-text">Nur die Namen. Werte werden nie angezeigt.</p>
      {d.envKeys.length ? (
        <ul className="app-details-list app-details-env" aria-label="Umgebungsvariablen">
          {d.envKeys.map((k) => (
            <li key={k}>{k}</li>
          ))}
        </ul>
      ) : (
        <p className="app-empty">Keine.</p>
      )}
    </>
  );
}

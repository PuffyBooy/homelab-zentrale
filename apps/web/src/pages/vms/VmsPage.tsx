import type { ProxmoxAction, ProxmoxGuest } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Alert, StatusDot, Tile, UsageBar } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { NotConfigured } from '../../components/NotConfigured.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatBytesOf, formatPercent, plural } from '../../lib/format.js';
import {
  ACTION_LABEL,
  isGuestRunning,
  needsConfirm,
  nodeCpuPct,
  nodeRamPct,
  proxmoxGuestsKey,
  runGuestAction,
  sortGuests,
  useProxmoxView,
  type ProxmoxGuests,
} from '../../lib/proxmox.js';
import { useNow } from '../../lib/useNow.js';
import { GuestActionDialog } from './GuestActionDialog.js';
import { GuestRow } from './GuestRow.js';

export const PROXMOX_SETTINGS_HREF = '/settings#anbindung-proxmox';

type GuestKey = string;
const keyOf = (g: Pick<ProxmoxGuest, 'node' | 'vmid'>): GuestKey => `${g.node}/${g.vmid}`;

interface Pending {
  key: GuestKey;
  action: ProxmoxAction;
}

/**
 * /vms (SPEC 16, module proxmox): Statussatz in the shell header (problems first), the
 * nodes, then all VMs and LXC containers. Polled every 15 s (no live topic).
 */
export function VmsPage(): ReactElement | null {
  const qc = useQueryClient();
  const view = useProxmoxView();
  const settings = view.settings.query;
  const configured = view.settings.configured;
  const guests = view.guests;
  const [confirm, setConfirm] = useState<{ guest: ProxmoxGuest; action: ProxmoxAction } | null>(
    null,
  );
  const [rowError, setRowError] = useState<{ key: GuestKey; text: string } | null>(null);
  const now = useNow(30_000);

  const act = useMutation({
    mutationFn: ({ guest, action }: { guest: ProxmoxGuest; action: ProxmoxAction }) =>
      runGuestAction(guest, action),
    onMutate: () => setRowError(null),
    onSuccess: () => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: proxmoxGuestsKey });
    },
    onError: (err, v) => {
      // Errors of confirmed actions stay in the dialog.
      if (!needsConfirm(v.action) && !isApiError(err, 'step_up_required'))
        setRowError({ key: keyOf(v.guest), text: errorText(err) });
    },
  });

  function onAction(guest: ProxmoxGuest, action: ProxmoxAction): void {
    if (needsConfirm(action)) {
      act.reset();
      setConfirm({ guest, action });
    } else {
      act.mutate({ guest, action });
    }
  }

  const pending: Pending | null =
    act.isPending && act.variables
      ? { key: keyOf(act.variables.guest), action: act.variables.action }
      : null;
  const dialogError =
    act.error && confirm && !isApiError(act.error, 'step_up_required')
      ? errorText(act.error)
      : null;

  if (settings.isError && !settings.data) return <FormError title={errorText(settings.error)} />;
  if (!settings.data) return null;
  if (configured === false) return <VmsNotConfigured />;
  if (guests.isError && !guests.data) return <FormError title={errorText(guests.error)} />;
  if (!guests.data) return null;

  return (
    <>
      <VmsView
        data={guests.data}
        now={now}
        pending={pending}
        rowError={rowError}
        onAction={onAction}
      />
      {confirm && confirm.action !== 'start' ? (
        <GuestActionDialog
          guest={confirm.guest}
          action={confirm.action}
          busy={act.isPending}
          error={dialogError}
          onConfirm={() => act.mutate(confirm)}
          onClose={() => {
            if (!act.isPending) setConfirm(null);
          }}
        />
      ) : null}
    </>
  );
}

export function VmsNotConfigured(): ReactElement {
  return (
    <NotConfigured
      integration="proxmox"
      title="VMs"
      icon="cloud"
      text="Proxmox ist noch nicht eingerichtet. Trag Adresse und API-Token ein, dann erscheinen hier alle VMs und LXC-Container."
    />
  );
}

export interface VmsViewProps {
  data: ProxmoxGuests;
  now: Date;
  pending?: Pending | null;
  rowError?: { key: GuestKey; text: string } | null;
  onAction: (guest: ProxmoxGuest, action: ProxmoxAction) => void;
}

export function VmsView({ data, now, pending, rowError, onAction }: VmsViewProps): ReactElement {
  const list = useMemo(() => sortGuests(data.guests), [data.guests]);
  const real = list.filter((g) => !g.template);
  const running = real.filter(isGuestRunning).length;
  const templates = list.length - real.length;
  const fetched = data.fetchedAt ? new Date(data.fetchedAt) : null;

  return (
    <>
      {data.error ? (
        <div className="app-stack">
          <Alert
            tone="crit"
            title={`Proxmox nicht erreichbar: ${data.error}`}
            action={
              <Link className="hz-btn hz-btn-secondary hz-btn-sm" to={PROXMOX_SETTINGS_HREF}>
                <span>Einstellungen</span>
              </Link>
            }
          >
            {fetched
              ? `Die Liste zeigt den Stand von ${formatAgo(fetched, now)}. Die Zentrale versucht es weiter.`
              : 'Adresse, API-Token und Zertifikat prüfen. Die Zentrale versucht es weiter.'}
          </Alert>
        </div>
      ) : null}
      <div className="hz-grid app-grid">
        {data.nodes.length ? (
          <Tile title="Knoten" icon="server" count={String(data.nodes.length)} span={4}>
            <div className="app-nodes">
              {data.nodes.map((n) => {
                const cpu = nodeCpuPct(n);
                const ram = nodeRamPct(n);
                return (
                  <div className="app-node" key={n.node}>
                    <div className="app-node-head">
                      <span className="hz-row-name">{n.node}</span>
                      <StatusDot
                        status={n.online ? 'ok' : 'crit'}
                        label={n.online ? 'online' : 'offline'}
                      />
                    </div>
                    {n.online ? (
                      <div className="app-bars">
                        <UsageBar
                          label="CPU"
                          value={cpu ?? 0}
                          detail={formatPercent(cpu)}
                          warnAt={85}
                          critAt={95}
                        />
                        <UsageBar
                          label="RAM"
                          value={ram ?? 0}
                          detail={
                            n.memBytes != null && n.maxMemBytes
                              ? `${formatBytesOf(n.memBytes, n.maxMemBytes)} · ${formatPercent(ram)}`
                              : formatPercent(ram)
                          }
                          warnAt={85}
                          critAt={95}
                        />
                      </div>
                    ) : (
                      <p className="app-empty">Knoten antwortet nicht.</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Tile>
        ) : null}
        <Tile
          title="VMs und Container"
          icon="cloud"
          count={`${running} von ${real.length} laufen${templates ? ` · ${plural(templates, 'Vorlage', 'Vorlagen')}` : ''}`}
          span={4}
          flush
          footer={
            <span className="app-foot-text">
              {fetched ? `abgefragt ${formatAgo(fetched, now)} · ` : ''}alle 15 s aktualisiert ·
              Herunterfahren, Stoppen und Neustart brauchen einen Code
            </span>
          }
        >
          {list.length === 0 ? (
            <p className="app-empty app-pad">Keine VMs oder Container auf Proxmox.</p>
          ) : (
            list.map((g) => {
              const k = keyOf(g);
              return (
                <div key={k} className="app-guest" data-testid="guest">
                  <GuestRow
                    guest={g}
                    pending={pending?.key === k ? pending.action : undefined}
                    disabled={pending != null}
                    onAction={(a) => onAction(g, a)}
                  />
                  {rowError?.key === k ? (
                    <div className="app-ctr-error">
                      <Alert
                        tone="crit"
                        title={`${g.name}: ${ACTION_LABEL.start} fehlgeschlagen. ${rowError.text}`}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </Tile>
      </div>
    </>
  );
}

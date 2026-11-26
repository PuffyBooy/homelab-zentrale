import type { ProxmoxAction, ProxmoxGuest } from '@hz/shared';
import type { ReactElement } from 'react';
import { Badge, Button, ServiceRow, UsageBar } from '@hz/ui';
import { formatUptimeShort } from '../../lib/format.js';
import {
  ACTION_PENDING,
  TYPE_LABEL,
  guestCpuText,
  guestRamPct,
  guestRamText,
  guestStatus,
  guestStatusText,
} from '../../lib/proxmox.js';

export interface GuestRowProps {
  guest: ProxmoxGuest;
  /** Action running for this guest. */
  pending?: ProxmoxAction | undefined;
  /** Another action is running somewhere, or the list is stale. */
  disabled?: boolean | undefined;
  onAction: (action: ProxmoxAction) => void;
}

/**
 * One VM or LXC as ServiceRow: status with shape and text, name, VMID · type · node,
 * CPU, RAM as UsageBar, uptime. Ghost buttons with aria-label. Templates get the badge
 * "Vorlage" and no buttons (they cannot be started).
 */
export function GuestRow({ guest: g, pending, disabled, onAction }: GuestRowProps): ReactElement {
  const running = g.status === 'running';
  const ramPct = guestRamPct(g);
  const off = disabled || pending !== undefined;

  const btn = (
    action: ProxmoxAction,
    icon: 'play' | 'power' | 'stop' | 'refresh',
    verb: string,
  ) => (
    <Button
      size="sm"
      variant="ghost"
      icon={icon}
      aria-label={`${g.name} ${verb}`}
      title={verb.charAt(0).toUpperCase() + verb.slice(1)}
      disabled={off}
      onClick={() => onAction(action)}
    />
  );

  let actions: ReactElement | undefined;
  if (!g.template) {
    if (running) {
      actions = (
        <>
          {btn('shutdown', 'power', 'herunterfahren')}
          {btn('reboot', 'refresh', 'neu starten')}
          {btn('stop', 'stop', 'stoppen')}
        </>
      );
    } else if (g.status === 'paused') {
      actions = btn('stop', 'stop', 'stoppen');
    } else if (g.status === 'stopped') {
      actions = btn('start', 'play', 'starten');
    }
  }

  return (
    <ServiceRow
      name={g.name || `VM ${g.vmid}`}
      host={`${g.vmid} · ${TYPE_LABEL[g.type]} · ${g.node}`}
      status={pending ? 'busy' : guestStatus(g)}
      meta={
        <span className="app-guest-meta">
          {pending ? (
            <span>{ACTION_PENDING[pending]}</span>
          ) : g.template ? (
            <Badge>Vorlage</Badge>
          ) : (
            <span className="app-guest-state">{guestStatusText(g)}</span>
          )}
          {/* Same cells in every row, so the columns line up. */}
          <span className="app-guest-cpu" title="CPU">
            {running ? `CPU ${guestCpuText(g)}` : ''}
          </span>
          <span className="app-guest-ram">
            {running ? (
              <UsageBar
                label="RAM"
                cells={10}
                value={ramPct ?? 0}
                detail={guestRamText(g)}
                warnAt={85}
                critAt={95}
              />
            ) : null}
          </span>
          <span className="app-guest-up" title="Laufzeit">
            {running ? formatUptimeShort(g.uptimeS) : ''}
          </span>
        </span>
      }
      actions={<span className="app-guest-actions">{actions}</span>}
    />
  );
}

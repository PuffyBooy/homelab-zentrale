import type { ContainerSummary } from '@hz/shared';
import { useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, Button, ServiceRow } from '@hz/ui';
import { ACTION_PENDING, containerMeta, containerSub, isRunning } from '../../lib/containers.js';
import { removeBlocked, shellAllowed, shellHref } from '../../lib/docker.js';
import { errorText } from '../../lib/errors.js';
import { ThrottleBadge } from '../throttle/ThrottleBadge.js';
import { ContainerDetailsDialog } from './ContainerDetailsDialog.js';
import { RemoveContainerDialog } from './RemoveContainerDialog.js';
import { UpdateDialog } from './UpdateDialog.js';
import { useContainerAction } from './useContainerAction.js';

export interface ContainerRowProps {
  c: ContainerSummary;
  now: Date;
  /** Show the server instead of the image in the second line (overview). */
  withServer?: boolean;
  /** Row without buttons (overview tile). */
  readOnly?: boolean;
  /** The agent is offline: actions are disabled. */
  offline?: boolean;
  /** The server allows the web console (allowTerminal): offers "Shell" for running containers. */
  terminal?: boolean;
}

/**
 * One container as ServiceRow (SPEC 6.1): status with shape and text, name, image and
 * ports, uptime or exit code, CPU/RAM. Ghost buttons with aria-label (design README,
 * Iconografie): Logs, Start or Stop, Neu starten, Image aktualisieren. M23 (SPEC 6.1b):
 * Details, Shell (console with this container as target) and Entfernen (stopped only).
 */
export function ContainerRow({
  c,
  now,
  withServer,
  readOnly,
  offline,
  terminal,
}: ContainerRowProps): ReactElement {
  const navigate = useNavigate();
  const action = useContainerAction(c);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const running = isRunning(c);
  const pending = action.isPending ? action.variables : undefined;
  const busy = pending !== undefined;
  const disabled = busy || offline;
  const shell = shellAllowed(c, { allowTerminal: !!terminal, connected: !offline });
  const removable = removeBlocked(c) === null;

  const actions = readOnly ? undefined : (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon="terminal"
        aria-label={`Logs von ${c.name}`}
        title="Logs"
        onClick={() => void navigate(`/containers/${c.id}/logs`)}
      />
      {running ? (
        <Button
          size="sm"
          variant="ghost"
          icon="stop"
          aria-label={`${c.name} stoppen`}
          title="Stoppen"
          disabled={disabled}
          onClick={() => action.mutate('stop')}
        />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          icon="play"
          aria-label={`${c.name} starten`}
          title="Starten"
          disabled={disabled}
          onClick={() => action.mutate('start')}
        />
      )}
      <Button
        size="sm"
        variant="ghost"
        icon="refresh"
        aria-label={`${c.name} neu starten`}
        title="Neu starten"
        disabled={disabled || !running}
        onClick={() => action.mutate('restart')}
      />
      <Button
        size="sm"
        variant="ghost"
        icon="cloud"
        aria-label={`Image von ${c.name} aktualisieren`}
        title="Image aktualisieren"
        disabled={disabled}
        onClick={() => setUpdateOpen(true)}
      />
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Details von ${c.name}`}
        disabled={offline}
        onClick={() => setDetailsOpen(true)}
      >
        Details
      </Button>
      {shell ? (
        <Link
          className="hz-btn hz-btn-ghost hz-btn-sm"
          to={shellHref(c)}
          aria-label={`Shell in ${c.name}`}
        >
          Shell
        </Link>
      ) : null}
      {removable ? (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${c.name} entfernen`}
          disabled={disabled}
          onClick={() => setRemoveOpen(true)}
        >
          Entfernen
        </Button>
      ) : null}
    </>
  );

  return (
    <>
      <ServiceRow
        name={c.name}
        host={containerSub(c, withServer)}
        status={busy ? 'busy' : c.status}
        meta={
          busy ? (
            ACTION_PENDING[pending]
          ) : c.throttled || c.autoStopped ? (
            <>
              <ThrottleBadge throttled={c.throttled} autoStopped={c.autoStopped} />{' '}
              {containerMeta(c, now, !readOnly)}
            </>
          ) : (
            containerMeta(c, now, !readOnly)
          )
        }
        actions={actions}
      />
      {action.error ? (
        <div className="app-ctr-error">
          <Alert tone="crit" title={`${c.name}: ${errorText(action.error)}`} />
        </div>
      ) : null}
      {readOnly ? null : (
        <>
          <UpdateDialog open={updateOpen} container={c} onClose={() => setUpdateOpen(false)} />
          <ContainerDetailsDialog
            open={detailsOpen}
            container={c}
            onClose={() => setDetailsOpen(false)}
          />
          {removeOpen ? (
            <RemoveContainerDialog container={c} onClose={() => setRemoveOpen(false)} />
          ) : null}
        </>
      )}
    </>
  );
}

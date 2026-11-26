import type { ContainerSummary } from '@hz/shared';
import type { ReactElement } from 'react';
import { Alert, Button, StatusDot } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { useContainerAction } from './useContainerAction.js';

export interface UpdateDialogProps {
  open: boolean;
  container: ContainerSummary;
  onClose: () => void;
}

/**
 * "Image aktualisieren" (SPEC 6.1): confirm first, then pull + recreate. Compose projects
 * below /opt/homelab go through `docker compose pull && up -d`, the rest is recreated
 * with the same config. The core picks the agent action; the dialog only explains it.
 */
export function UpdateDialog({ open, container, onClose }: UpdateDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${container.name} aktualisieren`}
      dismissable={false}
    >
      <UpdateBody container={container} onClose={onClose} />
    </Dialog>
  );
}

function UpdateBody({ container: c, onClose }: Omit<UpdateDialogProps, 'open'>): ReactElement {
  const run = useContainerAction(c);
  const compose = c.composeManaged && c.composeProject;

  if (run.isSuccess) {
    const image = run.data.container?.image ?? c.image;
    return (
      <div className="hz-dialog-body">
        <Alert tone="ok" title={`${c.name} läuft mit dem neuen Image.`}>
          {image}
        </Alert>
        <div className="hz-dialog-foot">
          <Button variant="primary" onClick={onClose} data-autofocus="">
            Fertig
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="hz-dialog-body">
      <p className="hz-dialog-text">
        {compose
          ? `Zieht die neuen Images für das Compose-Projekt ${c.composeProject} und startet geänderte Container neu (docker compose pull && up -d).`
          : `Zieht ${c.image} neu und erstellt ${c.name} mit derselben Konfiguration neu.`}{' '}
        {c.name} ist dabei kurz nicht erreichbar.
      </p>
      <dl className="app-kv">
        <dt>Server</dt>
        <dd>{c.serverName}</dd>
        <dt>Image</dt>
        <dd>{c.image}</dd>
        {c.composeProject ? (
          <>
            <dt>Compose</dt>
            <dd>{c.composeProject}</dd>
          </>
        ) : null}
      </dl>
      <div className="app-line" aria-live="polite">
        {run.isPending ? (
          <StatusDot
            status="busy"
            label={compose ? 'Pull und Neustart laufen …' : 'Pull und Neuaufbau laufen …'}
          />
        ) : null}
      </div>
      {run.error ? <FormError title={errorText(run.error)} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose} disabled={run.isPending}>
          Abbrechen
        </Button>
        <Button
          variant="primary"
          icon="cloud"
          disabled={run.isPending}
          onClick={() => run.mutate('update')}
        >
          Image aktualisieren
        </Button>
      </div>
    </div>
  );
}

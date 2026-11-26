import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { shutdownServer } from '../../lib/serverAdmin.js';
import type { ServerActionDialogProps } from './CleanupDialog.js';

/**
 * SPEC 5.5: Herunterfahren, danger like Neustart. Confirmed by typing the server name;
 * step-up comes from lib/api (the code dialog appears and the request repeats).
 */
export function ShutdownDialog(props: ServerActionDialogProps): ReactElement {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={`${props.serverName} herunterfahren`}
      dismissable={false}
    >
      <ShutdownBody {...props} />
    </Dialog>
  );
}

export function ShutdownBody({
  serverId,
  serverName,
  onClose,
}: ServerActionDialogProps): ReactElement {
  const [typed, setTyped] = useState('');
  const shutdown = useMutation({ mutationFn: () => shutdownServer(serverId, serverName) });
  const match = typed.trim() === serverName;

  if (shutdown.isSuccess) {
    return (
      <div className="hz-dialog-body">
        <Alert tone="info" title={`${serverName} fährt herunter.`}>
          Er bleibt aus, bis ihn jemand einschaltet oder per Wake-on-LAN weckt.
        </Alert>
        <div className="hz-dialog-foot">
          <Button variant="primary" onClick={onClose} data-autofocus="">
            Fertig
          </Button>
        </div>
      </div>
    );
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (match) shutdown.mutate();
  }

  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <p className="hz-dialog-text">
        {serverName} bleibt danach aus, bis ihn jemand einschaltet oder per Wake-on-LAN weckt. Alle
        Container und Gameserver darauf sind so lange weg. Zum Bestätigen den Servernamen eintippen.
      </p>
      <Field
        label="Servername"
        mono
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={serverName}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        data-autofocus=""
      />
      {shutdown.error ? <FormError title={errorText(shutdown.error)} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="danger" type="submit" icon="power" disabled={!match || shutdown.isPending}>
          Herunterfahren
        </Button>
      </div>
    </form>
  );
}

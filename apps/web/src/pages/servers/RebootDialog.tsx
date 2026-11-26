import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactElement } from 'react';
import { Alert, Button } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { Field } from '../../components/Field.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { rebootServer } from '../../lib/servers.js';
import type { ServerActionDialogProps } from './CleanupDialog.js';

/** SPEC 5.2: Danger, confirmed by typing the server name. Step-up comes from lib/api. */
export function RebootDialog(props: ServerActionDialogProps): ReactElement {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={`${props.serverName} neu starten`}
      dismissable={false}
    >
      <RebootBody {...props} />
    </Dialog>
  );
}

function RebootBody({ serverId, serverName, onClose }: ServerActionDialogProps): ReactElement {
  const [typed, setTyped] = useState('');
  const reboot = useMutation({ mutationFn: () => rebootServer(serverId, serverName) });
  const match = typed.trim() === serverName;

  if (reboot.isSuccess) {
    return (
      <div className="hz-dialog-body">
        <Alert tone="info" title={`Neustart von ${serverName} ausgelöst.`}>
          Der Server ist gleich kurz offline und meldet sich danach wieder.
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
    if (match) reboot.mutate();
  }

  return (
    <form className="hz-dialog-body" onSubmit={submit} noValidate>
      <p className="hz-dialog-text">
        Alle Container und Gameserver auf {serverName} sind während des Neustarts weg. Zum
        Bestätigen den Servernamen eintippen.
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
      {reboot.error ? <FormError title={errorText(reboot.error)} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        <Button variant="danger" type="submit" icon="power" disabled={!match || reboot.isPending}>
          Neustart
        </Button>
      </div>
    </form>
  );
}

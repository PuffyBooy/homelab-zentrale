import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactElement } from 'react';
import { Alert, Button } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes } from '../../lib/format.js';
import { CLEANUP_LABEL, cleanupPreview, runCleanup, serverKey } from '../../lib/servers.js';

export interface ServerActionDialogProps {
  open: boolean;
  serverId: string;
  serverName: string;
  onClose: () => void;
}

/** SPEC 5.2: preview first (GB per item and total), then clean up. */
export function CleanupDialog(props: ServerActionDialogProps): ReactElement {
  return (
    <Dialog open={props.open} onClose={props.onClose} title={`${props.serverName} aufräumen`}>
      <CleanupBody {...props} />
    </Dialog>
  );
}

function CleanupBody({ serverId, serverName, onClose }: ServerActionDialogProps): ReactElement {
  const qc = useQueryClient();
  const preview = useMutation({ mutationFn: () => cleanupPreview(serverId) });
  const run = useMutation({
    mutationFn: () => runCleanup(serverId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: serverKey(serverId) }),
  });
  const { mutate: loadPreview } = preview;

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  if (run.data) {
    return (
      <div className="hz-dialog-body">
        <Alert tone="ok" title={`${formatBytes(run.data.freedBytes)} frei auf ${serverName}.`} />
        <div className="hz-dialog-foot">
          <Button variant="primary" onClick={onClose} data-autofocus="">
            Fertig
          </Button>
        </div>
      </div>
    );
  }

  const data = preview.data;
  const nothing = data != null && data.totalBytes <= 0;
  return (
    <div className="hz-dialog-body">
      {preview.isPending ? (
        <p className="hz-dialog-text" aria-live="polite">
          Vorschau läuft. {serverName} prüft apt-Cache, alte Kernel, Journal und Docker-Images …
        </p>
      ) : null}
      {preview.error ? <FormError title={errorText(preview.error)} /> : null}
      {data ? (
        <table className="app-table" aria-label="Was frei wird">
          <tbody>
            {data.items.map((it) => (
              <tr key={it.kind}>
                <th scope="row">
                  {CLEANUP_LABEL[it.kind]}
                  {it.detail ? <small>{it.detail}</small> : null}
                </th>
                <td>{formatBytes(it.bytes)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Summe</th>
              <td>{formatBytes(data.totalBytes)}</td>
            </tr>
          </tfoot>
        </table>
      ) : null}
      {nothing ? <p className="hz-dialog-text">Nichts zum Aufräumen.</p> : null}
      {run.error ? <FormError title={errorText(run.error)} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        {preview.error ? <Button onClick={() => preview.mutate()}>Erneut prüfen</Button> : null}
        <Button
          variant="primary"
          disabled={!data || nothing || run.isPending}
          onClick={() => run.mutate()}
        >
          Aufräumen
        </Button>
      </div>
    </div>
  );
}

import type { CleanupKind, CleanupPreviewData } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Button, Toggle } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes } from '../../lib/format.js';
import {
  dockerDfKey,
  runCleanupItems,
  selectedBytes,
  selectedKinds,
} from '../../lib/serverAdmin.js';
import { CLEANUP_LABEL, cleanupPreview, serverKey } from '../../lib/servers.js';

export interface ServerActionDialogProps {
  open: boolean;
  serverId: string;
  serverName: string;
  onClose: () => void;
}

/**
 * SPEC 5.2/5.5: preview first (GB per item and total), every item can be switched off
 * (all on at the start), then clean up only the chosen ones.
 */
export function CleanupDialog(props: ServerActionDialogProps): ReactElement {
  return (
    <Dialog open={props.open} onClose={props.onClose} title={`${props.serverName} aufräumen`}>
      <CleanupBody {...props} />
    </Dialog>
  );
}

function CleanupBody({ serverId, serverName, onClose }: ServerActionDialogProps): ReactElement {
  const qc = useQueryClient();
  // Items switched off; everything else from the preview is cleaned.
  const [off, setOff] = useState<ReadonlySet<CleanupKind>>(new Set());
  const preview = useMutation({ mutationFn: () => cleanupPreview(serverId) });
  const run = useMutation({
    mutationFn: (items: CleanupKind[]) => runCleanupItems(serverId, items),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: serverKey(serverId), exact: true });
      void qc.invalidateQueries({ queryKey: dockerDfKey(serverId) });
    },
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
  const selected = new Set((data?.items ?? []).map((it) => it.kind).filter((k) => !off.has(k)));
  const items = data ? selectedKinds(data.items, selected) : [];
  const nothing = data != null && data.totalBytes <= 0;
  return (
    <div className="hz-dialog-body">
      {preview.isPending ? (
        <p className="hz-dialog-text" aria-live="polite">
          Vorschau läuft. {serverName} prüft apt-Cache, alte Kernel, Journal, Docker-Images und
          Build-Cache …
        </p>
      ) : null}
      {preview.error ? <FormError title={errorText(preview.error)} /> : null}
      {data ? (
        <CleanupChoice
          data={data}
          selected={selected}
          onToggle={(kind, on) =>
            setOff((prev) => {
              const next = new Set(prev);
              if (on) next.delete(kind);
              else next.add(kind);
              return next;
            })
          }
        />
      ) : null}
      {nothing ? <p className="hz-dialog-text">Nichts zum Aufräumen.</p> : null}
      {run.error ? <FormError title={errorText(run.error)} /> : null}
      <div className="hz-dialog-foot">
        <Button onClick={onClose}>Abbrechen</Button>
        {preview.error ? <Button onClick={() => preview.mutate()}>Erneut prüfen</Button> : null}
        <Button
          variant="primary"
          disabled={!data || nothing || items.length === 0 || run.isPending}
          onClick={() => run.mutate(items)}
        >
          Aufräumen
        </Button>
      </div>
    </div>
  );
}

/** One switch per item with its size, the sum of the chosen ones below. */
export function CleanupChoice({
  data,
  selected,
  onToggle,
}: {
  data: CleanupPreviewData;
  selected: ReadonlySet<CleanupKind>;
  onToggle: (kind: CleanupKind, on: boolean) => void;
}): ReactElement {
  return (
    <>
      <table className="app-table app-cleanup" aria-label="Was frei wird">
        <tbody>
          {data.items.map((it) => (
            <tr key={it.kind}>
              <th scope="row">
                <Toggle
                  label={CLEANUP_LABEL[it.kind]}
                  hint={it.detail}
                  checked={selected.has(it.kind)}
                  onChange={(on) => onToggle(it.kind, on)}
                />
              </th>
              <td>{formatBytes(it.bytes)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Summe der Auswahl</th>
            <td>{formatBytes(selectedBytes(data.items, selected))}</td>
          </tr>
        </tfoot>
      </table>
      <p className="hz-dialog-text">Container und Volumes bleiben immer.</p>
    </>
  );
}

import type { ContainerSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { NameConfirmDialog } from '../../components/NameConfirmDialog.js';
import { containersKey } from '../../lib/containers.js';
import { dockerErrorText, removeContainer } from '../../lib/docker.js';

export interface RemoveContainerDialogProps {
  container: ContainerSummary;
  onClose: () => void;
}

/**
 * "Entfernen" of a stopped container (SPEC 6.1b): type the name, step-up from lib/api.
 * Anonymous volumes only on request; named volumes always stay.
 */
export function RemoveContainerDialog({
  container: c,
  onClose,
}: RemoveContainerDialogProps): ReactElement {
  const qc = useQueryClient();
  const [withVolumes, setWithVolumes] = useState(false);
  const run = useMutation({
    mutationFn: () => removeContainer(c.id, c.name, withVolumes),
    onSuccess: () => {
      qc.setQueryData<ContainerSummary[]>(containersKey, (old) =>
        old ? old.filter((x) => x.id !== c.id) : old,
      );
      void qc.invalidateQueries({ queryKey: containersKey });
    },
  });
  return (
    <NameConfirmDialog
      title={`${c.name} entfernen`}
      name={c.name}
      label="Containername"
      action="Entfernen"
      busy={run.isPending}
      error={run.error}
      errorTextOf={dockerErrorText}
      done={run.isSuccess ? `${c.name} ist entfernt.` : null}
      onConfirm={() => run.mutate()}
      onClose={onClose}
      extra={
        <label className="app-check app-check-line">
          <input
            type="checkbox"
            checked={withVolumes}
            disabled={run.isPending}
            onChange={(e) => setWithVolumes(e.target.checked)}
          />
          <span>Anonyme Volumes mitlöschen</span>
        </label>
      }
    >
      Entfernt den gestoppten Container {c.name} auf {c.serverName} (docker rm). Benannte Volumes
      bleiben immer erhalten. Zum Bestätigen den Containernamen eintippen, danach fragt die Zentrale
      nach dem Code aus der App.
    </NameConfirmDialog>
  );
}

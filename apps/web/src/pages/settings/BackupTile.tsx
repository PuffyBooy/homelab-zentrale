import { useMutation } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Alert, Button, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes } from '../../lib/format.js';
import { exportDatabase } from '../../lib/settings.js';

/** Settings → Backup der Zentrale (SPEC 13): SQLite snapshot as a download, step-up. */
export function BackupTile(): ReactElement {
  const run = useMutation({ mutationFn: () => exportDatabase() });
  const err = run.error && !isApiError(run.error, 'step_up_required') ? run.error : null;
  return (
    <Tile title="Backup der Zentrale" icon="cloud">
      <p className="app-text">
        Lädt die ganze Datenbank als SQLite-Datei herunter. Tokens und Passwörter darin bleiben
        verschlüsselt und lassen sich nur mit HZ_SECRET_KEY lesen. Den Schlüssel getrennt
        aufbewahren.
      </p>
      {err ? <FormError title={errorText(err)} /> : null}
      {run.isSuccess ? (
        <Alert tone="ok" title={`${run.data.name} heruntergeladen.`}>
          {formatBytes(run.data.bytes)}
        </Alert>
      ) : null}
      <div className="hz-form-actions">
        <Button icon="cloud" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? 'Exportiere …' : 'Backup jetzt'}
        </Button>
      </div>
    </Tile>
  );
}

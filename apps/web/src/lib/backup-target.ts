import {
  backupTargetResponseSchema,
  backupTargetRunStartedSchema,
  type BackupTargetError,
  type BackupTargetResponse,
  type BackupTargetRun,
  type BackupTargetServer,
  type BackupTargetSettings,
} from '@hz/shared';
import type { Status } from '@hz/ui';
import { api } from './api.js';
import { formatBytes, formatDateTime, plural } from './format.js';

/** M13b NAS als Backup-Ziel: GET/PUT /api/storage/backup-target, POST .../run. */
export const backupTargetKey = ['storage', 'backup-target'] as const;

export function fetchBackupTarget(signal?: AbortSignal): Promise<BackupTargetResponse> {
  return api('/api/storage/backup-target', { schema: backupTargetResponseSchema, signal });
}

export function saveBackupTarget(body: BackupTargetSettings): Promise<BackupTargetResponse> {
  return api('/api/storage/backup-target', {
    method: 'PUT',
    body,
    schema: backupTargetResponseSchema,
  });
}

export function runBackupTarget(): Promise<{ started: true }> {
  return api('/api/storage/backup-target/run', {
    method: 'POST',
    schema: backupTargetRunStartedSchema,
  });
}

export const BACKUP_TARGET_ERROR_TEXT: Record<BackupTargetError, string> = {
  not_mounted: 'Freigabe nicht eingebunden',
  read_only: 'Freigabe schreibgeschützt',
  offline: 'Server offline',
  no_space: 'NAS voll',
  failed: 'Kopieren fehlgeschlagen',
};

/** Status of one target server from the last answer and run (StatusDot adds the text). */
export function targetStatus(s: BackupTargetServer): Status {
  if (!s.online) return 'off';
  const st = s.status?.state;
  if (st && st !== 'mounted') return 'warn';
  if (s.lastRun && !s.lastRun.ok) return 'warn';
  if (st === 'mounted') return 'ok';
  return 'off';
}

/** "Eingebunden (cifs) · 412 GB frei" / "Nicht eingebunden". */
export function targetLine(s: BackupTargetServer): string {
  const st = s.status;
  if (!s.online && !st) return 'Server offline';
  if (!st) return 'Noch nicht geprüft';
  if (st.state === 'missing') return 'Ordner /opt/homelab/backup-target fehlt';
  if (st.state === 'not_mounted') return 'Freigabe nicht eingebunden';
  if (st.state === 'read_only') return 'Freigabe nur lesbar eingebunden';
  const copies = st.games.reduce((n, g) => n + g.files, 0) + st.core.files;
  return [
    `Eingebunden${st.fs ? ` (${st.fs})` : ''}`,
    st.freeBytes !== null ? `${formatBytes(st.freeBytes)} frei` : null,
    plural(copies, 'Kopie', 'Kopien'),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "Zuletzt 27.11.2026 05:00: 3 Kopien, 2,1 GB" or the error. */
export function runLine(run: BackupTargetRun | null): string {
  if (!run) return 'Noch kein Lauf';
  const when = formatDateTime(new Date(run.at));
  if (!run.ok) return `Zuletzt ${when}: ${BACKUP_TARGET_ERROR_TEXT[run.error ?? 'failed']}`;
  if (run.copied === 0) return `Zuletzt ${when}: alles schon kopiert`;
  return `Zuletzt ${when}: ${plural(run.copied, 'neue Kopie', 'neue Kopien')}, ${formatBytes(run.bytes)}`;
}

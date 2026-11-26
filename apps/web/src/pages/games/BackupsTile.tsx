import type { GameSummary } from '@hz/shared';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Button, StatusDot, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes, formatWhen } from '../../lib/format.js';
import { restoreProgress } from '../../lib/gameFeatures.js';
import {
  backupsKey,
  fetchBackups,
  gameEventsKey,
  type GameBackup,
  type GameEventBuffer,
} from '../../lib/games.js';
import { RestoreDialog } from './RestoreDialog.js';
import { gameErrorText, useGameAction } from './useGameAction.js';

/**
 * Backups (SPEC 6.3): world folder as tar.zst in /opt/homelab/backups/, the last 7 stay.
 * M12: "Wiederherstellen" per backup (name + step-up), progress from topic game:<id>.
 */
export function BackupsTile({ game, now }: { game: GameSummary; now: Date }): ReactElement {
  const backups = useQuery({
    queryKey: backupsKey(game.id),
    queryFn: ({ signal }) => fetchBackups(game.id, signal),
  });
  const events = useQuery<GameEventBuffer>({
    queryKey: gameEventsKey(game.id),
    queryFn: skipToken,
  });
  const act = useGameAction();
  const [restoring, setRestoring] = useState<GameBackup | null>(null);
  /** Last event id when the dialog opened: only later events belong to the restore. */
  const [mark, setMark] = useState<string | null>(null);
  const [started, setStarted] = useState<{ after: string | null } | null>(null);
  const list = backups.data ?? [];
  const progress = started ? restoreProgress(events.data?.events ?? [], started.after) : null;
  const qc = useQueryClient();
  const finished = progress && progress.state !== 'running' ? progress.state : null;
  // The core took a fresh backup first: reload the list once the restore is through.
  useEffect(() => {
    if (finished) void qc.invalidateQueries({ queryKey: backupsKey(game.id) });
  }, [finished, qc, game.id]);
  const busy = act.isPending || game.status === 'busy' || progress?.state === 'running';

  return (
    <Tile
      title="Backups"
      icon="cloud"
      count={backups.data ? String(list.length) : undefined}
      span={2}
      flush
      actions={
        <Button
          size="sm"
          disabled={busy}
          onClick={() => act.mutate({ id: game.id, action: 'backup' })}
        >
          {act.isPending ? 'Backup läuft …' : 'Backup jetzt'}
        </Button>
      }
      footer={
        <span className="app-foot-text">
          /opt/homelab/backups/ · die letzten 7 bleiben · vor dem Löschen und Wiederherstellen
          automatisch
        </span>
      }
    >
      {act.error ? (
        <div className="app-pad">
          <FormError title={gameErrorText(act.error)} />
        </div>
      ) : null}
      {progress ? (
        <div className="app-pad" aria-live="polite">
          {progress.state === 'running' ? (
            <p className="app-text">
              <StatusDot status="busy" label="Stellt wieder her" />{' '}
              {progress.text ?? 'Warte auf den Agent …'}
            </p>
          ) : progress.state === 'ready' ? (
            <Alert tone="ok" title="Backup wiederhergestellt.">
              {progress.text ?? `${game.name} hat wieder die Welt aus dem Backup.`}
            </Alert>
          ) : (
            <Alert tone="crit" title="Wiederherstellen fehlgeschlagen.">
              {progress.text ?? 'Grund im Log der Konsole.'}
            </Alert>
          )}
        </div>
      ) : null}
      {backups.error && !backups.data ? (
        <div className="app-pad">
          <FormError title={errorText(backups.error)} />
        </div>
      ) : null}
      {backups.data && list.length === 0 ? (
        <p className="app-empty app-pad">Noch kein Backup.</p>
      ) : null}
      {list.map((b) => (
        <div key={b.id} className="hz-row" data-testid="backup-row">
          <div className="hz-row-main">
            <span className="hz-row-name app-break">{b.fileName}</span>
            <span className="hz-row-sub">
              {formatWhen(new Date(b.createdAt), now)} · {formatBytes(b.sizeBytes)}
            </span>
          </div>
          <div className="hz-row-actions">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Backup von ${formatWhen(new Date(b.createdAt), now)} wiederherstellen`}
              onClick={() => {
                const ev = events.data?.events ?? [];
                setMark(ev[ev.length - 1]?.id ?? null);
                setRestoring(b);
              }}
            >
              Wiederherstellen
            </Button>
          </div>
        </div>
      ))}
      {restoring ? (
        <RestoreDialog
          game={game}
          backup={restoring}
          now={now}
          onStarted={() => setStarted({ after: mark })}
          onClose={() => setRestoring(null)}
        />
      ) : null}
    </Tile>
  );
}

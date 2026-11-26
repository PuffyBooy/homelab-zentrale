import type { GameSummary } from '@hz/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Button, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatBytes, formatWhen } from '../../lib/format.js';
import { backupsKey, fetchBackups } from '../../lib/games.js';
import { gameErrorText, useGameAction } from './useGameAction.js';

/** Backups (SPEC 6.3): world folder as tar.zst in /opt/homelab/backups/, the last 7 stay. */
export function BackupsTile({ game, now }: { game: GameSummary; now: Date }): ReactElement {
  const backups = useQuery({
    queryKey: backupsKey(game.id),
    queryFn: ({ signal }) => fetchBackups(game.id, signal),
  });
  const act = useGameAction();
  const list = backups.data ?? [];

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
          disabled={act.isPending || game.status === 'busy'}
          onClick={() => act.mutate({ id: game.id, action: 'backup' })}
        >
          {act.isPending ? 'Backup läuft …' : 'Backup jetzt'}
        </Button>
      }
      footer={
        <span className="app-foot-text">
          /opt/homelab/backups/ · die letzten 7 bleiben · vor dem Löschen automatisch
        </span>
      }
    >
      {act.error ? (
        <div className="app-pad">
          <FormError title={gameErrorText(act.error)} />
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
        <div key={b.id} className="hz-row">
          <div className="hz-row-main">
            <span className="hz-row-name app-break">{b.fileName}</span>
            <span className="hz-row-sub">{formatWhen(new Date(b.createdAt), now)}</span>
          </div>
          <div className="hz-row-meta">{formatBytes(b.sizeBytes)}</div>
        </div>
      ))}
    </Tile>
  );
}

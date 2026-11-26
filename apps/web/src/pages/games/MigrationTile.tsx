import type { GameSummary, Migration } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Alert, Button, StatusDot, Tile, UsageBar } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatWhen } from '../../lib/format.js';
import { gamesKey, portLabel } from '../../lib/games.js';
import {
  MIGRATION_POLL_MS,
  PHASE_LABEL,
  STEP_STATUS,
  cancelMigration,
  canCancelMigration,
  fetchMigration,
  isMigrationActive,
  migrationKey,
  migrationSentence,
  migrationStatus,
  progressPercent,
  progressText,
  showMigration,
  stepStates,
} from '../../lib/migrate.js';

/** Latest migration of the game, polled while it runs. */
export function useMigration(gameId: string) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: migrationKey(gameId),
    queryFn: ({ signal }) => fetchMigration(gameId, signal),
    refetchInterval: (query) => (isMigrationActive(query.state.data) ? MIGRATION_POLL_MS : false),
  });
  // When it ends, the game record points to the new server (or stays): reload the list.
  const active = isMigrationActive(q.data);
  const was = useRef(active);
  useEffect(() => {
    if (was.current && !active) void qc.invalidateQueries({ queryKey: gamesKey });
    was.current = active;
  }, [active, qc]);
  return q;
}

/** Progress of a running (or just finished) migration; nothing when there is none. */
export function MigrationTile({
  game,
  now,
}: {
  game: GameSummary;
  now: Date;
}): ReactElement | null {
  const m = useMigration(game.id);
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => cancelMigration(game.id),
    onSuccess: (next) => qc.setQueryData(migrationKey(game.id), next),
  });
  if (!showMigration(m.data, now)) return null;
  return (
    <MigrationView
      m={m.data}
      gameName={game.name}
      now={now}
      cancelling={cancel.isPending}
      cancelError={
        cancel.error
          ? isApiError(cancel.error, 'conflict')
            ? 'Am Ziel wird schon gestartet. Abbrechen geht jetzt nicht mehr.'
            : errorText(cancel.error)
          : null
      }
      onCancel={() => cancel.mutate()}
    />
  );
}

export interface MigrationViewProps {
  m: Migration;
  gameName: string;
  now: Date;
  cancelling?: boolean;
  cancelError?: string | null;
  onCancel: () => void;
}

/** Pure view of one migration (unit tested). */
export function MigrationView({
  m,
  gameName,
  now,
  cancelling,
  cancelError,
  onCancel,
}: MigrationViewProps): ReactElement {
  const status = migrationStatus(m);
  const showBytes = m.progress.bytesDone > 0 || m.progress.bytesTotal != null;
  return (
    <Tile
      title={`Umzug nach ${m.targetServerName}`}
      icon="refresh"
      span={4}
      status={status}
      statusLabel={PHASE_LABEL[m.phase]}
    >
      <div className="app-stack" data-testid="migration" data-phase={m.phase} aria-live="polite">
        <p className="app-text">{migrationSentence(m, gameName)}</p>
        <ol className="app-migrate-steps" aria-label="Schritte">
          {stepStates(m).map(({ step, state }) => (
            <li key={step} data-state={state}>
              {state === 'pending' ? (
                <span className="app-migrate-pending">{PHASE_LABEL[step]} · offen</span>
              ) : (
                <StatusDot
                  status={STEP_STATUS[state]}
                  label={`${PHASE_LABEL[step]}${state === 'done' ? ' · fertig' : ''}`}
                />
              )}
            </li>
          ))}
        </ol>
        {showBytes ? (
          <UsageBar
            label="Daten"
            value={m.progress.bytesTotal ? progressPercent(m.progress) : 0}
            detail={progressText(m.progress)}
            warnAt={101}
            critAt={101}
          />
        ) : null}
        {m.phase === 'failed' ? (
          <Alert tone="crit" title={m.errorText ?? 'Umzug fehlgeschlagen.'}>
            {m.rollback ?? `${gameName} bleibt auf ${m.sourceServerName}.`}
          </Alert>
        ) : null}
        {m.phase === 'done' ? (
          <dl className="app-kv">
            <dt>Server</dt>
            <dd>
              <Link to={`/servers/${encodeURIComponent(m.targetServerId)}`}>
                {m.targetServerName}
              </Link>
            </dd>
            <dt>Ports</dt>
            <dd>
              {m.ports
                .map((p) => `${p.name} ${portLabel(p.port, p.protocol, p.count)}`)
                .join(' · ') || '—'}
            </dd>
            <dt>Fertig</dt>
            <dd>{m.finishedAt ? formatWhen(new Date(m.finishedAt), now) : '—'}</dd>
          </dl>
        ) : null}
        {m.forwardingHint && m.phase !== 'failed' ? (
          <Alert tone="warn" title={m.forwardingHint} />
        ) : null}
        {cancelError ? <FormError title={cancelError} /> : null}
        {canCancelMigration(m) ? (
          <div className="hz-form-actions">
            <Button onClick={onCancel} disabled={cancelling}>
              {cancelling ? 'Bricht ab …' : 'Abbrechen'}
            </Button>
          </div>
        ) : null}
      </div>
    </Tile>
  );
}

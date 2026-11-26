import type { GameSummary } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Button, StatusDot, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { isApiError } from '../../lib/api.js';
import { errorText } from '../../lib/errors.js';
import { formatWhen } from '../../lib/format.js';
import {
  decideWhitelistRequest,
  fetchWhitelistRequests,
  pendingCount,
  REQUEST_STATE,
  sortRequests,
  whitelistRequestsKey,
  type WhitelistRequest,
} from '../../lib/gameFeatures.js';
import { gameErrorText } from './useGameAction.js';

/**
 * Whitelist-Anfragen (M12): friends with the right "Whitelist-Anfrage" enter their
 * player name on the share page; the admin gets a push and decides here. Open ones on
 * top. Approving sends the whitelist command over RCON, so the game must run.
 */
export function WhitelistRequestsTile({
  game,
  now,
}: {
  game: GameSummary;
  now: Date;
}): ReactElement {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: whitelistRequestsKey(game.id),
    queryFn: ({ signal }) => fetchWhitelistRequests(game.id, signal),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) =>
      decideWhitelistRequest(id, decision),
    onSuccess: (req) => {
      qc.setQueryData<WhitelistRequest[]>(whitelistRequestsKey(game.id), (old) =>
        old?.map((r) => (r.id === req.id ? req : r)),
      );
    },
  });
  const list = sortRequests(q.data ?? []);
  const open = pendingCount(list);
  const running = game.status === 'ok' || game.status === 'warn';

  return (
    <Tile
      title="Whitelist-Anfragen"
      icon="lock"
      count={q.data ? (open ? `${open} offen` : String(list.length)) : undefined}
      span={2}
      flush
      footer={
        <span className="app-foot-text">
          {running
            ? 'Bestätigen trägt den Namen per RCON in die Whitelist ein'
            : `Bestätigen geht, sobald ${game.name} läuft`}
        </span>
      }
    >
      {q.error && !q.data ? (
        <div className="app-pad">
          <FormError title={errorText(q.error)} />
        </div>
      ) : null}
      {decide.error ? (
        <div className="app-pad">
          <FormError
            title={
              isApiError(decide.error, 'conflict') && !running
                ? `${game.name} läuft nicht. Erst starten, dann bestätigen.`
                : gameErrorText(decide.error)
            }
          />
        </div>
      ) : null}
      {q.data && list.length === 0 ? (
        <p className="app-empty app-pad">
          Keine Anfragen. Freunde stellen sie über einen Benutzerlink mit dem Recht
          „Whitelist-Anfrage“.
        </p>
      ) : null}
      {list.map((r) => {
        const st = REQUEST_STATE[r.state];
        const pending = decide.isPending && decide.variables?.id === r.id;
        return (
          <div key={r.id} className="hz-row" data-testid="whitelist-request">
            <StatusDot status={st.status} label={st.text} />
            <div className="hz-row-main">
              <span className="hz-row-name">{r.player}</span>
              <span className="hz-row-sub">
                {r.person} · {formatWhen(new Date(r.createdAt), now)}
                {r.decidedAt ? ` · entschieden ${formatWhen(new Date(r.decidedAt), now)}` : ''}
              </span>
            </div>
            {r.state === 'pending' ? (
              <div className="hz-row-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={decide.isPending}
                  aria-label={`Anfrage von ${r.player} ablehnen`}
                  onClick={() => decide.mutate({ id: r.id, decision: 'reject' })}
                >
                  Ablehnen
                </Button>
                <Button
                  size="sm"
                  icon="check"
                  disabled={decide.isPending}
                  aria-label={`${r.player} auf die Whitelist`}
                  onClick={() => decide.mutate({ id: r.id, decision: 'approve' })}
                >
                  {pending && decide.variables?.decision === 'approve'
                    ? 'Trägt ein …'
                    : 'Bestätigen'}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
    </Tile>
  );
}

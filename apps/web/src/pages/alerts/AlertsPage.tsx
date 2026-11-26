import type { Alert as AlertData } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import {
  ackAlert,
  alertsAllKey,
  alertsKey,
  fetchAlerts,
  resolveAlert,
  sortAlerts,
} from '../../lib/alerts.js';
import { useActiveAlerts, useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatWhen } from '../../lib/format.js';
import { mergeById } from '../../lib/live.js';

const STATE_TEXT: Record<AlertData['state'], string> = {
  open: 'offen',
  acked: 'bestätigt',
  resolved: 'erledigt',
};

/** Simple log of alerts with ack/resolve. Filters and push follow in M4. */
export function AlertsPage(): ReactElement {
  const [showAll, setShowAll] = useState(false);
  const active = useActiveAlerts();
  const all = useQuery({
    queryKey: alertsAllKey,
    queryFn: ({ signal }) => fetchAlerts('all', signal),
    enabled: showAll,
  });
  const servers = useServers();
  const names = new Map((servers.data ?? []).map((s) => [s.id, s.name]));
  const qc = useQueryClient();

  const onDone = (a: AlertData): void => {
    qc.setQueryData<AlertData[]>(alertsKey, (old) =>
      mergeById(old, [a]).filter((x) => x.state !== 'resolved'),
    );
    void qc.invalidateQueries({ queryKey: alertsAllKey });
  };
  const ack = useMutation({ mutationFn: ackAlert, onSuccess: onDone });
  const resolve = useMutation({ mutationFn: resolveAlert, onSuccess: onDone });

  const source = showAll ? all : active;
  const list = sortAlerts(source.data ?? []);
  const busy = ack.isPending || resolve.isPending;
  const error = ack.error ?? resolve.error ?? source.error;

  return (
    <Tile
      title={showAll ? 'Alle Meldungen' : 'Aktive Meldungen'}
      icon="bell"
      count={String(list.length)}
      actions={
        <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Nur aktive zeigen' : 'Erledigte zeigen'}
        </Button>
      }
    >
      {error ? <FormError title={errorText(error)} /> : null}
      {list.length === 0 && source.data ? (
        <p className="app-empty">
          {showAll ? 'Noch keine Meldungen.' : 'Keine aktiven Meldungen. Alles ruhig.'}
        </p>
      ) : null}
      <ul className="app-alert-list">
        {list.map((a) => {
          const server = a.serverId ? names.get(a.serverId) : undefined;
          return (
            <li key={a.id} data-state={a.state}>
              <Alert
                tone={a.level}
                time={formatWhen(new Date(a.openedAt))}
                title={a.title}
                action={
                  <span className="app-toast-actions">
                    {a.state === 'open' ? (
                      <Button size="sm" disabled={busy} onClick={() => ack.mutate(a.id)}>
                        Bestätigen
                      </Button>
                    ) : null}
                    {a.state !== 'resolved' ? (
                      <Button size="sm" disabled={busy} onClick={() => resolve.mutate(a.id)}>
                        Erledigen
                      </Button>
                    ) : null}
                  </span>
                }
              >
                {a.body}
                <span className="app-alert-meta">
                  {STATE_TEXT[a.state]}
                  {server && a.serverId ? (
                    <>
                      {' · '}
                      <Link to={`/servers/${a.serverId}`}>{server}</Link>
                    </>
                  ) : null}
                  {` · ${a.source}`}
                </span>
              </Alert>
            </li>
          );
        })}
      </ul>
    </Tile>
  );
}

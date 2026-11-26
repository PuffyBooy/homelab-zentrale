import type { Alert as AlertData } from '@hz/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Alert, Button, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import {
  ALERT_LEVELS,
  ALERT_SOURCES,
  ALERT_STATES,
  LEVEL_LABEL,
  SOURCE_LABEL,
  STATE_FILTER_LABEL,
  ackAlert,
  alertsAllKey,
  alertsFilterKey,
  alertsKey,
  fetchFilteredAlerts,
  filterFromParams,
  resolveAlert,
  sortAlerts,
} from '../../lib/alerts.js';
import { useContainers, useServerFilter, useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatWhen } from '../../lib/format.js';
import { mergeById } from '../../lib/live.js';
import { ALL_SERVERS } from '../../lib/servers.js';
import { parseAutostopKey } from '../../lib/throttle.js';
import { RestartAutostopButton } from '../throttle/RestartAutostopButton.js';
import { AllowPortButton } from './AllowPortButton.js';

const STATE_TEXT: Record<AlertData['state'], string> = {
  open: 'offen',
  acked: 'bestätigt',
  resolved: 'erledigt',
};

/** Links from an alert to where it can be fixed. */
function alertTarget(a: AlertData): string | null {
  if (a.serverId) return `/servers/${a.serverId}`;
  if (a.source === 'check') return '/websites';
  if (a.source === 'container') return '/containers';
  return null;
}

/**
 * SPEC 9: all alerts as log lines, newest first, filterable by state, level, source
 * and server (the ServerSwitch in the header, `?server=`). The filter lives in the URL.
 */
export function AlertsPage(): ReactElement {
  const [params, setParams] = useSearchParams();
  const [serverFilter] = useServerFilter();
  const filter = filterFromParams(params, serverFilter !== ALL_SERVERS ? serverFilter : undefined);
  const list = useQuery({
    queryKey: alertsFilterKey(filter),
    queryFn: ({ signal }) => fetchFilteredAlerts(filter, signal),
    staleTime: 15_000,
  });
  const servers = useServers();
  // Only needed for "Wieder starten" on autostop alerts (M10).
  const hasAutostop = (list.data ?? []).some(
    (a) => a.state !== 'resolved' && parseAutostopKey(a.key),
  );
  const containers = useContainers(hasAutostop);
  const [startError, setStartError] = useState<unknown>(null);
  const names = new Map((servers.data ?? []).map((s) => [s.id, s.name]));
  const qc = useQueryClient();

  const setParam = useCallback(
    (key: 'state' | 'level' | 'source', value: string, fallback = '') => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === fallback) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const onDone = (a: AlertData): void => {
    qc.setQueryData<AlertData[]>(alertsKey, (old) =>
      old ? mergeById(old, [a]).filter((x) => x.state !== 'resolved') : old,
    );
    void qc.invalidateQueries({ queryKey: alertsAllKey });
  };
  const ack = useMutation({ mutationFn: ackAlert, onSuccess: onDone });
  const resolve = useMutation({ mutationFn: resolveAlert, onSuccess: onDone });

  const rows = sortAlerts(list.data ?? []);
  const error = ack.error ?? resolve.error ?? list.error;
  const filtered = filter.state !== 'active' || filter.level || filter.source || filter.serverId;

  return (
    <div className="app-stack">
      <div className="app-filters" role="group" aria-label="Meldungen filtern">
        <SelectField
          label="Zustand"
          value={filter.state}
          onChange={(e) => setParam('state', e.target.value, 'active')}
          options={ALERT_STATES.map((s) => ({ value: s, label: STATE_FILTER_LABEL[s] }))}
        />
        <SelectField
          label="Level"
          value={filter.level ?? ''}
          onChange={(e) => setParam('level', e.target.value)}
          options={[
            { value: '', label: 'alle' },
            ...[...ALERT_LEVELS].reverse().map((l) => ({ value: l, label: LEVEL_LABEL[l] })),
          ]}
        />
        <SelectField
          label="Quelle"
          value={filter.source ?? ''}
          onChange={(e) => setParam('source', e.target.value)}
          options={[
            { value: '', label: 'alle' },
            ...ALERT_SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] })),
          ]}
        />
      </div>
      <Tile title="Meldungen" icon="bell" count={list.data ? String(rows.length) : undefined} flush>
        {error ? (
          <div className="app-pad">
            <FormError title={errorText(error)} />
          </div>
        ) : null}
        {rows.length === 0 && list.data ? (
          <p className="app-empty app-pad">
            {filtered
              ? 'Keine Meldungen für diesen Filter.'
              : 'Keine aktiven Meldungen. Alles ruhig.'}
          </p>
        ) : null}
        {startError ? (
          <div className="app-pad">
            <FormError title={errorText(startError)} />
          </div>
        ) : null}
        {list.isPending ? <p className="app-empty app-pad">Lade Meldungen …</p> : null}
        <ul className="app-alert-list app-pad">
          {rows.map((a) => {
            const server = a.serverId ? names.get(a.serverId) : undefined;
            const target = alertTarget(a);
            const ackBusy = ack.isPending && ack.variables === a.id;
            const resolveBusy = resolve.isPending && resolve.variables === a.id;
            return (
              <li key={a.id} data-state={a.state} data-testid="alert-line">
                <Alert
                  tone={a.level}
                  time={formatWhen(new Date(a.openedAt))}
                  title={a.title}
                  action={
                    a.state === 'resolved' ? undefined : (
                      <span className="app-toast-actions">
                        {containers.data && parseAutostopKey(a.key) ? (
                          <RestartAutostopButton
                            alertKey={a.key}
                            containers={containers.data}
                            onError={setStartError}
                          />
                        ) : null}
                        <AllowPortButton alert={a} onError={setStartError} />
                        {a.state === 'open' ? (
                          <Button
                            size="sm"
                            disabled={ackBusy}
                            onClick={() => ack.mutate(a.id)}
                            aria-label={`${a.title} bestätigen`}
                          >
                            Bestätigen
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          disabled={resolveBusy}
                          onClick={() => resolve.mutate(a.id)}
                          aria-label={`${a.title} erledigen`}
                        >
                          Erledigen
                        </Button>
                      </span>
                    )
                  }
                >
                  {a.body}
                  <span className="app-alert-meta">
                    {STATE_TEXT[a.state]}
                    {a.resolvedAt ? ` ${formatWhen(new Date(a.resolvedAt))}` : ''}
                    {a.state === 'acked' && a.ackedAt ? ` ${formatWhen(new Date(a.ackedAt))}` : ''}
                    {' · '}
                    {target ? (
                      <Link to={target}>{server ?? SOURCE_LABEL[a.source]}</Link>
                    ) : (
                      (server ?? SOURCE_LABEL[a.source])
                    )}
                    {server ? ` · ${SOURCE_LABEL[a.source]}` : ''}
                  </span>
                </Alert>
              </li>
            );
          })}
        </ul>
      </Tile>
    </div>
  );
}

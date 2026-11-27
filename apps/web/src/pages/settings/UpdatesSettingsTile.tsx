import type { UpdatesResponse } from '@hz/shared';
import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { Alert, ServiceRow, StatusDot, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { errorText } from '../../lib/errors.js';
import { formatWhen, plural } from '../../lib/format.js';
import {
  CORE_HOST_UNKNOWN_HINT,
  RUN_STATUS,
  RUN_TARGET_LABEL,
  fromToText,
  lastRunOf,
  policySummary,
  updateStatus,
  versionText,
} from '../../lib/updates.js';
import { useNow } from '../../lib/useNow.js';
import { useUpdates } from '../servers/AutoUpdateTile.js';

/** Settings → Updates (ROADMAP M17): every server with versions and policy, the last 50 runs. */
export function UpdatesSettingsTile(): ReactElement {
  const q = useUpdates();
  const now = useNow(30_000);
  if (!q.data) {
    return (
      <Tile title="Updates" icon="refresh">
        {q.error ? (
          <FormError title={errorText(q.error)} />
        ) : (
          <p className="app-empty" role="status">
            Lade Updates …
          </p>
        )}
      </Tile>
    );
  }
  return <UpdatesSettingsView data={q.data} now={now} />;
}

export function UpdatesSettingsView({
  data,
  now,
}: {
  data: UpdatesResponse;
  now: Date;
}): ReactElement {
  const servers = [...data.servers].sort((a, b) => a.name.localeCompare(b.name, 'de-AT'));
  return (
    <Tile
      title="Updates"
      icon="refresh"
      count={plural(servers.length, 'Server', 'Server')}
      footer={
        <span className="app-foot-text">
          Richtlinie und Fenster stellst du im Serverdetail unter Auto-Update ein.
        </span>
      }
    >
      {!data.coreHostKnown ? <Alert tone="info" title={CORE_HOST_UNKNOWN_HINT} /> : null}
      {servers.length ? (
        <div className="app-rows" role="group" aria-label="Server und Versionen">
          {servers.map((s) => {
            const st = updateStatus(s, lastRunOf(data.runs, s.serverId));
            const versions = [
              `Agent ${versionText(s.agent.current)}`,
              s.core ? `Zentrale ${versionText(s.core.current)}` : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <ServiceRow
                key={s.serverId}
                name={s.name}
                host={versions}
                status={st.status}
                meta={
                  <span className="app-text">
                    {st.label} · {policySummary(s.policy, s.hostsCore)}
                  </span>
                }
                actions={
                  <Link
                    className="hz-btn hz-btn-ghost hz-btn-sm"
                    to={`/servers/${encodeURIComponent(s.serverId)}#updates`}
                    aria-label={`Auto-Update von ${s.name} öffnen`}
                  >
                    Öffnen
                  </Link>
                }
              />
            );
          })}
        </div>
      ) : (
        <p className="app-empty">Noch kein Server verbunden.</p>
      )}

      <h3 className="hz-label app-storage-head">Verlauf · letzte {data.runs.length}</h3>
      {data.runs.length ? (
        <div className="app-scroll-x" tabIndex={0} role="region" aria-label="Update-Verlauf">
          <table className="app-table app-runs" aria-label="Update-Verlauf">
            <thead>
              <tr>
                <th scope="col">Zeit</th>
                <th scope="col">Server</th>
                <th scope="col">Ziel</th>
                <th scope="col">Von → Nach</th>
                <th scope="col">Status</th>
                <th scope="col">Meldung</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => {
                const st = RUN_STATUS[r.status];
                return (
                  <tr key={r.id}>
                    <td>{formatWhen(new Date(r.startedAt), now)}</td>
                    <th scope="row">{r.serverName}</th>
                    <td>{RUN_TARGET_LABEL[r.target]}</td>
                    <td>{fromToText(r)}</td>
                    <td>
                      <StatusDot status={st.status} label={st.label} />
                    </td>
                    <td>{r.message ?? (r.trigger === 'manual' ? 'von Hand' : 'im Fenster')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="app-empty">Noch kein Update-Lauf.</p>
      )}
    </Tile>
  );
}

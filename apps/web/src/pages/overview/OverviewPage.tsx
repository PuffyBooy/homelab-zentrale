import type { ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, Button } from '@hz/ui';
import { openCrit } from '../../lib/alerts.js';
import { useActiveAlerts, useContainers, useServerFilter, useServers } from '../../lib/data.js';
import { formatWhen } from '../../lib/format.js';
import { useLiveTopic } from '../../lib/live.js';
import { ALL_SERVERS } from '../../lib/servers.js';
import { ContainersTile } from '../containers/ContainersTile.js';
import { NoServers, ServerListTile } from '../servers/ServerListTile.js';

const MAX_ALERTS = 3;

/**
 * Overview after design/reference/previews/Dashboard.html: Statussatz (shell header),
 * open crit alerts, ServerList over the full width, then the pairs. Containers sit in
 * the right half of the GitHub/Container pair; games, websites and GitHub follow with
 * their milestones.
 */
export function OverviewPage(): ReactElement | null {
  const servers = useServers();
  const alerts = useActiveAlerts();
  useLiveTopic('containers');
  const containers = useContainers();
  const [filter] = useServerFilter();
  const navigate = useNavigate();

  if (!servers.data) return null;
  if (servers.data.length === 0) return <NoServers />;

  const one = filter !== ALL_SERVERS ? filter : undefined;
  const list = one ? servers.data.filter((s) => s.id === one) : servers.data;
  const crit = openCrit(alerts.data ?? [], one);
  const shown = crit.slice(0, MAX_ALERTS);
  const more = crit.length - shown.length;

  return (
    <>
      {shown.length ? (
        <div className="app-stack" aria-label="Offene Probleme">
          {shown.map((a) => (
            <Alert
              key={a.id}
              tone="crit"
              time={formatWhen(new Date(a.openedAt))}
              title={a.title}
              action={
                <Button
                  size="sm"
                  onClick={() => void navigate(a.serverId ? `/servers/${a.serverId}` : '/alerts')}
                >
                  Ansehen
                </Button>
              }
            >
              {a.body}
            </Alert>
          ))}
          {more > 0 ? (
            <Link className="app-more" to="/alerts">
              +{more} weitere
            </Link>
          ) : null}
        </div>
      ) : null}
      <ServerListTile servers={list} active={one} />
      {containers.data ? (
        <div className="hz-grid app-grid">
          <ContainersTile
            containers={one ? containers.data.filter((c) => c.serverId === one) : containers.data}
            serverId={one}
          />
        </div>
      ) : null}
    </>
  );
}

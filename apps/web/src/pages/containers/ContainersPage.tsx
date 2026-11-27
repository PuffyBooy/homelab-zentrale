import type { Alert as AlertData, ContainerSummary, ServerSummary } from '@hz/shared';
import { useMemo, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Alert, Tile } from '@hz/ui';
import { sortAlerts } from '../../lib/alerts.js';
import { groupContainers, runningCount, type ProjectGroup } from '../../lib/containers.js';
import { useActiveAlerts, useContainers, useServerFilter, useServers } from '../../lib/data.js';
import { formatTime, formatWhen } from '../../lib/format.js';
import { useLiveTopic } from '../../lib/live.js';
import { ALL_SERVERS } from '../../lib/servers.js';
import { useNow } from '../../lib/useNow.js';
import { NoServers } from '../servers/ServerListTile.js';
import { ContainerRow } from './ContainerRow.js';
import { ContainersNav } from './ContainersNav.js';
import { StackActions } from './StackActions.js';

/** Compose project heading inside a server tile, with the stack actions (M23). */
function ProjectRows({
  group,
  now,
  offline,
  terminal,
  showHeading,
  serverId,
  serverName,
}: {
  group: ProjectGroup;
  now: Date;
  offline: boolean;
  terminal: boolean;
  showHeading: boolean;
  serverId: string;
  serverName: string;
}): ReactElement {
  return (
    <div className="app-ctr-group" role="group" aria-label={projectLabel(group)}>
      {showHeading ? (
        <div className="app-ctr-head">
          <span className="hz-label app-ctr-head-label" aria-hidden={true}>
            {projectLabel(group)}
            <span className="app-ctr-head-n">{runningCount(group.containers)}</span>
          </span>
          {group.project ? (
            <StackActions
              serverId={serverId}
              serverName={serverName}
              project={group.project}
              containers={group.containers}
              offline={offline}
            />
          ) : null}
        </div>
      ) : null}
      {group.containers.map((c) => (
        <ContainerRow key={c.id} c={c} now={now} offline={offline} terminal={terminal} />
      ))}
    </div>
  );
}

function projectLabel(g: ProjectGroup): string {
  return g.project ? `compose · ${g.project}` : 'einzeln';
}

function offlineNote(s: ServerSummary | undefined): ReactNode {
  if (!s || s.connected) return null;
  const since = s.lastSeen ? ` · Stand ${formatTime(new Date(s.lastSeen))}` : '';
  return <span className="app-foot-text">Agent offline, Aktionen gesperrt{since}</span>;
}

export interface ContainerGroupsProps {
  containers: ContainerSummary[];
  servers: ServerSummary[];
  /** Title of the tile; the server name by default. */
  title?: (serverName: string) => string;
}

/** One tile per server, inside grouped by compose project. Problems first. */
export function ContainerGroups({
  containers,
  servers,
  title,
}: ContainerGroupsProps): ReactElement {
  const now = useNow(30_000);
  const groups = useMemo(() => groupContainers(containers), [containers]);
  return (
    <>
      {groups.map((g) => {
        const server = servers.find((s) => s.id === g.serverId);
        const offline = server ? !server.connected : false;
        const terminal = server?.allowTerminal ?? false;
        const single = g.projects.length === 1 && g.projects[0]?.project === null;
        const count = runningCount(g.projects.flatMap((p) => p.containers));
        return (
          <Tile
            key={g.serverId}
            title={title ? title(g.serverName) : g.serverName}
            icon="container"
            count={g.problems ? `${count} · ${g.problems} mit Problem` : count}
            status={g.problems ? g.status : undefined}
            span={4}
            flush
            footer={offlineNote(server)}
          >
            {g.projects.map((p) => (
              <ProjectRows
                key={p.key}
                group={p}
                now={now}
                offline={offline}
                terminal={terminal}
                showHeading={!single}
                serverId={g.serverId}
                serverName={g.serverName}
              />
            ))}
          </Tile>
        );
      })}
    </>
  );
}

const MAX_ALERTS = 3;

/** Open container alerts (stopped, down), newest first. */
function ContainerAlerts({ alerts }: { alerts: AlertData[] }): ReactElement | null {
  if (!alerts.length) return null;
  const shown = alerts.slice(0, MAX_ALERTS);
  const more = alerts.length - shown.length;
  return (
    <div className="hz-span-4 app-stack" aria-label="Meldungen zu Containern">
      {shown.map((a) => (
        <Alert
          key={a.id}
          tone={a.level === 'ok' ? 'ok' : a.level}
          time={formatWhen(new Date(a.openedAt))}
          title={a.title}
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
  );
}

/** /containers (SPEC 6.1): all containers, live over the topic `containers`. */
export function ContainersPage(): ReactElement | null {
  useLiveTopic('containers');
  const servers = useServers();
  const containers = useContainers();
  const alerts = useActiveAlerts();
  const [filter] = useServerFilter();

  if (!servers.data) return null;
  if (servers.data.length === 0) return <NoServers />;
  if (!containers.data) return null;

  const one = filter !== ALL_SERVERS ? filter : undefined;
  const list = one ? containers.data.filter((c) => c.serverId === one) : containers.data;

  if (list.length === 0) {
    const name = one ? servers.data.find((s) => s.id === one)?.name : undefined;
    return (
      <>
        <ContainersNav />
        <Tile title="Container" icon="container" count="0">
          <p className="app-empty">
            {name ? `${name} meldet keine Container.` : 'Kein Server meldet Container.'} Der Agent
            zeigt sie, sobald er den Docker-Socket lesen darf.
          </p>
        </Tile>
      </>
    );
  }

  const open = sortAlerts(
    (alerts.data ?? []).filter(
      (a) =>
        a.source === 'container' &&
        a.state === 'open' &&
        a.level !== 'ok' &&
        (!one || a.serverId === one),
    ),
  );
  return (
    <div className="hz-grid app-grid">
      <div className="hz-span-4">
        <ContainersNav />
      </div>
      <ContainerAlerts alerts={open} />
      <ContainerGroups containers={list} servers={servers.data} />
    </div>
  );
}

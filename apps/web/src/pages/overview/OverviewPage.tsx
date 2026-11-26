import type { ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, Button } from '@hz/ui';
import { openCrit } from '../../lib/alerts.js';
import { checkMatchesServer } from '../../lib/checks.js';
import {
  useActiveAlerts,
  useChecks,
  useContainers,
  useGames,
  useGithubSettings,
  useRepos,
  useServerFilter,
  useServers,
} from '../../lib/data.js';
import { formatWhen } from '../../lib/format.js';
import { repoOnServer } from '../../lib/github.js';
import { isHaConfigured } from '../../lib/ha.js';
import { useHaView } from '../../lib/haActions.js';
import { useLiveTopic } from '../../lib/live.js';
import { useModules } from '../../lib/useModules.js';
import { ALL_SERVERS } from '../../lib/servers.js';
import { ContainersTile } from '../containers/ContainersTile.js';
import { GamesTile } from '../games/GamesTile.js';
import { GithubTile } from '../github/GithubTile.js';
import { HomeTile } from '../home/HomeTile.js';
import { NoServers, ServerListTile } from '../servers/ServerListTile.js';
import { ChecksTile } from '../websites/ChecksTile.js';

const MAX_ALERTS = 3;

/**
 * Overview after design/reference/previews/Dashboard.html: Statussatz (shell header),
 * open crit alerts, ServerList over the full width, then the pairs (SPEC 4):
 * Gameserver/Websites and GitHub/Container, then "Wohnung" when Home Assistant is set up.
 * Tiles of switched-off modules (Einstellungen → Module) are left out.
 */
export function OverviewPage(): ReactElement | null {
  const servers = useServers();
  const alerts = useActiveAlerts();
  useLiveTopic('containers');
  const containers = useContainers();
  useLiveTopic('checks');
  const checks = useChecks();
  const modules = useModules();
  useLiveTopic(modules.github ? 'github' : null);
  useLiveTopic(modules.games ? 'games' : null);
  const gamesQuery = useGames(modules.games);
  const reposQuery = useRepos(modules.github);
  const github = useGithubSettings(modules.github);
  useLiveTopic(modules.homeassistant ? 'ha' : null);
  const haQuery = useHaView(modules.homeassistant);
  // Cached data of a module switched off meanwhile is not shown.
  const games = { data: modules.games ? gamesQuery.data : undefined };
  const repos = { data: modules.github ? reposQuery.data : undefined };
  const ha = { view: modules.homeassistant ? haQuery.view : undefined };
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
      {games.data || checks.data ? (
        <div className="hz-grid app-grid">
          {games.data ? (
            <GamesTile
              games={one ? games.data.filter((g) => g.serverId === one) : games.data}
              serverId={one}
            />
          ) : null}
          {checks.data ? (
            <ChecksTile
              checks={one ? checks.data.filter((c) => checkMatchesServer(c, one)) : checks.data}
              servers={servers.data}
              serverId={one}
            />
          ) : null}
        </div>
      ) : null}
      {repos.data || containers.data ? (
        <div className="hz-grid app-grid">
          {repos.data ? (
            <GithubTile
              repos={one ? repos.data.filter((r) => repoOnServer(r, one)) : repos.data}
              settings={github.data}
            />
          ) : null}
          {containers.data ? (
            <ContainersTile
              containers={one ? containers.data.filter((c) => c.serverId === one) : containers.data}
              serverId={one}
            />
          ) : null}
        </div>
      ) : null}
      {!one && ha.view && isHaConfigured(ha.view) ? (
        <div className="hz-grid app-grid">
          <HomeTile state={ha.view} />
        </div>
      ) : null}
    </>
  );
}

import type { GithubSettings } from '@hz/shared';
import { useMemo, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { useGithubSettings, useRepos, useServerFilter } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import {
  deployableTargets,
  pollText,
  repoBehind,
  repoOnServer,
  sortRepos,
} from '../../lib/github.js';
import { useLiveTopic } from '../../lib/live.js';
import { ALL_SERVERS } from '../../lib/servers.js';
import { useNow } from '../../lib/useNow.js';
import { RepoListRow } from './RepoListRow.js';
import { deployErrorText, useDeploy } from './useDeploy.js';
import { GITHUB_SETTINGS_HREF } from '../../lib/github.js';

export { GITHUB_SETTINGS_HREF };

/** /github (SPEC 7): one RepoRow per tracked repo, new commits first, live over `github`. */
export function GithubPage(): ReactElement | null {
  useLiveTopic('github');
  const settings = useGithubSettings();
  const repos = useRepos();
  const [filter] = useServerFilter();
  const navigate = useNavigate();
  const now = useNow(30_000);
  const deploy = useDeploy((deploys) => {
    const first = deploys[0];
    const repo = repos.data?.find((r) => r.targets.some((t) => t.id === first?.targetId));
    if (first && repo) void navigate(`/github/${repo.id}?deploy=${first.id}`);
  });

  const one = filter !== ALL_SERVERS ? filter : undefined;
  const list = useMemo(() => {
    const all = repos.data ?? [];
    return sortRepos(one ? all.filter((r) => repoOnServer(r, one)) : all);
  }, [repos.data, one]);

  if (settings.isError && !settings.data) return <FormError title={errorText(settings.error)} />;
  if (repos.isError && !repos.data) return <FormError title={errorText(repos.error)} />;
  if (!settings.data || !repos.data) return null;

  if (!settings.data.tokenSet && repos.data.length === 0) return <NoToken />;

  const news = list.filter((r) => repoBehind(r) > 0).length;

  return (
    <div className="hz-grid app-grid">
      <SettingsNote settings={settings.data} />
      <Tile
        title="Repos"
        icon="git"
        count={news ? `${list.length} · ${news} mit neuen Commits` : String(list.length)}
        span={4}
        flush
        footer={<span className="app-foot-text">{pollText(settings.data)}</span>}
      >
        {list.length === 0 ? (
          <p className="app-empty app-pad">
            {one ? (
              'Kein Repo deployt auf diesen Server.'
            ) : (
              <>
                Noch keine Repos. <Link to={GITHUB_SETTINGS_HREF}>Repo hinzufügen</Link> in den
                Einstellungen.
              </>
            )}
          </p>
        ) : (
          list.map((r) => (
            <RepoListRow
              key={r.id}
              repo={r}
              now={now}
              deploying={deploy.isPending}
              onDeploy={() => deploy.mutate({ targetIds: deployableTargets(r).map((t) => t.id) })}
              onOpen={() => void navigate(`/github/${r.id}`)}
            />
          ))
        )}
        {deploy.error ? (
          <div className="app-pad">
            <FormError title={deployErrorText(deploy.error)} />
          </div>
        ) : null}
      </Tile>
    </div>
  );
}

/** Empty state without token: one sentence and the way to the settings. */
function NoToken(): ReactElement {
  return (
    <Tile title="GitHub" icon="git" span={4}>
      <p className="app-text">
        Kein GitHub-Token hinterlegt. Mit einem Fine-grained Token (Contents, Actions und Metadata,
        nur lesen) zeigt die Zentrale Repos, CI und neue Commits.
      </p>
      <p className="app-text">
        <Link to={GITHUB_SETTINGS_HREF}>Token in den Einstellungen eintragen</Link>
      </p>
    </Tile>
  );
}

function SettingsNote({ settings }: { settings: GithubSettings }): ReactElement | null {
  if (!settings.tokenSet) {
    return (
      <div className="hz-span-4">
        <Alert tone="warn" title="Kein GitHub-Token hinterlegt.">
          Die Repos werden nicht mehr abgeglichen.{' '}
          <Link to={GITHUB_SETTINGS_HREF}>Token eintragen</Link>
        </Alert>
      </div>
    );
  }
  if (!settings.error) return null;
  return (
    <div className="hz-span-4">
      <Alert tone="warn" title={`GitHub-Abgleich gestört: ${settings.error}`}>
        Repos zeigen den letzten bekannten Stand.{' '}
        <Link to={GITHUB_SETTINGS_HREF}>Einstellungen</Link>
      </Alert>
    </div>
  );
}

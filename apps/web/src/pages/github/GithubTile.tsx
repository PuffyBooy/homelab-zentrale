import type { GithubSettings, RepoSummary } from '@hz/shared';
import { useMemo, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router';
import { Tile } from '@hz/ui';
import { FormError } from '../../components/FormError.js';
import { deployableTargets, repoBehind, sortRepos } from '../../lib/github.js';
import { useNow } from '../../lib/useNow.js';
import { GITHUB_SETTINGS_HREF } from './GithubPage.js';
import { RepoListRow } from './RepoListRow.js';
import { deployErrorText, useDeploy } from './useDeploy.js';

const MAX_ROWS = 5;

/**
 * Overview tile after Dashboard.html: login as count, short repo names, repos with new
 * commits first, "Deploy" right in the row when CI is green.
 */
export function GithubTile({
  repos,
  settings,
}: {
  repos: RepoSummary[];
  settings?: GithubSettings | undefined;
}): ReactElement {
  const now = useNow(30_000);
  const navigate = useNavigate();
  const rows = useMemo(() => sortRepos(repos), [repos]);
  const shown = rows.slice(0, MAX_ROWS);
  const more = rows.length - shown.length;
  const news = repos.filter((r) => repoBehind(r) > 0).length;
  const deploy = useDeploy((deploys) => {
    const first = deploys[0];
    const repo = repos.find((r) => r.targets.some((t) => t.id === first?.targetId));
    if (first && repo) void navigate(`/github/${repo.id}?deploy=${first.id}`);
  });
  const count = settings?.login ?? (news ? `${repos.length} · ${news} neu` : String(repos.length));

  return (
    <Tile
      title="GitHub"
      icon="git"
      count={count}
      span={2}
      flush
      footer={
        <Link className="app-more" to="/github">
          {more > 0 ? `+${more} weitere · alle Repos` : 'Alle Repos'}
        </Link>
      }
    >
      {shown.length ? (
        shown.map((r) => (
          <RepoListRow
            key={r.id}
            repo={r}
            now={now}
            compact
            deploying={deploy.isPending}
            onDeploy={() => deploy.mutate({ targetIds: deployableTargets(r).map((t) => t.id) })}
          />
        ))
      ) : settings && !settings.tokenSet ? (
        <p className="app-empty app-pad">
          Kein Token hinterlegt. <Link to={GITHUB_SETTINGS_HREF}>Einstellungen</Link>
        </p>
      ) : (
        <p className="app-empty app-pad">Noch keine Repos.</p>
      )}
      {deploy.error ? (
        <div className="app-pad">
          <FormError title={deployErrorText(deploy.error)} />
        </div>
      ) : null}
    </Tile>
  );
}

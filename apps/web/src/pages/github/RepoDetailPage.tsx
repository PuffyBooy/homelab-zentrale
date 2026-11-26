import type { RepoSummary } from '@hz/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Button, StatusDot, Tile } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { useRepos, useServers } from '../../lib/data.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo, formatWhen } from '../../lib/format.js';
import { CI_TEXT, commitLine, isDeployRunning, removeRepo, reposKey } from '../../lib/github.js';
import { useLiveTopic } from '../../lib/live.js';
import { useNow } from '../../lib/useNow.js';
import { CommitsTile } from './CommitsTile.js';
import { DeployHistoryTile, useRepoDeploys } from './DeployHistoryTile.js';
import { DeployLogTile } from './DeployLogTile.js';
import { TargetsTile } from './TargetsTile.js';
import { deployErrorText, useDeploy } from './useDeploy.js';

const DEPLOY_PARAM = 'deploy';
const deployIdRe = /^[A-Za-z0-9_-]{8,64}$/;

/** /github/:id: targets with deploy key, live deploy log, commit history, deploys. */
export function RepoDetailPage(): ReactElement | null {
  useLiveTopic('github');
  const { id = '' } = useParams();
  const repos = useRepos();
  const repo = repos.data?.find((r) => r.id === id);

  if (repos.isError && !repos.data) return <FormError title={errorText(repos.error)} />;
  if (!repos.data) return null;
  if (!repo) {
    return (
      <Tile title="Repo" icon="git">
        <p className="app-empty">
          Dieses Repo verfolgt die Zentrale nicht mehr. <Link to="/github">Zu allen Repos</Link>
        </p>
      </Tile>
    );
  }
  return <Detail repo={repo} />;
}

function Detail({ repo }: { repo: RepoSummary }): ReactElement {
  const servers = useServers();
  const now = useNow(30_000);
  const [params, setParams] = useSearchParams();
  const history = useRepoDeploys(repo);

  const param = params.get(DEPLOY_PARAM);
  const fromParam = param && deployIdRe.test(param) ? param : null;
  // Without a choice, a running deploy of this repo opens on its own.
  const running = history.deploys?.find(isDeployRunning)?.id ?? null;
  const selected = fromParam ?? running;

  const select = (deployId: string | null): void => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (deployId) next.set(DEPLOY_PARAM, deployId);
        else next.delete(DEPLOY_PARAM);
        return next;
      },
      { replace: true },
    );
  };

  const deploy = useDeploy((deploys) => {
    const first = deploys[0];
    if (first) select(first.id);
  });

  return (
    <div className="hz-grid app-grid">
      {deploy.error ? (
        <div className="hz-span-4">
          <FormError title={deployErrorText(deploy.error)} />
        </div>
      ) : null}
      {selected ? (
        <DeployLogTile
          key={selected}
          deployId={selected}
          repo={repo}
          now={now}
          onClose={() => select(null)}
        />
      ) : null}
      <TargetsTile
        repo={repo}
        servers={servers.data ?? []}
        deploying={deploy.isPending}
        onDeploy={(v) => deploy.mutate(v)}
      />
      <RepoInfoTile repo={repo} now={now} />
      <CommitsTile
        repo={repo}
        now={now}
        deploying={deploy.isPending}
        onDeploy={(v) => deploy.mutate(v)}
      />
      <DeployHistoryTile
        repo={repo}
        deploys={history.deploys}
        error={history.error}
        selected={selected}
        now={now}
        onSelect={(d) => select(d)}
      />
    </div>
  );
}

function RepoInfoTile({ repo, now }: { repo: RepoSummary; now: Date }): ReactElement {
  const [removing, setRemoving] = useState(false);
  const c = repo.lastCommit;
  return (
    <Tile title={repo.fullName} icon="git" span={2}>
      <dl className="app-kv">
        <dt>Repo</dt>
        <dd className="app-break">
          <a href={repo.htmlUrl} target="_blank" rel="noopener noreferrer">
            {repo.htmlUrl.replace(/^https:\/\//, '')}
          </a>
        </dd>
        <dt>Sichtbarkeit</dt>
        <dd>{repo.private ? 'privat' : 'öffentlich'}</dd>
        <dt>Branch</dt>
        <dd>{repo.defaultBranch}</dd>
        <dt>Letzter Commit</dt>
        <dd className="app-break">{commitLine(c, now)}</dd>
        {c ? (
          <>
            <dt>Von</dt>
            <dd>
              {c.author} · {formatWhen(new Date(c.at), now)}
            </dd>
          </>
        ) : null}
        <dt>CI</dt>
        <dd>
          <StatusDot status={repo.ci} label={CI_TEXT[repo.ci]} className="app-status-auto" />
        </dd>
        <dt>Abgeglichen</dt>
        <dd>{repo.updatedAt ? formatAgo(new Date(repo.updatedAt), now) : 'noch nie'}</dd>
      </dl>
      <div className="hz-form-actions">
        <Button variant="danger" onClick={() => setRemoving(true)}>
          Repo entfernen
        </Button>
      </div>
      {removing ? <RemoveRepoDialog repo={repo} onClose={() => setRemoving(false)} /> : null}
    </Tile>
  );
}

function RemoveRepoDialog({
  repo,
  onClose,
}: {
  repo: RepoSummary;
  onClose: () => void;
}): ReactElement {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const del = useMutation({
    mutationFn: () => removeRepo(repo.id),
    onSuccess: () => {
      qc.setQueryData<RepoSummary[]>(reposKey, (old) => old?.filter((r) => r.id !== repo.id));
      void qc.invalidateQueries({ queryKey: ['github', 'available'] });
      onClose();
      void navigate('/github');
    },
  });
  return (
    <Dialog open onClose={onClose} title={`${repo.fullName} entfernen`}>
      <div className="hz-dialog-body">
        <p className="hz-dialog-text">
          Die Zentrale verfolgt das Repo nicht mehr und löscht seine Deploy-Ziele und den Verlauf.
          Auf den Servern und bei GitHub bleibt alles, wie es ist.
        </p>
        {del.error ? <FormError title={errorText(del.error)} /> : null}
        <div className="hz-dialog-foot">
          <Button onClick={onClose} data-autofocus="">
            Abbrechen
          </Button>
          <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate()}>
            Entfernen
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

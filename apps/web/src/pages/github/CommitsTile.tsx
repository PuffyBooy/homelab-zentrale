import type { DeployTarget, RepoSummary } from '@hz/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Button, CommitRow, Tile } from '@hz/ui';
import { Dialog } from '../../components/Dialog.js';
import { FormError } from '../../components/FormError.js';
import { SelectField } from '../../components/SelectField.js';
import { errorText } from '../../lib/errors.js';
import { formatAgo } from '../../lib/format.js';
import {
  CI_ROW_LABEL,
  commitsKey,
  fetchCommits,
  repoBranches,
  repoShortName,
  rollbackTargets,
  shortSha,
  type CommitEntry,
} from '../../lib/github.js';
import type { DeployVars } from './useDeploy.js';

export interface CommitsTileProps {
  repo: RepoSummary;
  now: Date;
  deploying: boolean;
  onDeploy: (vars: DeployVars) => void;
}

/**
 * History (SPEC 7): last 30 commits as CommitRow, LIVE where a target runs it, and
 * "Rollback" (danger, with confirmation) for commits that were deployed before.
 */
export function CommitsTile({ repo, now, deploying, onDeploy }: CommitsTileProps): ReactElement {
  const branches = repoBranches(repo);
  const [branch, setBranch] = useState(repo.defaultBranch);
  const [confirm, setConfirm] = useState<{ commit: CommitEntry; target: DeployTarget } | null>(
    null,
  );
  const commits = useQuery({
    queryKey: commitsKey(repo.id, branch),
    queryFn: ({ signal }) => fetchCommits(repo.id, branch, signal),
    staleTime: 60_000,
  });
  const name = repoShortName(repo.fullName);
  const single = repo.targets.length <= 1;

  return (
    <Tile
      title="Verlauf"
      icon="git"
      count={commits.data ? `${commits.data.length} Commits` : undefined}
      span={2}
      flush
      actions={
        branches.length > 1 ? (
          <SelectField
            label="Branch"
            className="app-inline-field"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            options={branches.map((b) => ({ value: b, label: b }))}
          />
        ) : undefined
      }
    >
      {commits.isError && !commits.data ? (
        <div className="app-pad">
          <FormError title={errorText(commits.error)} />
        </div>
      ) : !commits.data ? (
        <p className="app-empty app-pad">Lade Commits …</p>
      ) : commits.data.length === 0 ? (
        <p className="app-empty app-pad">Noch keine Commits auf {branch}.</p>
      ) : (
        commits.data.map((c) => {
          const liveNames = repo.targets
            .filter((t) => c.liveOn.includes(t.id))
            .map((t) => t.serverName);
          const back = rollbackTargets(repo, c);
          const time = formatAgo(new Date(c.at), now);
          return (
            <CommitRow
              key={c.sha}
              message={c.message}
              repo={name}
              branch={branch}
              hash={c.sha}
              time={
                single || !liveNames.length
                  ? `${time} · ${c.author}`
                  : `${time} · ${c.author} · live auf ${liveNames.join(', ')}`
              }
              status={c.ci}
              statusLabel={CI_ROW_LABEL[c.ci]}
              live={single ? liveNames.length > 0 : liveNames.length === repo.targets.length}
              action={
                back.length ? (
                  <span className="hz-row-actions">
                    {back.map((t) => (
                      <Button
                        key={t.id}
                        size="sm"
                        variant="danger"
                        disabled={deploying || t.deploying}
                        aria-label={`Rollback auf ${shortSha(c.sha)} auf ${t.serverName}`}
                        onClick={() => setConfirm({ commit: c, target: t })}
                      >
                        {single ? 'Rollback' : `Rollback ${t.serverName}`}
                      </Button>
                    ))}
                  </span>
                ) : undefined
              }
            />
          );
        })
      )}
      {confirm ? (
        <Dialog
          open
          onClose={() => setConfirm(null)}
          title={`Rollback von ${name} auf ${shortSha(confirm.commit.sha)}`}
        >
          <div className="hz-dialog-body">
            <p className="hz-dialog-text">
              {confirm.target.serverName} bekommt wieder „{confirm.commit.message}“. Neuere Commits
              bleiben auf GitHub und lassen sich danach wieder deployen.
            </p>
            <div className="hz-dialog-foot">
              <Button onClick={() => setConfirm(null)} data-autofocus="">
                Abbrechen
              </Button>
              <Button
                variant="danger"
                disabled={deploying}
                onClick={() => {
                  onDeploy({
                    targetIds: [confirm.target.id],
                    sha: confirm.commit.sha,
                    rollback: true,
                  });
                  setConfirm(null);
                }}
              >
                Rollback
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </Tile>
  );
}

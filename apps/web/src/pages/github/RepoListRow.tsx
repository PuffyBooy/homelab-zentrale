import type { RepoSummary } from '@hz/shared';
import type { ReactElement } from 'react';
import { Badge, Button, RepoRow } from '@hz/ui';
import {
  commitLine,
  deployedTo,
  isDeploying,
  repoBehind,
  repoShortName,
  showDeployButton,
} from '../../lib/github.js';

export interface RepoListRowProps {
  repo: RepoSummary;
  now: Date;
  /** Overview tile: short name (the login is the tile count), no details button. */
  compact?: boolean;
  deploying?: boolean;
  onDeploy?: () => void;
  onOpen?: () => void;
}

/**
 * RepoRow for one tracked repo. The primary "Deploy" sits in the action slot only with
 * green CI, a target that is behind and no deploy running (RepoRow.md, SPEC 7).
 */
export function RepoListRow({
  repo: r,
  now,
  compact,
  deploying,
  onDeploy,
  onOpen,
}: RepoListRowProps): ReactElement {
  const name = compact ? repoShortName(r.fullName) : r.fullName;
  const running = isDeploying(r);
  const canDeploy = !!onDeploy && showDeployButton(r);
  const action = (
    <>
      {running ? <Badge tone="info">Deploy läuft</Badge> : null}
      {canDeploy ? (
        <Button
          size="sm"
          variant="primary"
          disabled={deploying}
          aria-label={`${repoShortName(r.fullName)} deployen`}
          onClick={onDeploy}
        >
          Deploy
        </Button>
      ) : null}
      {onOpen && !compact ? (
        <Button size="sm" variant="ghost" aria-label={`${r.fullName} öffnen`} onClick={onOpen}>
          Details
        </Button>
      ) : null}
    </>
  );
  return (
    <RepoRow
      repo={name}
      branch={r.defaultBranch}
      commit={commitLine(r.lastCommit, now)}
      ci={r.ci}
      deployedTo={deployedTo(r)}
      behind={repoBehind(r)}
      action={action}
    />
  );
}

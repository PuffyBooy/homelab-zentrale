import type { ReactElement, ReactNode } from 'react';
import { Badge } from './Badge.js';
import { Icon } from './Icon.js';
import { StatusDot } from './StatusDot.js';

export type CiStatus = 'ok' | 'crit' | 'busy' | 'off';

export interface RepoRowProps {
  repo: string;
  branch?: string | undefined;
  commit: string;
  ci?: CiStatus | undefined;
  deployedTo?: string | null | undefined;
  behind?: number | undefined;
  action?: ReactNode;
}

const CI_LABEL: Record<CiStatus, string> = {
  ok: 'CI ✓',
  crit: 'CI ✗',
  busy: 'CI …',
  off: 'kein CI',
};

/** 1:1 port of RepoRow from design/reference/bundle.js. */
export function RepoRow({
  repo,
  branch,
  commit,
  ci,
  deployedTo,
  behind,
  action,
}: RepoRowProps): ReactElement {
  return (
    <div className="hz-row hz-repo">
      <Icon name="git" size={14} />
      <div className="hz-row-main">
        <span className="hz-row-name">
          {repo}
          <span className="hz-repo-branch">{branch || 'main'}</span>
        </span>
        <span className="hz-row-sub">
          {commit}
          <span className="hz-repo-target">
            {deployedTo ? ' → ' + deployedTo : ' · nicht deployt'}
          </span>
        </span>
      </div>
      <StatusDot status={ci || 'ok'} label={CI_LABEL[ci || 'ok']} />
      {behind ? (
        <Badge tone="accent">{behind + ' neu'}</Badge>
      ) : deployedTo ? (
        <Badge tone="ok">aktuell</Badge>
      ) : null}
      {action || null}
    </div>
  );
}

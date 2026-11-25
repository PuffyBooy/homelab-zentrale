import type { ReactElement, ReactNode } from 'react';
import { Badge } from './Badge.js';
import { StatusDot } from './StatusDot.js';
import type { Status } from './types.js';

export interface CommitRowProps {
  message: string;
  repo: string;
  branch?: string | undefined;
  hash: string;
  time: string;
  status?: Status | undefined;
  statusLabel?: string | undefined;
  live?: boolean | undefined;
  action?: ReactNode;
}

/** 1:1 port of CommitRow from design/reference/bundle.js. */
export function CommitRow({
  message,
  repo,
  branch,
  hash,
  time,
  status,
  statusLabel,
  live,
  action,
}: CommitRowProps): ReactElement {
  return (
    <div className="hz-row hz-commit">
      <code className="hz-hash">{(hash || '').slice(0, 7)}</code>
      <div className="hz-row-main">
        <span className="hz-row-name">{message}</span>
        <span className="hz-row-sub">{repo + '/' + (branch || 'main') + ' · ' + time}</span>
      </div>
      <StatusDot status={status || 'ok'} label={statusLabel} />
      {live ? <Badge tone="accent">LIVE</Badge> : action || null}
    </div>
  );
}

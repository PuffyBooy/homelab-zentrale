import type { ReactElement, ReactNode } from 'react';
import { StatusDot } from './StatusDot.js';
import type { IconName, Status } from './types.js';

export interface ServiceRowProps {
  name: string;
  host: string;
  status?: Status | undefined;
  /** Accepted for API parity with the reference; the reference does not render it. */
  icon?: IconName | undefined;
  meta?: ReactNode;
  actions?: ReactNode;
}

/** 1:1 port of ServiceRow from design/reference/bundle.js. */
export function ServiceRow({ name, host, status, meta, actions }: ServiceRowProps): ReactElement {
  return (
    <div className="hz-row">
      <StatusDot status={status || 'ok'} />
      <div className="hz-row-main">
        <span className="hz-row-name">{name}</span>
        <span className="hz-row-sub">{host}</span>
      </div>
      {meta ? <div className="hz-row-meta">{meta}</div> : null}
      {actions ? <div className="hz-row-actions">{actions}</div> : null}
    </div>
  );
}

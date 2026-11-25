import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';
import { StatusDot } from './StatusDot.js';
import type { Status } from './types.js';

export interface WebCheckRowProps {
  url: string;
  host?: string | undefined;
  status?: Status | undefined;
  code?: number | string | undefined;
  ms?: number | null | undefined;
  sslDays?: number | undefined;
  actions?: ReactNode;
}

/** 1:1 port of WebCheckRow from design/reference/bundle.js. */
export function WebCheckRow({
  url,
  host,
  status,
  code,
  ms,
  sslDays,
  actions,
}: WebCheckRowProps): ReactElement {
  const ssl = sslDays;
  return (
    <div className="hz-row hz-web">
      <StatusDot status={status || 'ok'} />
      <div className="hz-row-main">
        <span className="hz-row-name">{url}</span>
        {host ? <span className="hz-row-sub">{host}</span> : null}
      </div>
      <span className={cx('hz-web-code', Number(code) >= 400 && 'hz-t-crit')}>{code || '---'}</span>
      <span className={cx('hz-web-ms', ms != null && ms > 800 && 'hz-t-warn')}>
        {ms != null ? ms + ' ms' : '—'}
      </span>
      <span
        className={cx(
          'hz-web-ssl',
          ssl != null && ssl < 14 && (ssl < 5 ? 'hz-t-crit' : 'hz-t-warn'),
        )}
      >
        {ssl != null ? 'SSL ' + ssl + 'd' : 'SSL —'}
      </span>
      {actions ? <div className="hz-row-actions">{actions}</div> : null}
    </div>
  );
}

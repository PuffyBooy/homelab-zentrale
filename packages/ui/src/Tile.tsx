import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';
import { Icon } from './Icon.js';
import { StatusDot } from './StatusDot.js';
import type { IconName, Status } from './types.js';

export interface TileProps {
  count?: ReactNode;
  flush?: boolean | undefined;
  title?: ReactNode;
  icon?: IconName | undefined;
  status?: Status | undefined;
  statusLabel?: string | undefined;
  actions?: ReactNode;
  footer?: ReactNode;
  span?: 2 | 3 | 4 | undefined;
  children?: ReactNode;
  className?: string | undefined;
}

/** 1:1 port of Tile from design/reference/bundle.js. */
export function Tile({
  count,
  flush,
  title,
  icon,
  status,
  statusLabel,
  actions,
  footer,
  span,
  children,
  className,
}: TileProps): ReactElement {
  return (
    <section
      className={cx(
        'hz-tile',
        span && 'hz-span-' + span,
        status === 'crit' && 'hz-tile-crit',
        flush && 'hz-tile-flush',
        className,
      )}
    >
      {title || status || actions ? (
        <header className="hz-tile-head">
          <div className="hz-tile-title">
            {icon ? <Icon name={icon} size={12} /> : null}
            <span>{title}</span>
            {count != null ? <span className="hz-tile-count">{count}</span> : null}
          </div>
          <div className="hz-tile-meta">
            {status ? <StatusDot status={status} label={statusLabel} /> : null}
            {actions || null}
          </div>
        </header>
      ) : null}
      <div className="hz-tile-body">{children}</div>
      {footer ? <footer className="hz-tile-foot">{footer}</footer> : null}
    </section>
  );
}

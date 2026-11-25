import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

export type AlertTone = 'ok' | 'warn' | 'crit' | 'info';

export interface AlertProps {
  tone?: AlertTone | undefined;
  title: string;
  time?: string | undefined;
  floating?: boolean | undefined;
  action?: ReactNode;
  children?: ReactNode;
}

const LEVEL: Record<AlertTone, string> = { ok: 'OK', warn: 'WARN', crit: 'CRIT', info: 'INFO' };

/** 1:1 port of Alert from design/reference/bundle.js. */
export function Alert({ tone, title, time, floating, action, children }: AlertProps): ReactElement {
  const t = tone || 'info';
  return (
    <div
      className={cx('hz-alert', 'hz-alert-' + t, floating && 'hz-alert-floating')}
      role={t === 'crit' ? 'alert' : 'status'}
    >
      {time ? <span className="hz-alert-time">{time}</span> : null}
      <span className="hz-alert-lvl">{LEVEL[t]}</span>
      <div className="hz-alert-main">
        <span className="hz-alert-title">{title}</span>
        {children ? <span className="hz-alert-body">{children}</span> : null}
      </div>
      {action || null}
    </div>
  );
}

import type { ReactElement } from 'react';
import { cx } from './cx.js';
import type { Status } from './types.js';

export interface StatusDotProps {
  status?: Status | undefined;
  label?: string | undefined;
  hideLabel?: boolean | undefined;
  pulse?: boolean | undefined;
  className?: string | undefined;
}

/** Short mono tag shown next to the dot. */
export const STATUS_TAG: Record<Status, string> = {
  ok: 'UP',
  warn: 'WARN',
  crit: 'DOWN',
  off: 'OFF',
  info: 'INFO',
  busy: 'BOOT',
};

/** German long form for tooltip and screen readers. */
export const STATUS_LONG: Record<Status, string> = {
  ok: 'Läuft',
  warn: 'Warnung',
  crit: 'Ausgefallen',
  off: 'Gestoppt',
  info: 'Info',
  busy: 'Startet',
};

/** 1:1 port of StatusDot from design/reference/bundle.js. */
export function StatusDot({
  status,
  label,
  hideLabel,
  pulse,
  className,
}: StatusDotProps): ReactElement {
  const s = status || 'ok';
  return (
    <span className={cx('hz-status', 'hz-status-' + s, className)} title={label || STATUS_LONG[s]}>
      <span
        className={cx(
          'hz-dot',
          (s === 'crit' || s === 'busy') && pulse !== false && 'hz-dot-pulse',
        )}
        aria-hidden={true}
      />
      {hideLabel ? (
        <span className="hz-sr">{label || STATUS_LONG[s]}</span>
      ) : (
        <span className="hz-status-label">{label || STATUS_TAG[s]}</span>
      )}
    </span>
  );
}

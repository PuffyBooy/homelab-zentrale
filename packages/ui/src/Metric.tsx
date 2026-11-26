import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

export interface MetricProps {
  label: string;
  value: ReactNode;
  unit?: string | undefined;
  delta?: string | undefined;
  deltaTone?: 'ok' | 'warn' | 'crit' | undefined;
  hint?: string | undefined;
  size?: 'default' | 'wall' | undefined;
  className?: string | undefined;
}

/** 1:1 port of Metric from design/reference/bundle.js. */
export function Metric({
  label,
  value,
  unit,
  delta,
  deltaTone,
  hint,
  size,
  className,
}: MetricProps): ReactElement {
  return (
    <div className={cx('hz-metric', size === 'wall' && 'hz-metric-wall', className)}>
      <div className="hz-label">{label}</div>
      <div className="hz-metric-value">
        <span className="hz-num">{value}</span>
        {unit ? <span className="hz-unit">{unit}</span> : null}
      </div>
      {delta || hint ? (
        <div className="hz-metric-hint">
          {delta ? (
            <span className={cx('hz-delta', deltaTone && 'hz-delta-' + deltaTone)}>{delta}</span>
          ) : null}
          {hint ? <span>{hint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

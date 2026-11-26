import type { ReactElement } from 'react';

export interface BlockBarProps {
  value: number;
  cells?: number | undefined;
  warnAt?: number | undefined;
  critAt?: number | undefined;
  label?: string | undefined;
}

export type BlockTone = 'ok' | 'warn' | 'crit';

/** Threshold tone used by BlockBar (defaults: warn 75, crit 90). */
export function toneOf(v: number, warn: number, crit: number): BlockTone {
  return v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok';
}

/** 1:1 port of BlockBar from design/reference/bundle.js. */
export function BlockBar({ value, cells, warnAt, critAt, label }: BlockBarProps): ReactElement {
  const count = cells || 10;
  const v = Math.max(0, Math.min(100, value || 0));
  const n = Math.round((v / 100) * count);
  const tone = toneOf(v, warnAt == null ? 75 : warnAt, critAt == null ? 90 : critAt);
  const cs: ReactElement[] = [];
  for (let i = 0; i < count; i++) {
    cs.push(<i key={i} className={i < n ? 'hz-cell-on' : undefined} />);
  }
  return (
    <span
      className={'hz-blocks hz-blocks-' + tone}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
      aria-label={label}
    >
      {cs}
    </span>
  );
}

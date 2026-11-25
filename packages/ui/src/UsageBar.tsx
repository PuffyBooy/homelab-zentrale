import type { ReactElement } from 'react';
import { BlockBar } from './BlockBar.js';

export interface UsageBarProps {
  cells?: number | undefined;
  label: string;
  value: number;
  detail?: string | undefined;
  warnAt?: number | undefined;
  critAt?: number | undefined;
}

/** 1:1 port of UsageBar from design/reference/bundle.js. */
export function UsageBar({
  cells,
  label,
  value,
  detail,
  warnAt,
  critAt,
}: UsageBarProps): ReactElement {
  const v = Math.max(0, Math.min(100, value || 0));
  return (
    <div className="hz-usage">
      <span className="hz-usage-label">{label}</span>
      <BlockBar value={v} cells={cells || 20} warnAt={warnAt} critAt={critAt} label={label} />
      <span className="hz-usage-val">{detail || Math.round(v) + '%'}</span>
    </div>
  );
}

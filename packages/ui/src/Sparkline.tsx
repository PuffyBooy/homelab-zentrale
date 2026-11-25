import type { ReactElement } from 'react';
import { cx } from './cx.js';

export interface SparklineProps {
  data: number[];
  width?: number | undefined;
  height?: number | undefined;
  tone?: 'accent' | 'ok' | 'info' | 'muted' | undefined;
}

/** 1:1 port of Sparkline from design/reference/bundle.js. Renders nothing below two points. */
export function Sparkline({ data, width, height, tone }: SparklineProps): ReactElement | null {
  const d = data || [];
  const w = width || 120;
  const ht = height || 24;
  if (d.length < 2) return null;
  const mn = Math.min(...d);
  const mx = Math.max(...d);
  const r = mx - mn || 1;
  const bw = w / d.length;
  return (
    <svg
      className={cx('hz-spark', 'hz-spark-' + (tone || 'accent'))}
      width={w}
      height={ht}
      viewBox={'0 0 ' + w + ' ' + ht}
      aria-hidden={true}
    >
      {d.map((v, i) => {
        const bh = 2 + ((v - mn) / r) * (ht - 2);
        return (
          <rect
            key={i}
            x={i * bw}
            y={ht - bh}
            width={Math.max(1, bw - 1)}
            height={bh}
            className={i === d.length - 1 ? 'hz-spark-last' : 'hz-spark-bar'}
          />
        );
      })}
    </svg>
  );
}

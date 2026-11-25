import type { ReactElement } from 'react';
import { cx } from './cx.js';

export interface TerminalLine {
  text: string;
  kind?: 'cmd' | 'ok' | 'warn' | 'err' | 'dim' | undefined;
}

export interface TerminalProps {
  prompt?: string | undefined;
  title?: string | undefined;
  host?: string | undefined;
  lines: Array<string | TerminalLine>;
  height?: number | string | undefined;
  cursor?: boolean | undefined;
}

/** 1:1 port of Terminal from design/reference/bundle.js. */
export function Terminal({
  prompt,
  title,
  host,
  lines,
  height,
  cursor,
}: TerminalProps): ReactElement {
  return (
    <div className="hz-term">
      <div className="hz-term-head">
        <span>{title || 'konsole'}</span>
        {host ? <span className="hz-term-host">{host}</span> : null}
      </div>
      <pre className="hz-term-body" style={height ? { height } : undefined}>
        {(lines || []).map((l, i) => {
          const o: TerminalLine = typeof l === 'string' ? { text: l } : l;
          return (
            <div key={i} className={cx('hz-term-line', o.kind && 'hz-term-' + o.kind)}>
              {o.kind === 'cmd' ? (
                <span className="hz-term-prompt">{(prompt || '$') + ' '}</span>
              ) : null}
              {o.text}
            </div>
          );
        })}
        {cursor !== false ? <span className="hz-term-cursor" /> : null}
      </pre>
    </div>
  );
}

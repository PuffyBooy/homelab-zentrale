import type { ReactElement } from 'react';
import { cx } from './cx.js';

export interface GameTemplate {
  id: string;
  name: string;
  image: string;
  ram: string;
  port: number;
  fits?: boolean | undefined;
}

export interface GameTemplatesProps {
  templates: GameTemplate[];
  selected?: string | undefined;
  onPick?: ((id: string) => void) | undefined;
}

/** 1:1 port of GameTemplates from design/reference/bundle.js. */
export function GameTemplates({ templates, selected, onPick }: GameTemplatesProps): ReactElement {
  return (
    <div className="hz-tpl-grid">
      {(templates || []).map((t) => (
        <button
          key={t.id}
          type="button"
          className={cx('hz-tpl', t.id === selected && 'hz-tpl-on')}
          onClick={() => onPick?.(t.id)}
        >
          <span className="hz-tpl-name">{t.name}</span>
          <span className="hz-tpl-meta">{t.image}</span>
          <span className="hz-tpl-req">
            <span>{'RAM ' + t.ram}</span>
            <span>{':' + t.port}</span>
          </span>
          {t.fits === false ? <span className="hz-tpl-warn">zu wenig RAM frei</span> : null}
        </button>
      ))}
    </div>
  );
}

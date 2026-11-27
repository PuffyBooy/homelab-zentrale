import type { ReactElement } from 'react';
import { cx } from './cx.js';
import type { IconName } from './types.js';

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  href?: string | undefined;
  count?: number | undefined;
  /**
   * Shortcut shown left of the label. Defaults to the 1-based position (reference bundle).
   * An empty string leaves the key cap empty (items past the ninth have no digit).
   */
  key?: string | undefined;
}

export interface NavRailProps {
  items: NavItem[];
  active?: string | undefined;
  title?: string | undefined;
}

/** 1:1 port of NavRail from design/reference/bundle.js. */
export function NavRail({ items, active, title }: NavRailProps): ReactElement {
  return (
    <nav className="hz-nav" aria-label="Hauptnavigation">
      <div className="hz-nav-brand">
        <span className="hz-mark" aria-hidden={true}>
          <span />
        </span>
        <span>{title ?? 'homelab'}</span>
      </div>
      <ul>
        {items.map((it, i) => (
          <li key={it.id}>
            <a
              href={it.href ?? '#'}
              className={cx('hz-nav-item', it.id === active && 'hz-nav-active')}
              aria-current={it.id === active ? 'page' : undefined}
            >
              <span className="hz-nav-key" aria-hidden={it.key === '' ? true : undefined}>
                {it.key ?? String(i + 1)}
              </span>
              <span>{it.label}</span>
              {it.count ? <span className="hz-nav-count">{it.count}</span> : null}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { Icon, type NavItem } from '@hz/ui';
import { Dialog } from '../components/Dialog.js';
import { bottomBarIds, navItems, settingsItem } from '../nav.js';
import { ThemeButton } from './ThemeButton.js';

const inBar = (it: NavItem): boolean => (bottomBarIds as readonly string[]).includes(it.id);

export interface BottomBarProps {
  /** Visible nav items (switched-off modules left out). */
  items?: readonly NavItem[] | undefined;
  active: string;
  onNavigate: (to: string) => void;
  onSearch: () => void;
}

/** Phone navigation (< 700 px). Proposed for packages/ui as `BottomBar` (docs/QUESTIONS.md). */
export function BottomBar({
  items = navItems,
  active,
  onNavigate,
  onSearch,
}: BottomBarProps): ReactElement {
  const [more, setMore] = useState(false);
  const barItems = useMemo(() => items.filter(inBar), [items]);
  const moreItems = useMemo(() => items.filter((it) => !inBar(it)), [items]);
  const moreActive = !barItems.some((it) => it.id === active);

  return (
    <>
      <nav className="hz-bottombar" aria-label="Schnellnavigation">
        {barItems.map((it) => (
          <Link
            key={it.id}
            to={it.href ?? '/'}
            className="hz-bottombar-item"
            aria-current={it.id === active ? 'page' : undefined}
          >
            <Icon name={it.icon} size={18} />
            <span>{it.label}</span>
          </Link>
        ))}
        <button
          type="button"
          className="hz-bottombar-item"
          aria-haspopup="dialog"
          aria-expanded={more}
          aria-current={moreActive ? 'page' : undefined}
          onClick={() => setMore(true)}
        >
          <Icon name="plus" size={18} />
          <span>Mehr</span>
        </button>
      </nav>
      <Dialog open={more} onClose={() => setMore(false)} title="Mehr" className="hz-dialog-sheet">
        <div className="hz-dialog-body">
          <ul className="app-sheet-list">
            {[...moreItems, settingsItem].map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  className={it.id === active ? 'hz-nav-item hz-nav-active' : 'hz-nav-item'}
                  aria-current={it.id === active ? 'page' : undefined}
                  onClick={() => {
                    setMore(false);
                    onNavigate(it.href ?? '/');
                  }}
                >
                  <span className="hz-nav-key" aria-hidden={true} />
                  <span>{it.label}</span>
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className="hz-nav-item"
                onClick={() => {
                  setMore(false);
                  onSearch();
                }}
              >
                <span className="hz-nav-key" aria-hidden={true} />
                <span>Suchen</span>
              </button>
            </li>
            <li>
              <ThemeButton />
            </li>
          </ul>
        </div>
      </Dialog>
    </>
  );
}

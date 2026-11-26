import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { NavRail, ServerSwitch, cx } from '@hz/ui';
import { interceptLinks } from '../lib/links.js';
import { activeNavId, navItems, settingsItem, shortcutAction } from '../nav.js';
import { BottomBar } from './BottomBar.js';
import { CommandPalette } from './CommandPalette.js';
import { pageMeta } from './pageMeta.js';
import { ThemeButton } from './ThemeButton.js';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** No servers before M2: the switch only offers "Alle Server". */
const serverEntries = [{ id: 'all', name: 'Alle Server' }];

export function Shell(): ReactElement {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const active = activeNavId(pathname);
  const meta = pageMeta(pathname);

  const go = useCallback((to: string) => void navigate(to), [navigate]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const action = shortcutAction({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        target: e.target instanceof HTMLElement ? e.target : null,
      });
      if (!action) return;
      if (action.kind === 'palette') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      // Plain keys never act behind an open dialog.
      if (e.repeat || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      go(action.to);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  useEffect(() => {
    document.title = `${meta.title} · Homelab-Zentrale`;
  }, [meta.title]);

  return (
    <div className="hz-page app-shell">
      <div className="app-rail" onClick={interceptLinks(go)}>
        <NavRail items={navItems} active={active} title="homelab" />
        <div className="app-rail-foot">
          <button type="button" className="hz-nav-item" onClick={() => setPaletteOpen(true)}>
            <span className="hz-nav-key" aria-hidden={true} />
            <span>Suchen</span>
            <span className="app-rail-hint" aria-label={isMac ? 'Befehl K' : 'Steuerung K'}>
              {isMac ? '⌘K' : 'Strg K'}
            </span>
          </button>
          <a
            href={settingsItem.href}
            className={cx('hz-nav-item', active === settingsItem.id && 'hz-nav-active')}
            aria-current={active === settingsItem.id ? 'page' : undefined}
          >
            <span className="hz-nav-key" aria-hidden={true} />
            <span>{settingsItem.label}</span>
          </a>
          <ThemeButton />
        </div>
      </div>
      <main className="hz-page-main app-main" id="main">
        <header className="hz-page-top">
          <div>
            <h1 className="hz-page-title">{meta.title}</h1>
            <div className="hz-page-sub">{meta.sub}</div>
          </div>
          {meta.serverSwitch ? <ServerSwitch servers={serverEntries} active="all" /> : null}
        </header>
        <Outlet />
      </main>
      <BottomBar active={active} onNavigate={go} onSearch={() => setPaletteOpen(true)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onRun={go} />
    </div>
  );
}

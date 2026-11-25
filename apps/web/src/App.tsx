import type { ReactElement } from 'react';
import { useLocation } from 'react-router';
import { NavRail } from '@hz/ui';
import { activeNavId, navItems } from './nav.js';

export function App(): ReactElement {
  const { pathname } = useLocation();
  const active = activeNavId(pathname);
  const current = navItems.find((it) => it.id === active);

  return (
    <div className="hz-page">
      <NavRail items={navItems} active={active} title="homelab" />
      <main className="hz-page-main">
        <header className="hz-page-top">
          <div>
            <h1 className="hz-page-title">{current?.label ?? 'Übersicht'}</h1>
            <div className="hz-page-sub">Noch nichts verbunden.</div>
          </div>
        </header>
      </main>
    </div>
  );
}

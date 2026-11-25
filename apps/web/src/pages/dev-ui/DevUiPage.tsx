import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@hz/ui';
import { galleryCards } from './cards.js';

export type GalleryTheme = 'dark' | 'light' | 'wall';

const THEMES: Array<{ id: GalleryTheme; label: string }> = [
  { id: 'dark', label: 'Dunkel' },
  { id: 'light', label: 'Hell' },
  { id: 'wall', label: 'Wand' },
];

function isTheme(v: string | null | undefined): v is GalleryTheme {
  return v === 'dark' || v === 'light' || v === 'wall';
}

function initialTheme(): GalleryTheme {
  const fromQuery = new URLSearchParams(window.location.search).get('theme');
  if (isTheme(fromQuery)) return fromQuery;
  const current = document.documentElement.dataset.theme;
  return isTheme(current) ? current : 'dark';
}

/**
 * Dev-only component gallery (`/dev/ui`). One card per design/reference/previews/*.html,
 * each marked with `data-card="<Name>"`, plus a theme switch that sets `data-theme` on <html>.
 */
export function DevUiPage(): ReactElement {
  const [theme, setTheme] = useState<GalleryTheme>(initialTheme);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = theme;
    return () => {
      if (previous === undefined) delete root.dataset.theme;
      else root.dataset.theme = previous;
    };
  }, [theme]);

  return (
    <main className="hz-demo-col">
      <header className="hz-page-top">
        <div>
          <h1 className="hz-page-title">UI-Galerie</h1>
          <div className="hz-page-sub">
            {galleryCards.length} Vorschauen aus design/reference · nur im Dev-Modus
          </div>
        </div>
        <div className="hz-demo" role="group" aria-label="Theme">
          {THEMES.map((t) => (
            <Button
              key={t.id}
              size="sm"
              variant={t.id === theme ? 'primary' : 'ghost'}
              aria-pressed={t.id === theme}
              data-theme-option={t.id}
              onClick={() => setTheme(t.id)}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </header>
      {galleryCards.map(({ name, rootClass, Demo }) => (
        <section key={name} data-card={name} aria-labelledby={'card-' + name}>
          <h2 className="hz-label" id={'card-' + name}>
            {name}
          </h2>
          <div className={rootClass || undefined} data-preview-root="">
            <Demo />
          </div>
        </section>
      ))}
    </main>
  );
}

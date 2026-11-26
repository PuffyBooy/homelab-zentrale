import { useEffect, type ReactElement } from 'react';
import { useLocation } from 'react-router';

/** Anchors of the server detail (ROADMAP M16). The ids sit on the tiles' wrappers. */
export const SERVER_SECTIONS: readonly { id: string; label: string }[] = [
  { id: 'ueberblick', label: 'Überblick' },
  { id: 'verlauf', label: 'Verlauf' },
  { id: 'speicher', label: 'Speicher' },
  { id: 'dienste', label: 'Dienste' },
  { id: 'prozesse', label: 'Prozesse' },
  { id: 'updates', label: 'Updates' },
  { id: 'aktionen', label: 'Aktionen' },
];

/** Same look as the settings section links; plain anchors, so keyboard and history work. */
export function ServerSectionNav(): ReactElement {
  const { hash } = useLocation();
  // Links from elsewhere (Settings → Updates opens #updates) land on the section.
  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1));
    if (SERVER_SECTIONS.some((s) => s.id === id)) {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    }
  }, [hash]);
  return (
    <nav id="ueberblick" className="app-settings-nav app-anchor" aria-label="Bereiche des Servers">
      {SERVER_SECTIONS.map((s) => (
        <a key={s.id} href={`#${s.id}`} className="app-settings-link">
          {s.label}
        </a>
      ))}
    </nav>
  );
}

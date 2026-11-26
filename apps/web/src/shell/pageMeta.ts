import { navItems, settingsItem } from '../nav.js';

export interface PageMeta {
  /** Statussatz in the display style. Problems first once there is data (M2+). */
  title: string;
  sub: string;
  /** Pages that can be filtered by server show the ServerSwitch. */
  serverSwitch: boolean;
}

export function pageMeta(pathname: string): PageMeta {
  if (pathname === '/') {
    return { title: 'Noch nichts verbunden.', sub: 'Übersicht · 0 Server', serverSwitch: true };
  }
  if (pathname === settingsItem.href) {
    return { title: 'Einstellungen', sub: 'Konto und Sitzungen', serverSwitch: false };
  }
  const item = navItems.find((it) => it.href === pathname);
  if (item) return { title: item.label, sub: 'Noch nichts verbunden.', serverSwitch: true };
  return { title: 'Seite nicht gefunden.', sub: pathname, serverSwitch: false };
}

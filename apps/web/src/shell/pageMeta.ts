import type { Alert, ServerSummary } from '@hz/shared';
import { formatTime, plural } from '../lib/format.js';
import type { LiveState } from '../lib/live.js';
import {
  ALL_SERVERS,
  serverSentence,
  statusSentence,
  type StatusSentence,
} from '../lib/servers.js';
import { navItems, settingsItem } from '../nav.js';

export interface PageMeta {
  /** Statussatz in the display style. Problems first. */
  title: StatusSentence;
  sub: string;
  /** Pages that can be filtered by server show the ServerSwitch. */
  serverSwitch: boolean;
}

export interface PageData {
  servers?: ServerSummary[] | undefined;
  alerts?: Alert[] | undefined;
  /** Server filter from the ServerSwitch, or the id of the detail page. */
  filter?: string | undefined;
  live?: LiveState | undefined;
  /** Time of the last live message, for "aktualisiert 23:04". */
  updatedAt?: Date | null | undefined;
}

const plain = (rest: string): StatusSentence => ({ em: null, rest });

/** Mono line under the Statussatz: live state first. */
function liveSub(area: string, data: PageData): string {
  const n = data.servers?.length ?? 0;
  const parts = [area, plural(n, 'Server', 'Server')];
  if (data.live === 'open') {
    parts.push(data.updatedAt ? `live · ${formatTime(data.updatedAt)}` : 'live');
  } else if (data.live === 'connecting') {
    parts.push('verbindet …');
  } else if (data.live === 'closed') {
    parts.push('Live-Verbindung getrennt · neuer Versuch läuft');
  }
  return parts.join(' · ');
}

export function serverDetailId(pathname: string): string | null {
  const m = /^\/servers\/([A-Za-z0-9_-]{1,64})\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

export function pageMeta(pathname: string, data: PageData = {}): PageMeta {
  const servers = data.servers ?? [];
  const filtered =
    data.filter && data.filter !== ALL_SERVERS
      ? servers.find((s) => s.id === data.filter)
      : undefined;

  if (pathname === '/' || pathname === '/servers') {
    const area = pathname === '/' ? 'Übersicht' : 'Server';
    if (data.servers === undefined) {
      return {
        title: plain(pathname === '/' ? 'Übersicht' : 'Server'),
        sub: 'lädt …',
        serverSwitch: true,
      };
    }
    const title = filtered ? serverSentence(filtered) : statusSentence(servers, data.alerts);
    if (servers.length === 0 && pathname === '/servers') {
      return { title: plain('Server'), sub: 'Noch nichts verbunden.', serverSwitch: true };
    }
    return { title, sub: liveSub(area, data), serverSwitch: true };
  }

  const detailId = serverDetailId(pathname);
  if (detailId) {
    const s = servers.find((x) => x.id === detailId);
    if (!s) return { title: plain('Server'), sub: 'lädt …', serverSwitch: true };
    return { title: serverSentence(s), sub: liveSub('Server', data), serverSwitch: true };
  }

  if (pathname === settingsItem.href) {
    return { title: plain('Einstellungen'), sub: 'Konto und Sitzungen', serverSwitch: false };
  }
  if (pathname === '/alerts') {
    const open = (data.alerts ?? []).filter((a) => a.state === 'open').length;
    return {
      title: open
        ? { em: plural(open, 'offene Meldung', 'offene Meldungen'), rest: '' }
        : plain('Keine offenen Meldungen.'),
      sub: 'Meldungen',
      serverSwitch: false,
    };
  }
  const item = navItems.find((it) => it.href === pathname);
  if (item) return { title: plain(item.label), sub: 'Noch keine Daten.', serverSwitch: false };
  return { title: plain('Seite nicht gefunden.'), sub: pathname, serverSwitch: false };
}

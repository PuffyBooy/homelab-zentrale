import type { Alert, CheckSummary, ContainerSummary, ServerSummary } from '@hz/shared';
import { checkMatchesServer, checkSentence, checksSentence, KIND_LABEL } from '../lib/checks.js';
import { containerSentence, containerStateText } from '../lib/containers.js';
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
  /** Only read on the container pages. */
  containers?: ContainerSummary[] | undefined;
  /** Only read on the websites pages. */
  checks?: CheckSummary[] | undefined;
  /** Server filter from the ServerSwitch, or the id of the detail page. */
  filter?: string | undefined;
  live?: LiveState | undefined;
  /** Time of the last live message, for "aktualisiert 23:04". */
  updatedAt?: Date | null | undefined;
}

const plain = (rest: string): StatusSentence => ({ em: null, rest });

/** Mono line under the Statussatz: live state first. */
function liveSub(area: string, data: PageData, count?: string): string {
  const n = data.servers?.length ?? 0;
  const parts = [area, count ?? plural(n, 'Server', 'Server')];
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

export function containerLogsId(pathname: string): string | null {
  const m = /^\/containers\/([A-Za-z0-9_-]{8,64})\/logs\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

export function checkDetailId(pathname: string): string | null {
  const m = /^\/websites\/([A-Za-z0-9_-]{8,64})\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

/** Pages that read the check list in the shell header. */
export function needsChecks(pathname: string): boolean {
  return pathname === '/websites' || checkDetailId(pathname) !== null;
}

/** Pages that read the container list in the shell header. */
export function needsContainers(pathname: string): boolean {
  return pathname === '/containers' || containerLogsId(pathname) !== null;
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

  if (pathname === '/containers') {
    if (data.servers === undefined || data.containers === undefined) {
      return { title: plain('Container'), sub: 'lädt …', serverSwitch: true };
    }
    const list = filtered
      ? data.containers.filter((c) => c.serverId === filtered.id)
      : data.containers;
    return { title: containerSentence(list), sub: liveSub('Container', data), serverSwitch: true };
  }

  const logsId = containerLogsId(pathname);
  if (logsId) {
    const c = data.containers?.find((x) => x.id === logsId);
    if (!c) return { title: plain('Logs'), sub: 'lädt …', serverSwitch: false };
    return {
      title: containerStateText(c),
      sub: `Logs · ${c.serverName} · ${c.image}`,
      serverSwitch: false,
    };
  }

  if (pathname === '/websites') {
    if (data.checks === undefined) {
      return { title: plain('Websites'), sub: 'lädt …', serverSwitch: true };
    }
    const list = filtered
      ? data.checks.filter((c) => checkMatchesServer(c, filtered.id))
      : data.checks;
    return {
      title: checksSentence(list),
      sub: liveSub('Websites', data, plural(list.length, 'Check', 'Checks')),
      serverSwitch: true,
    };
  }

  const checkId = checkDetailId(pathname);
  if (checkId) {
    const c = data.checks?.find((x) => x.id === checkId);
    if (!c) return { title: plain('Website'), sub: 'lädt …', serverSwitch: false };
    const where =
      c.def.runFrom === 'core'
        ? 'von der Zentrale'
        : `von ${servers.find((s) => s.id === c.def.runFrom)?.name ?? 'Agent'}`;
    return {
      title: checkSentence(c),
      sub: `Website · ${KIND_LABEL[c.def.kind]} · ${where}`,
      serverSwitch: false,
    };
  }

  if (pathname === settingsItem.href) {
    return { title: plain('Einstellungen'), sub: 'Konto, Sitzungen und Push', serverSwitch: false };
  }
  if (pathname === '/alerts') {
    const open = (data.alerts ?? []).filter(
      (a) => a.state === 'open' && (!filtered || a.serverId === filtered.id),
    ).length;
    const where = filtered ? ` auf ${filtered.name}` : '';
    return {
      title: open
        ? { em: plural(open, 'offene Meldung', 'offene Meldungen') + where, rest: '' }
        : plain(`Keine offenen Meldungen${where}.`),
      sub: 'Meldungen · gleicher Text wie die Push am Handy',
      serverSwitch: true,
    };
  }
  const item = navItems.find((it) => it.href === pathname);
  if (item) return { title: plain(item.label), sub: 'Noch keine Daten.', serverSwitch: false };
  return { title: plain('Seite nicht gefunden.'), sub: pathname, serverSwitch: false };
}

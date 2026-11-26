import type { AlertLevel, Thresholds } from '@hz/shared';
import type { AlertService } from '../alerts/service.js';
import { celsius, clockTime, clockTimeRelative, duration, percent } from '../format.js';
import { AGENT_CONTAINER } from './enroll-snippet.js';
import { reasonCategory, type EvaluatedReason, type StatusResult } from './status.js';

/** Alert categories per server; key `server:<id>:<category>`. */
export const SERVER_ALERT_CATEGORIES = [
  'offline',
  'disk',
  'ram',
  'cpu',
  'temp',
  'updates',
  'reboot',
] as const;
export type ServerAlertCategory = (typeof SERVER_ALERT_CATEGORIES)[number];

export const serverAlertKey = (serverId: string, cat: ServerAlertCategory): string =>
  `server:${serverId}:${cat}`;

export interface AlertContext {
  serverId: string;
  name: string;
  connected: boolean;
  now: number;
  thresholds: Thresholds;
  /** Current values for OK texts. */
  current: {
    cpu: number | null;
    ramPct: number | null;
    diskPct: number | null;
    temp: number | null;
  };
}

/** Title = Was + Wo, body = seit wann + was hilft (design/README.md). */
export function alertText(r: EvaluatedReason, c: AlertContext): { title: string; body: string } {
  const { name, now, thresholds: t } = c;
  const since = r.since ?? now;
  switch (r.code) {
    case 'offline':
      return {
        title: `${name} ist offline`,
        body: `Seit ${clockTimeRelative(since, now)} keine Meldung vom Agent. Prüf, ob der Container ${AGENT_CONTAINER} läuft.`,
      };
    case 'disk_crit':
    case 'disk_warn': {
      const limit = r.code === 'disk_crit' ? t.diskCrit : t.diskWarn;
      return {
        title: `Disk ${r.mount ?? '/'} auf ${name} bei ${percent(r.value ?? 0)}`,
        body: `Seit ${clockTime(now)} über ${limit} %. Aufräumen im Serverdetail zeigt, was frei wird.`,
      };
    }
    case 'ram_crit':
    case 'ram_warn': {
      const limit = r.code === 'ram_crit' ? t.ramCrit : t.ramWarn;
      return {
        title: `RAM auf ${name} bei ${percent(r.value ?? 0)}`,
        body: `Seit ${clockTime(since)} über ${limit} %. Prüf die Container mit dem höchsten Speicherverbrauch.`,
      };
    }
    case 'cpu_warn':
      return {
        title: `CPU auf ${name} bei ${percent(r.value ?? 0)}`,
        body: `Seit ${clockTime(since)} über ${t.cpuWarn} %. Prüf die Container mit der höchsten Last.`,
      };
    case 'temp_warn':
      return {
        title: `Temperatur auf ${name} bei ${celsius(r.value ?? 0)}`,
        body: `Seit ${clockTime(now)} über ${t.tempWarn} °C. Prüf Lüfter und Last.`,
      };
    case 'security_updates': {
      const n = r.value ?? 0;
      return {
        title: n === 1 ? `1 Sicherheitsupdate auf ${name}` : `${n} Sicherheitsupdates auf ${name}`,
        body: `Seit ${clockTime(now)} offen. Einspielen mit apt upgrade auf dem Server.`,
      };
    }
    case 'reboot_required':
      return {
        title: `${name} braucht einen Neustart`,
        body: `Seit ${clockTime(now)} nach Updates nötig. Neustart im Serverdetail.`,
      };
    case 'never_seen':
      return {
        title: `${name} hat sich noch nicht gemeldet`,
        body: `Prüf, ob der Container ${AGENT_CONTAINER} läuft.`,
      };
  }
}

function okText(
  cat: ServerAlertCategory,
  c: AlertContext,
  openedAt: number,
): { title: string; body: string } {
  const { name, now, current } = c;
  const at = clockTime(now);
  const val = (v: number | null): string => (v === null ? '' : ` bei ${percent(v)}`);
  switch (cat) {
    case 'offline':
      return {
        title: `${name} ist wieder online`,
        body: `Seit ${at} wieder verbunden, nach ${duration(now - openedAt)} offline.`,
      };
    case 'disk':
      return { title: `Disk auf ${name} wieder${val(current.diskPct)}`, body: `Seit ${at}.` };
    case 'ram':
      return { title: `RAM auf ${name} wieder${val(current.ramPct)}`, body: `Seit ${at}.` };
    case 'cpu':
      return { title: `CPU auf ${name} wieder${val(current.cpu)}`, body: `Seit ${at}.` };
    case 'temp':
      return {
        title:
          current.temp === null
            ? `Temperatur auf ${name} wieder normal`
            : `Temperatur auf ${name} wieder bei ${celsius(current.temp)}`,
        body: `Seit ${at}.`,
      };
    case 'updates':
      return { title: `Sicherheitsupdates auf ${name} eingespielt`, body: `Seit ${at}.` };
    case 'reboot':
      return {
        title: `${name} wurde neu gestartet`,
        body: `Seit ${at} ist kein Neustart mehr nötig.`,
      };
  }
}

/**
 * Alert level of a reason. "Sicherheitsupdates offen" and "Neustart nötig" are
 * `info` alerts (no push, decision 2026-11-26), although the server status still
 * shows WARN for them (SPEC 5.1).
 */
export function alertLevelOf(cat: ServerAlertCategory, r: EvaluatedReason): AlertLevel {
  if (cat === 'updates' || cat === 'reboot') return 'info';
  return r.level as AlertLevel;
}

/**
 * Turns the status of one server into alerts: one per category, raised while
 * the reason exists, resolved with an OK alert once it is gone.
 *
 * While the server is offline the metric values are stale, so only the offline
 * alert changes. The offline alert itself is resolved only by a real connection
 * (not by the boot grace period after a core restart).
 */
export function syncServerAlerts(
  alerts: AlertService,
  result: StatusResult,
  c: AlertContext,
): void {
  const byCat = new Map<string, EvaluatedReason>();
  for (const r of result.reasons) {
    if (r.code !== 'never_seen') byCat.set(reasonCategory(r.code), r);
  }
  const offline = byCat.has('offline');
  for (const cat of SERVER_ALERT_CATEGORIES) {
    const key = serverAlertKey(c.serverId, cat);
    const r = byCat.get(cat);
    if (r) {
      const { title, body } = alertText(r, c);
      alerts.raise(key, alertLevelOf(cat, r), title, body, c.serverId, 'server');
      continue;
    }
    if (cat !== 'offline' && (offline || result.status === 'off')) continue;
    if (cat === 'offline' && !c.connected) continue;
    const active = alerts.active(key);
    if (active) alerts.resolve(key, okText(cat, c, Date.parse(active.openedAt)));
  }
}

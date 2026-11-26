import type { ContainerHealth, ContainerState, ContainerStatus } from '@hz/shared';
import { clockTime } from '../format.js';

/** What the admin last did to a container through the core. */
export type ContainerIntent = 'stop' | 'restart';

/**
 * How long an intent counts. A stop through the core is reported as "gestoppt"
 * (info) instead of "ausgefallen" (crit); during a restart or image update the
 * short downtime raises no alert at all.
 */
export const INTENT_TTL_MS = 15 * 60_000;
/** An OOM event belongs to the `die` that follows within this window. */
export const OOM_TTL_MS = 2 * 60_000;

export interface StatusInput {
  state: ContainerState;
  health: ContainerHealth;
  exitCode: number | null;
  /** Active intent (already checked against INTENT_TTL_MS). */
  intent: ContainerIntent | null;
}

/**
 * UI status of a container:
 * - running: healthy/none -> ok, health starting -> busy, unhealthy -> crit
 * - restarting (restart loop of the restart policy), paused -> warn
 * - removing -> busy
 * - exited 0, created, or stopped on purpose through the core -> off
 * - exited != 0, dead -> crit
 */
export function containerStatus(c: StatusInput): ContainerStatus {
  switch (c.state) {
    case 'running':
      if (c.health === 'unhealthy') return 'crit';
      if (c.health === 'starting') return 'busy';
      return 'ok';
    case 'restarting':
    case 'paused':
      return 'warn';
    case 'removing':
      return 'busy';
    case 'created':
      return 'off';
    case 'exited':
      if (c.intent !== null) return 'off';
      return c.exitCode === null || c.exitCode === 0 ? 'off' : 'crit';
    case 'dead':
      return 'crit';
  }
}

/** Short German status line for the UI. */
export function containerStatusText(c: StatusInput): string {
  switch (c.state) {
    case 'running':
      if (c.health === 'unhealthy') return 'läuft, Healthcheck schlägt fehl';
      if (c.health === 'starting') return 'startet';
      return 'läuft';
    case 'restarting':
      return 'startet neu';
    case 'paused':
      return 'pausiert';
    case 'removing':
      return 'wird entfernt';
    case 'created':
      return 'angelegt, nicht gestartet';
    case 'exited': {
      const code = c.exitCode === null ? '' : ` (Exit-Code ${c.exitCode})`;
      return c.intent === 'stop' ? `gestoppt${code}` : `beendet${code}`;
    }
    case 'dead':
      return c.exitCode === null
        ? 'ausgefallen (dead)'
        : `ausgefallen (dead, Exit-Code ${c.exitCode})`;
  }
}

/**
 * Alert class of a container state:
 * - `down`: crit alert ("ist ausgefallen")
 * - `stopped`: info alert ("gestoppt")
 * - `up`: running, the alert of this container is resolved
 * - `none`: no opinion (restarting, paused, created, during a restart or update)
 */
export type AlertClass = 'down' | 'stopped' | 'up' | 'none';

export interface AlertInput extends StatusInput {
  /** An OOM event was seen shortly before. */
  oom: boolean;
}

export function alertClass(c: AlertInput): AlertClass {
  if (c.state === 'running') return c.health === 'unhealthy' ? 'down' : 'up';
  if (c.state !== 'exited' && c.state !== 'dead') return 'none';
  if (c.intent === 'restart') return 'none';
  if (c.intent === 'stop') return 'stopped';
  if (c.state === 'dead' || c.oom) return 'down';
  return c.exitCode === null || c.exitCode === 0 ? 'stopped' : 'down';
}

export const containerAlertKey = (serverId: string, name: string): string =>
  `container:${serverId}:${name}`;

export interface AlertText {
  title: string;
  body: string;
}

/** Texts of the crit alert (Was + Wo / Seit wann + was hilft). */
export function downText(c: AlertInput, name: string, server: string, now: number): AlertText {
  const title = `${name} auf ${server} ist ausgefallen`;
  const code = c.exitCode === null ? '' : `, Exit-Code ${c.exitCode}`;
  const since = clockTime(now);
  if (c.state === 'running') {
    return { title, body: `Seit ${since} schlägt der Healthcheck fehl. Prüf die Logs.` };
  }
  if (c.oom) {
    return {
      title,
      body: `Seit ${since} beendet: zu wenig Speicher (OOM)${code}. Prüf das Speicherlimit und die Logs.`,
    };
  }
  if (c.state === 'dead') {
    return { title, body: `Seit ${since} im Zustand dead${code}. Prüf die Logs und starte neu.` };
  }
  return { title, body: `Seit ${since} beendet${code}. Prüf die Logs und starte neu.` };
}

export function stoppedText(c: AlertInput, name: string, server: string, now: number): AlertText {
  const title = `${name} auf ${server} gestoppt`;
  if (c.intent === 'stop') {
    return { title, body: `Um ${clockTime(now)} über die Zentrale gestoppt.` };
  }
  return { title, body: `Um ${clockTime(now)} mit Exit-Code 0 beendet.` };
}

export function upText(name: string, server: string, now: number): AlertText {
  return {
    title: `${name} auf ${server} läuft wieder`,
    body: `Seit ${clockTime(now)} wieder in Betrieb.`,
  };
}

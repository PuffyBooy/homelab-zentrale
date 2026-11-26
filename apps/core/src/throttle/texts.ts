import { throttleAlertKeyPrefix } from '@hz/shared';
import { clockTime, duration, percent } from '../format.js';

/**
 * German alert texts of the rule set (SPEC 6a): "minecraft gedrosselt:
 * heimserver CPU 96 % seit 2 Min". Numbers in de-AT format.
 */

const cpusFmt = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 2 });

/** `1 Kern`, `1,5 Kerne`. */
export function cores(cpus: number): string {
  return `${cpusFmt.format(cpus)} ${cpus === 1 ? 'Kern' : 'Kerne'}`;
}

export const throttleKey = (serverId: string, name: string): string =>
  `${throttleAlertKeyPrefix.throttle}:${serverId}:${name}`;
export const autoStopKey = (serverId: string, name: string): string =>
  `${throttleAlertKeyPrefix.autoStop}:${serverId}:${name}`;
export const autoRestartKey = (serverId: string, name: string): string =>
  `${throttleAlertKeyPrefix.autoRestart}:${serverId}:${name}`;

export interface Load {
  metric: 'CPU' | 'RAM';
  value: number;
}

/** "heimserver CPU 96 % seit 2 Min" (max 200 characters, see throttledSchema). */
export function loadReason(serverName: string, load: Load, sinceMs: number): string {
  return `${serverName} ${load.metric} ${percent(load.value)} seit ${duration(sinceMs)}`.slice(
    0,
    200,
  );
}

export function throttledText(
  name: string,
  reason: string,
  cpus: number,
  now: number,
): { title: string; body: string } {
  return {
    title: `${name} gedrosselt: ${reason}`,
    body: `Auf ${cores(cpus)} begrenzt (${clockTime(now)}). Wird aufgehoben, wenn der Server wieder Luft hat.`,
  };
}

export function unthrottledText(
  name: string,
  serverName: string,
  now: number,
): { title: string; body: string } {
  return {
    title: `${name} nicht mehr gedrosselt`,
    body: `${serverName} ist wieder unter der Schwelle (${clockTime(now)}).`,
  };
}

export function autoStoppedText(
  name: string,
  reason: string,
  now: number,
): { title: string; body: string } {
  return {
    title: `${name} gestoppt: ${reason}`,
    body: `Automatisch gestoppt um ${clockTime(now)}. Startet nicht von selbst, „Wieder starten“ in dieser Meldung.`,
  };
}

export function startedAgainText(name: string, now: number): { title: string; body: string } {
  return { title: `${name} läuft wieder`, body: `Seit ${clockTime(now)} wieder gestartet.` };
}

export function autoRestartedText(
  name: string,
  serverName: string,
  attempt: number,
  max: number,
  now: number,
): { title: string; body: string } {
  return {
    title: `${name} neu gestartet: ${serverName}`,
    body: `Wichtiger Container war gestoppt, um ${clockTime(now)} neu gestartet (Versuch ${attempt} von ${max}).`,
  };
}

export function restartFailedText(
  name: string,
  serverName: string,
  max: number,
  windowMin: number,
): { title: string; body: string } {
  return {
    title: `${name} startet nicht: ${serverName}`,
    body: `Wichtiger Container: ${max} Startversuche in ${windowMin} Min ohne Erfolg. Bitte von Hand prüfen.`,
  };
}

export const ADMIN_REASON = 'Von Hand gedrosselt';

export function scheduleReason(cpus: number): string {
  return `Zeitplan: höchstens ${cores(cpus)}`;
}

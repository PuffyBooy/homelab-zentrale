import type { AlertLevel, SystemUpgradeData, UpdateRun } from '@hz/shared';
import { clockTime } from '../format.js';

/** Dedupe key per server and target: a later success resolves an open problem. */
export const updateAlertKey = (serverId: string, target: UpdateRun['target']): string =>
  `update:${serverId}:${target}`;

export interface UpdateAlert {
  key: string;
  level: AlertLevel;
  title: string;
  body: string;
}

const short = (s: string | null, max = 120): string =>
  s === null ? '' : s.length > max ? `${s.slice(0, max - 1)}…` : s;

/**
 * The agent reports a failed rollback (nothing runs any more) with a message
 * starting with "rollback failed:" (agent protocol, update_result).
 */
export function rollbackFailed(message: string | null): boolean {
  return message !== null && message.trimStart().toLowerCase().startsWith('rollback failed:');
}

/** "Update des Agents auf pi", "Update der Zentrale", ... */
function subject(run: UpdateRun): string {
  switch (run.target) {
    case 'agent':
      return `Update des Agents auf ${run.serverName}`;
    case 'core':
      return 'Update der Zentrale';
    case 'os':
      return `Update der OS-Pakete auf ${run.serverName}`;
    case 'reboot':
      return `Neustart von ${run.serverName}`;
  }
}

function fromTo(run: UpdateRun): string {
  return run.from && run.to && run.from !== run.to ? `: ${run.from} → ${run.to}` : '';
}

/**
 * Alert for a finished run (German, short): info on success, warn on rollback
 * and timeout, crit when the update failed. up_to_date only resolves an open
 * problem (no new entry, the daily runs would spam).
 */
export function updateAlert(
  run: UpdateRun,
  now: number,
  upgrade?: SystemUpgradeData,
): UpdateAlert | null {
  const key = updateAlertKey(run.serverId, run.target);
  const at = clockTime(now);
  const name = run.serverName;
  switch (run.status) {
    case 'running':
      return null;
    case 'updated': {
      if (run.target === 'agent') {
        return {
          key,
          level: 'info',
          title: `Agent auf ${name} aktualisiert${fromTo(run)}`,
          body: `Seit ${at} läuft die neue Version.`,
        };
      }
      if (run.target === 'core') {
        return {
          key,
          level: 'info',
          title: `Zentrale aktualisiert${fromTo(run)}`,
          body: `Seit ${at} läuft die neue Version auf ${name}.`,
        };
      }
      if (run.target === 'os') {
        return {
          key,
          level: 'info',
          title: `OS-Pakete auf ${name}: ${upgrade?.upgraded ?? 0} aktualisiert`,
          body: upgrade?.rebootRequired ? `Seit ${at}. Ein Neustart ist nötig.` : `Seit ${at}.`,
        };
      }
      return {
        key,
        level: 'info',
        title: `${name} neu gestartet`,
        body: `Seit ${at} nach Updates.`,
      };
    }
    case 'up_to_date':
      return {
        key,
        level: 'ok',
        title:
          run.target === 'core'
            ? 'Zentrale ist aktuell'
            : run.target === 'agent'
              ? `Agent auf ${name} ist aktuell`
              : `OS-Pakete auf ${name} sind aktuell`,
        body: `Seit ${at}.`,
      };
    case 'rolled_back':
      return {
        key,
        level: 'warn',
        title: `${subject(run)} zurückgerollt${run.message ? `: ${short(run.message)}` : ''}`,
        body: `Seit ${at} läuft wieder die alte Version.`,
      };
    case 'timeout':
      return {
        key,
        level: 'warn',
        title: `${subject(run)} ohne Ergebnis`,
        body: `${run.message ? `${short(run.message, 200)}. ` : 'Keine Rückmeldung vom Agent. '}Prüf den Server im Serverdetail (seit ${at}).`,
      };
    case 'failed':
      return {
        key,
        // crit only when nothing runs any more (the rollback itself failed);
        // otherwise the old version still runs: warn.
        level: rollbackFailed(run.message) ? 'crit' : 'warn',
        title: rollbackFailed(run.message)
          ? `${subject(run)} fehlgeschlagen, Rollback misslungen`
          : `${subject(run)} fehlgeschlagen`,
        body: `${run.message ? `${short(run.message, 200)}. ` : ''}Prüf den Server im Serverdetail (seit ${at}).`,
      };
  }
}

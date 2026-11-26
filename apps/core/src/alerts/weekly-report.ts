import { nextWallClock } from '../calendar.js';
import { formatPercent } from '../checks/evaluate.js';

/** Sunday 19:00 Europe/Vienna (SPEC 9). */
export const WEEKLY_REPORT_RULE = { weekday: 0, hour: 19, minute: 0 } as const;

export function nextWeeklyReport(from: number): number {
  return nextWallClock(from, WEEKLY_REPORT_RULE);
}

export interface WeeklyReportInput {
  openAlerts: number;
  /** Enabled checks with their uptime over 7 days (null without data). */
  checks: readonly { name: string; uptime: number | null }[];
  serversOffline: number;
  serversTotal: number;
  /** Deploys of the last 7 days; null/undefined if no deploy target exists. */
  deploys?: { ok: number; failed: number } | null;
}

/** German summary for the info push and the alert log. */
export function weeklyReportText(i: WeeklyReportInput): { title: string; body: string } {
  const parts: string[] = [];
  parts.push(
    i.openAlerts === 0
      ? 'Keine offenen Meldungen.'
      : i.openAlerts === 1
        ? '1 offene Meldung.'
        : `${i.openAlerts} offene Meldungen.`,
  );
  const measured = i.checks.filter((c): c is { name: string; uptime: number } => c.uptime !== null);
  if (measured.length > 0) {
    const avg =
      Math.floor((measured.reduce((s, c) => s + c.uptime, 0) / measured.length) * 100) / 100;
    const worst = [...measured].sort((a, b) => a.uptime - b.uptime)[0];
    let line = `Websites und Ports in 7 Tagen: ${formatPercent(avg)} erreichbar (${measured.length} ${measured.length === 1 ? 'Check' : 'Checks'}).`;
    if (worst && worst.uptime < 100 && measured.length > 1) {
      line += ` Am schwächsten: ${worst.name} mit ${formatPercent(worst.uptime)}.`;
    }
    parts.push(line);
  } else {
    parts.push('Keine Checks mit Messwerten.');
  }
  if (i.deploys) {
    const total = i.deploys.ok + i.deploys.failed;
    if (total === 0) parts.push('Keine Deploys.');
    else {
      let line = total === 1 ? '1 Deploy' : `${total} Deploys`;
      if (i.deploys.failed > 0) line += ` (${i.deploys.failed} fehlgeschlagen)`;
      parts.push(`${line}.`);
    }
  }
  if (i.serversTotal > 0) {
    parts.push(
      i.serversOffline === 0
        ? `Alle ${i.serversTotal} Server online.`
        : `${i.serversOffline} von ${i.serversTotal} Servern offline.`,
    );
  }
  return { title: 'Wochenbericht', body: parts.join(' ') };
}

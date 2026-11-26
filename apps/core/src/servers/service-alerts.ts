import { and, eq, like, ne } from 'drizzle-orm';
import type { AlertService } from '../alerts/service.js';
import type { Db } from '../db/index.js';
import { alerts } from '../db/schema.js';
import { clockTime } from '../format.js';

/**
 * M16: one `warn` alert per failed systemd unit (key `server:<id>:service:<unit>`),
 * resolved with an OK entry once the unit is no longer failed.
 */

/** systemd unit names (also escaped ones like `foo\x2dbar.service`). */
const UNIT_NAME = /^[A-Za-z0-9@._:\\-]{1,200}$/;
const MAX_FAILED = 50;

export const serviceAlertPrefix = (serverId: string): string => `server:${serverId}:service:`;
export const serviceAlertKey = (serverId: string, unit: string): string =>
  `${serviceAlertPrefix(serverId)}${unit}`;

/** Keeps only plausible unit names (the list comes from the agent), deduplicated and sorted. */
export function cleanFailedServices(list: readonly string[]): string[] {
  return [...new Set(list.filter((u) => UNIT_NAME.test(u)))].sort().slice(0, MAX_FAILED);
}

export function syncServiceAlerts(
  db: Db,
  alertService: AlertService,
  c: { serverId: string; name: string; now: number; failed: readonly string[] },
): void {
  const failed = new Set(c.failed);
  for (const unit of failed) {
    alertService.raise(
      serviceAlertKey(c.serverId, unit),
      'warn',
      `Dienst ${unit} auf ${c.name} fehlgeschlagen`,
      `Seit ${clockTime(c.now)} im Zustand failed. Neu starten unter Dienste im Serverdetail.`,
      c.serverId,
      'server',
    );
  }
  const prefix = serviceAlertPrefix(c.serverId);
  const open = db
    .select({ key: alerts.key })
    .from(alerts)
    .where(
      and(
        eq(alerts.serverId, c.serverId),
        ne(alerts.state, 'resolved'),
        like(alerts.key, `${prefix}%`),
      ),
    )
    .all()
    .map((a) => a.key)
    // `_` in a server id is a LIKE wildcard: the exact prefix check decides.
    .filter((k) => k.startsWith(prefix));
  for (const key of open) {
    const unit = key.slice(prefix.length);
    if (failed.has(unit)) continue;
    alertService.resolve(key, {
      title: `Dienst ${unit} auf ${c.name} nicht mehr fehlgeschlagen`,
      body: `Seit ${clockTime(c.now)}.`,
    });
  }
}

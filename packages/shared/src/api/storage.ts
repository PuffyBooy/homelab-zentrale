import { z } from 'zod';
import { storageInfoSchema, type PhysicalDisk, type StorageInfo } from '../agent-protocol.js';
import type { AlertLevel } from './alerts.js';
import { serverIdSchema } from './servers.js';

/**
 * M13: NAS und Speicher (ROADMAP M13, SPEC 5.4).
 *
 * Source: inventory.storage from the agent (md RAID from /proc/mdstat, volumes
 * from the host mount table, disks from /sys/block, SMART with smartctl when
 * HZ_AGENT_SMART=1). The core keeps the latest snapshot per server and raises
 * alerts from storageProblems(...). Module `storage` (on by default); off ->
 * routes 404 module_disabled and all storage alerts are resolved.
 *
 * Routes (admin session, read only):
 * GET /api/storage            -> StorageListResponse (servers that sent storage data)
 * GET /api/storage/:id        -> StorageServer (404 without data)
 */

export const storageServerSchema = z.strictObject({
  serverId: serverIdSchema,
  name: z.string().max(64),
  /** ms since epoch of the inventory that carried this snapshot. */
  updatedAt: z.number().int().nonnegative(),
  storage: storageInfoSchema,
  problems: z.array(
    z.strictObject({
      key: z.string().max(200),
      level: z.enum(['info', 'warn', 'crit']),
      title: z.string().max(200),
      body: z.string().max(400),
    }),
  ),
});
export type StorageServer = z.infer<typeof storageServerSchema>;

export const storageListResponseSchema = z.strictObject({
  servers: z.array(storageServerSchema),
});
export type StorageListResponse = z.infer<typeof storageListResponseSchema>;

export const storageParamsSchema = z.strictObject({ id: serverIdSchema });

// ---------------------------------------------------------------------------
// Rules (core raises alerts, web shows the same list)

/** Disk temperature limits in °C (HDD/SATA SSD vs NVMe). */
export const DISK_TEMP_LIMITS = {
  hdd: { warn: 50, crit: 60 },
  ssd: { warn: 60, crit: 70 },
  nvme: { warn: 70, crit: 80 },
} as const satisfies Record<PhysicalDisk['kind'], { warn: number; crit: number }>;

/** NVMe wear (percentage used) from which a warning is raised. */
export const NVME_WEAR_WARN = 90;

export type StorageProblemKind = 'raid' | 'smart' | 'sectors' | 'temp';

export const storageAlertKey = (serverId: string, kind: StorageProblemKind, device: string) =>
  `storage:${serverId}:${kind}:${device}`;
/** Prefix of all storage alerts of one server. */
export const storageAlertPrefix = (serverId: string) => `storage:${serverId}:`;

export interface StorageProblem {
  key: string;
  level: Exclude<AlertLevel, 'ok'>;
  title: string;
  body: string;
}

const KIND_LABEL: Record<PhysicalDisk['kind'], string> = {
  hdd: 'Festplatte',
  ssd: 'SSD',
  nvme: 'NVMe-SSD',
};

/** "Festplatte sda (WDC WD40EFRX)" */
export function diskLabel(d: Pick<PhysicalDisk, 'name' | 'kind' | 'model'>): string {
  return d.model
    ? `${KIND_LABEL[d.kind]} ${d.name} (${d.model})`
    : `${KIND_LABEL[d.kind]} ${d.name}`;
}

/**
 * Problems of one snapshot, worst first. Texts: Was + Wo, then what helps
 * (design/README.md). Syncing arrays are not a problem (shown in the UI only).
 */
export function storageProblems(
  serverId: string,
  serverName: string,
  s: StorageInfo,
): StorageProblem[] {
  const out: StorageProblem[] = [];
  for (const a of s.arrays) {
    const key = storageAlertKey(serverId, 'raid', a.name);
    if (a.state === 'inactive') {
      out.push({
        key,
        level: 'crit',
        title: `RAID ${a.name} auf ${serverName} ist inaktiv`,
        body: 'Das Array läuft nicht, die Daten darauf sind nicht erreichbar. Prüf im Speicher-Manager des NAS, welche Platte fehlt. Nichts formatieren.',
      });
    } else if (a.state === 'degraded') {
      const failed = a.members.filter((m) => m.failed).map((m) => m.disk ?? m.device);
      const missing = Math.max(0, a.devicesTotal - a.devicesActive);
      const which = failed.length > 0 ? ` (${failed.join(', ')} ausgefallen)` : '';
      out.push({
        key,
        level: 'crit',
        title: `RAID ${a.name} auf ${serverName} ist beschädigt`,
        body: `${missing} von ${a.devicesTotal} Platten ${missing === 1 ? 'fehlt' : 'fehlen'}${which}. Eine weitere Panne kostet Daten: Backup prüfen, Platte tauschen und das RAID neu aufbauen lassen.`,
      });
    }
  }
  for (const d of s.disks) {
    const label = diskLabel(d);
    const sm = d.smart;
    if (sm?.health === 'failed') {
      out.push({
        key: storageAlertKey(serverId, 'smart', d.name),
        level: 'crit',
        title: `${label} auf ${serverName}: SMART meldet Ausfall`,
        body: 'Die Platte sagt selbst, dass sie bald ausfällt. Daten sichern und die Platte tauschen.',
      });
    }
    if (sm) {
      const parts: string[] = [];
      if ((sm.reallocated ?? 0) > 0) parts.push(`${sm.reallocated} umgelagert`);
      if ((sm.pending ?? 0) > 0) parts.push(`${sm.pending} ausstehend`);
      if ((sm.uncorrectable ?? 0) > 0) parts.push(`${sm.uncorrectable} nicht lesbar`);
      if ((sm.mediaErrors ?? 0) > 0) parts.push(`${sm.mediaErrors} Medienfehler`);
      const worn = sm.wearPct !== undefined && sm.wearPct >= NVME_WEAR_WARN;
      if (parts.length > 0 || worn) {
        out.push({
          key: storageAlertKey(serverId, 'sectors', d.name),
          level: 'warn',
          title:
            parts.length > 0
              ? `${label} auf ${serverName} hat defekte Sektoren`
              : `${label} auf ${serverName} ist zu ${Math.round(sm.wearPct ?? 0)} % abgenutzt`,
          body:
            parts.length > 0
              ? `${parts.join(', ')}. Steigen die Werte, fällt die Platte bald aus: Backup prüfen, Tausch planen.`
              : 'Die SSD nähert sich dem Ende ihrer Schreib-Lebensdauer. Tausch planen.',
        });
      }
    }
    if (d.tempC !== null) {
      const lim = DISK_TEMP_LIMITS[d.kind];
      const level = d.tempC >= lim.crit ? 'crit' : d.tempC >= lim.warn ? 'warn' : null;
      if (level) {
        out.push({
          key: storageAlertKey(serverId, 'temp', d.name),
          level,
          title: `${label} auf ${serverName} bei ${Math.round(d.tempC)} °C`,
          body: `Über ${level === 'crit' ? lim.crit : lim.warn} °C. Lüfter und Luftzufuhr des Gehäuses prüfen.`,
        });
      }
    }
  }
  const rank = { crit: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Parses a storage alert key; null for other keys. */
export function parseStorageAlertKey(
  key: string,
): { serverId: string; kind: StorageProblemKind; device: string } | null {
  const m = /^storage:([A-Za-z0-9_-]{8,64}):(raid|smart|sectors|temp):([a-z0-9]{1,32})$/.exec(key);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { serverId: m[1], kind: m[2] as StorageProblemKind, device: m[3] };
}

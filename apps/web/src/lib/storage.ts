import {
  storageListResponseSchema,
  storageServerSchema,
  type PhysicalDisk,
  type RaidArray,
  type StorageServer,
} from '@hz/shared';
import type { Status } from '@hz/ui';
import { api } from './api.js';
import { formatBytes, formatGrouped, formatNumber, formatTemp, plural } from './format.js';

/** M13 NAS und Speicher: GET /api/storage, GET /api/storage/:id. */
export const storageListKey = ['storage'] as const;
export const storageKey = (serverId: string) => ['storage', serverId] as const;

export function fetchStorageList(signal?: AbortSignal): Promise<StorageServer[]> {
  return api('/api/storage', { schema: storageListResponseSchema, signal }).then((r) => r.servers);
}

export function fetchStorage(serverId: string, signal?: AbortSignal): Promise<StorageServer> {
  return api(`/api/storage/${encodeURIComponent(serverId)}`, {
    schema: storageServerSchema,
    signal,
  });
}

/** raid1 -> "RAID 1", linear -> "Linear". */
export function raidLevelLabel(level: string): string {
  const m = /^raid(\d+)$/.exec(level);
  if (m) return `RAID ${m[1]}`;
  if (level === 'unknown') return 'RAID';
  return level.charAt(0).toUpperCase() + level.slice(1);
}

const SYNC_LABEL: Record<NonNullable<RaidArray['sync']>['kind'], string> = {
  resync: 'Synchronisiert',
  recovery: 'Baut neu auf',
  check: 'Prüft',
  reshape: 'Baut um',
};

export function arrayView(a: RaidArray): { status: Status; label: string; detail: string } {
  const members = `${a.devicesActive}/${a.devicesTotal} Platten`;
  const size = a.sizeBytes !== undefined ? ` · ${formatBytes(a.sizeBytes)}` : '';
  const sync = a.sync
    ? ` · ${SYNC_LABEL[a.sync.kind]} ${formatNumber(a.sync.percent, 1)} %${
        a.sync.finishMin !== undefined ? `, noch ${durationMin(a.sync.finishMin)}` : ''
      }`
    : '';
  const base = `${raidLevelLabel(a.level)} · ${members}${size}${sync}`;
  switch (a.state) {
    case 'inactive':
      return { status: 'crit', label: 'Inaktiv', detail: base };
    case 'degraded':
      return { status: 'crit', label: 'Beschädigt', detail: base };
    case 'syncing':
      return { status: 'busy', label: 'Synchronisiert', detail: base };
    default:
      return { status: 'ok', label: 'In Ordnung', detail: base };
  }
}

function durationMin(min: number): string {
  if (min < 60) return `${Math.max(1, Math.round(min))} Min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h} h ${m} Min` : `${h} h`;
}

const KIND: Record<PhysicalDisk['kind'], string> = { hdd: 'HDD', ssd: 'SSD', nvme: 'NVMe' };

export function diskView(d: PhysicalDisk): {
  status: Status;
  label: string;
  title: string;
  sub: string;
  meta: string;
} {
  const sm = d.smart;
  const bad = (sm?.reallocated ?? 0) + (sm?.pending ?? 0) + (sm?.uncorrectable ?? 0);
  const media = sm?.mediaErrors ?? 0;
  let status: Status = 'ok';
  let label = 'In Ordnung';
  if (sm?.health === 'failed') {
    status = 'crit';
    label = 'SMART: Ausfall';
  } else if (bad > 0) {
    status = 'warn';
    label = plural(bad, 'defekter Sektor', 'defekte Sektoren');
  } else if (media > 0) {
    status = 'warn';
    label = plural(media, 'Medienfehler', 'Medienfehler');
  } else if (d.standby) {
    status = 'off';
    label = 'Schläft';
  } else if (!sm) {
    status = 'info';
    label = 'Ohne SMART';
  }
  const parts = [`${formatBytes(d.sizeBytes)} ${KIND[d.kind]}`];
  if (sm?.powerOnHours !== undefined)
    parts.push(
      `${formatGrouped(sm.powerOnHours, 0, 0)} ${sm.powerOnHours === 1 ? 'Stunde' : 'Stunden'}`,
    );
  if (sm?.wearPct !== undefined) parts.push(`${formatNumber(sm.wearPct, 0)} % abgenutzt`);
  return {
    status,
    label,
    title: d.model ? `${d.name} · ${d.model}` : d.name,
    sub: parts.join(' · '),
    meta: d.standby ? 'schläft' : formatTemp(d.tempC),
  };
}

/** Worst status of a snapshot, for the tile header. */
export function storageStatus(s: StorageServer): Status {
  if (s.problems.some((p) => p.level === 'crit')) return 'crit';
  if (s.problems.some((p) => p.level === 'warn')) return 'warn';
  if (s.storage.arrays.some((a) => a.state === 'syncing')) return 'busy';
  return 'ok';
}

export const SMART_HINT: Record<StorageServer['storage']['smart'], string | null> = {
  on: null,
  off: 'SMART ist aus. Für Gesundheit, defekte Sektoren und Temperatur der Festplatten den Agent mit --smart einrichten (auf einem UGREEN-NAS automatisch).',
  unavailable:
    'SMART ist an, aber der Agent darf die Platten nicht lesen. deploy/docker-compose.agent.smart.yml mitstarten.',
};

/** Status text next to the dot, so a row never relies on colour alone. */
export const STORAGE_STATUS_TEXT: Record<Status, string> = {
  ok: 'In Ordnung',
  warn: 'Warnung',
  crit: 'Problem',
  busy: 'Synchronisiert',
  info: 'Info',
  off: 'Aus',
};

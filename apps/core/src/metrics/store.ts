import type Database from 'better-sqlite3';
import type { HistoryResponse, Metrics } from '@hz/shared';
import type { Clock } from '../clock.js';
import type { Sample } from '../servers/status.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const BUCKET_5M = 5 * MINUTE;
export const BUCKET_1H = HOUR;

/** Retention (docs/ARCHITECTURE.md): raw 48 h, 5-min means 30 days, hourly means 1 year. */
export const RETENTION = {
  raw: 48 * HOUR,
  m5: 30 * DAY,
  h1: 365 * DAY,
} as const;

/** How far back a regular rollup recomputes buckets (late samples, short outages). */
const LOOKBACK_5M = HOUR;
const LOOKBACK_1H = 3 * HOUR;

export interface RawRow {
  serverId: string;
  ts: number;
  cpu: number;
  ram: number;
  swap: number;
  diskMax: number | null;
  disks: { mount: string; pct: number }[];
  temp: number | null;
  netIn: number;
  netOut: number;
}

function pct(used: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/** Converts an agent `metrics` message into a raw row (percentages). */
export function toRawRow(serverId: string, ts: number, m: Omit<Metrics, 'type'>): RawRow {
  const disks = m.disks
    .filter((d) => d.totalBytes > 0)
    .map((d) => ({ mount: d.mount, pct: pct(d.usedBytes, d.totalBytes) }));
  return {
    serverId,
    ts,
    cpu: m.cpu,
    ram: pct(m.ram.usedBytes, m.ram.totalBytes),
    swap: pct(m.swap.usedBytes, m.swap.totalBytes),
    diskMax: disks.length > 0 ? Math.max(...disks.map((d) => d.pct)) : null,
    disks,
    temp: m.temp,
    netIn: m.net.rxBps,
    netOut: m.net.txBps,
  };
}

const ROLLUP_COLS = 'server_id, ts, cpu, ram, swap, disk_max, temp, net_in, net_out, samples';

export class MetricsStore {
  private readonly insertRaw: Database.Statement;
  private readonly rollup5mStmt: Database.Statement;
  private readonly rollup1hStmt: Database.Statement;
  private readonly samplesStmt: Database.Statement;

  constructor(
    private readonly sqlite: Database.Database,
    private readonly now: Clock,
  ) {
    this.insertRaw = sqlite.prepare(
      `INSERT INTO metrics_raw (server_id, ts, cpu, ram, swap, disk_max, disk_json, temp, net_in, net_out)
       VALUES (@serverId, @ts, @cpu, @ram, @swap, @diskMax, @diskJson, @temp, @netIn, @netOut)`,
    );
    this.rollup5mStmt = sqlite.prepare(
      `INSERT OR REPLACE INTO metrics_5m (${ROLLUP_COLS})
       SELECT server_id, (ts / ${BUCKET_5M}) * ${BUCKET_5M} AS b,
              AVG(cpu), AVG(ram), AVG(swap), AVG(disk_max), AVG(temp), AVG(net_in), AVG(net_out), COUNT(*)
       FROM metrics_raw WHERE ts >= ? AND ts < ? GROUP BY server_id, b`,
    );
    this.rollup1hStmt = sqlite.prepare(
      `INSERT OR REPLACE INTO metrics_1h (${ROLLUP_COLS})
       SELECT server_id, (ts / ${BUCKET_1H}) * ${BUCKET_1H} AS b,
              SUM(cpu * samples) / SUM(samples), SUM(ram * samples) / SUM(samples),
              SUM(swap * samples) / SUM(samples),
              SUM(disk_max * samples) / SUM(CASE WHEN disk_max IS NULL THEN NULL ELSE samples END),
              SUM(temp * samples) / SUM(CASE WHEN temp IS NULL THEN NULL ELSE samples END),
              SUM(net_in * samples) / SUM(samples), SUM(net_out * samples) / SUM(samples),
              SUM(samples)
       FROM metrics_5m WHERE ts >= ? AND ts < ? GROUP BY server_id, b`,
    );
    this.samplesStmt = sqlite.prepare(
      'SELECT ts, cpu, ram AS ramPct FROM metrics_raw WHERE server_id = ? AND ts >= ? ORDER BY ts',
    );
  }

  insert(row: RawRow): void {
    this.insertRaw.run({ ...row, diskJson: JSON.stringify(row.disks) });
  }

  /** Raw samples since `since`, ascending (input for the status rules). */
  samples(serverId: string, since: number): Sample[] {
    return this.samplesStmt.all(serverId, since) as Sample[];
  }

  /**
   * Recomputes the 5-minute buckets that are complete, from `now - lookback` on.
   * Idempotent: buckets are replaced, so running it twice changes nothing.
   */
  rollup5m(lookbackMs = LOOKBACK_5M): number {
    const end = Math.floor(this.now() / BUCKET_5M) * BUCKET_5M;
    const start = Math.floor((end - lookbackMs) / BUCKET_5M) * BUCKET_5M;
    return this.rollup5mStmt.run(start, end).changes;
  }

  /** Recomputes complete hourly buckets from the 5-minute means (weighted by samples). */
  rollup1h(lookbackMs = LOOKBACK_1H): number {
    const end = Math.floor(this.now() / BUCKET_1H) * BUCKET_1H;
    const start = Math.floor((end - lookbackMs) / BUCKET_1H) * BUCKET_1H;
    return this.rollup1hStmt.run(start, end).changes;
  }

  /** Deletes data older than the retention. Returns deleted rows per table. */
  prune(): { raw: number; m5: number; h1: number } {
    const now = this.now();
    const del = (table: string, before: number): number =>
      this.sqlite.prepare(`DELETE FROM ${table} WHERE ts < ?`).run(before).changes;
    return {
      raw: del('metrics_raw', now - RETENTION.raw),
      m5: del('metrics_5m', now - RETENTION.m5),
      h1: del('metrics_1h', now - RETENTION.h1),
    };
  }

  /**
   * History for the detail page.
   * 1h: raw samples; 24h: raw, averaged to 5 min; 7d: 5-min means, averaged to
   * 1 h; 30d: hourly means.
   */
  history(serverId: string, range: HistoryResponse['range']): HistoryResponse {
    const now = this.now();
    type Row = {
      ts: number;
      cpu: number;
      ram: number;
      temp: number | null;
      ni: number;
      no: number;
      dm: number | null;
    };
    let rows: Row[];
    if (range === '1h') {
      rows = this.sqlite
        .prepare(
          `SELECT ts, cpu, ram, temp, net_in AS ni, net_out AS no, disk_max AS dm FROM metrics_raw
           WHERE server_id = ? AND ts >= ? ORDER BY ts`,
        )
        .all(serverId, now - HOUR) as Row[];
    } else if (range === '24h') {
      rows = this.sqlite
        .prepare(
          `SELECT (ts / ${BUCKET_5M}) * ${BUCKET_5M} AS ts, AVG(cpu) AS cpu, AVG(ram) AS ram,
                  AVG(temp) AS temp, AVG(net_in) AS ni, AVG(net_out) AS no, MAX(disk_max) AS dm
           FROM metrics_raw WHERE server_id = ? AND ts >= ? GROUP BY 1 ORDER BY 1`,
        )
        .all(serverId, now - DAY) as Row[];
    } else if (range === '7d') {
      rows = this.sqlite
        .prepare(
          `SELECT (ts / ${BUCKET_1H}) * ${BUCKET_1H} AS ts,
                  SUM(cpu * samples) / SUM(samples) AS cpu, SUM(ram * samples) / SUM(samples) AS ram,
                  SUM(temp * samples) / SUM(CASE WHEN temp IS NULL THEN NULL ELSE samples END) AS temp,
                  SUM(net_in * samples) / SUM(samples) AS ni, SUM(net_out * samples) / SUM(samples) AS no,
                  MAX(disk_max) AS dm
           FROM metrics_5m WHERE server_id = ? AND ts >= ? GROUP BY 1 ORDER BY 1`,
        )
        .all(serverId, now - 7 * DAY) as Row[];
    } else {
      rows = this.sqlite
        .prepare(
          `SELECT ts, cpu, ram, temp, net_in AS ni, net_out AS no, disk_max AS dm FROM metrics_1h
           WHERE server_id = ? AND ts >= ? ORDER BY ts`,
        )
        .all(serverId, now - 30 * DAY) as Row[];
    }
    const round = (v: number): number => Math.round(v * 10) / 10;
    return {
      range,
      points: rows.map((r) => ({
        ts: new Date(r.ts).toISOString(),
        cpu: round(r.cpu),
        ramPct: round(r.ram),
        netIn: Math.round(r.ni),
        netOut: Math.round(r.no),
        temp: r.temp === null ? null : round(r.temp),
        diskMax: r.dm === null ? null : round(r.dm),
      })),
    };
  }
}

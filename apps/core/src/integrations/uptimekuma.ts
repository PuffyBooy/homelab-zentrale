import { z } from 'zod';
import {
  checkDefSchema,
  type CheckDef,
  type KumaMonitor,
  type kumaImportRequestSchema,
  type kumaImportResponseSchema,
  type kumaMonitorsResponseSchema,
} from '@hz/shared';
import type { CheckService } from '../checks/service.js';
import { IntegrationService, type IntegrationDeps, type ReadyConfig } from './base.js';
import { requireOk } from './http.js';

type ImportRequest = z.output<typeof kumaImportRequestSchema>;
type ImportResponse = z.infer<typeof kumaImportResponseSchema>;
type MonitorsResponse = z.infer<typeof kumaMonitorsResponseSchema>;

export const KUMA_POLL_MS = 60_000;
export const KUMA_CACHE_MS = 10_000;
const MAX_MONITORS = 1000;
const IMPORTED = 'imported';

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Prometheus text format, only what Kuma writes: `name{a="b",...} value`.
 * Label values may contain \" \\ and \n escapes. Comments and odd lines are skipped.
 */
export function parsePrometheus(text: string, wanted: ReadonlySet<string>): PromSample[] {
  const out: PromSample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([A-Za-z_:][A-Za-z0-9_:]*)/.exec(line);
    const name = m?.[1];
    if (name === undefined || !wanted.has(name)) continue;
    let i = name.length;
    const labels: Record<string, string> = {};
    if (line[i] === '{') {
      i++;
      let ok = false;
      while (i < line.length) {
        while (line[i] === ' ' || line[i] === ',') i++;
        if (line[i] === '}') {
          i++;
          ok = true;
          break;
        }
        const key = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i))?.[0];
        if (key === undefined) break;
        i += key.length;
        if (line[i] !== '=' || line[i + 1] !== '"') break;
        i += 2;
        let value = '';
        let closed = false;
        while (i < line.length) {
          const c = line[i];
          if (c === '\\') {
            const n = line[i + 1];
            value += n === 'n' ? '\n' : (n ?? '');
            i += 2;
          } else if (c === '"') {
            i++;
            closed = true;
            break;
          } else {
            value += c;
            i++;
          }
        }
        if (!closed) break;
        if (!Object.hasOwn(labels, key)) labels[key] = value;
      }
      if (!ok) continue;
    }
    const rest = line.slice(i).trim().split(/\s+/)[0] ?? '';
    const value = Number(rest);
    if (rest === '' || Number.isNaN(value)) continue;
    out.push({ name, labels, value });
  }
  return out;
}

const STATUS: Record<number, KumaMonitor['status']> = {
  0: 'down',
  1: 'up',
  2: 'pending',
  3: 'maintenance',
};

export function importAsFor(type: string): KumaMonitor['importAs'] {
  if (type === 'http' || type === 'keyword' || type === 'json-query') return 'http';
  if (type === 'port') return 'tcp';
  if (type === 'ping') return 'ping';
  return null;
}

const label = (v: string | undefined, max: number): string | null =>
  v === undefined || v === '' || v === 'null' || v.length > max ? null : v;

export type KumaData = Omit<KumaMonitor, 'checkId'>[];

/** Monitors from Kuma's /metrics (one per monitor_name, first wins). */
export function parseKumaMetrics(text: string): KumaData {
  const samples = parsePrometheus(
    text,
    new Set(['monitor_status', 'monitor_response_time', 'monitor_cert_days_remaining']),
  );
  const byName = new Map<string, Omit<KumaMonitor, 'checkId'>>();
  for (const s of samples) {
    if (s.name !== 'monitor_status') continue;
    const name = s.labels.monitor_name;
    if (name === undefined || name === '' || name.length > 150 || byName.has(name)) continue;
    if (byName.size >= MAX_MONITORS) break;
    const type = (s.labels.monitor_type ?? '').slice(0, 40);
    const portText = label(s.labels.monitor_port, 5);
    const port = portText !== null && /^\d+$/.test(portText) ? Number(portText) : null;
    byName.set(name, {
      name,
      type,
      url: label(s.labels.monitor_url, 2048),
      hostname: label(s.labels.monitor_hostname, 253),
      port: port !== null && port >= 1 && port <= 65535 ? port : null,
      status: STATUS[s.value] ?? 'unknown',
      responseMs: null,
      certDaysRemaining: null,
      importAs: importAsFor(type),
    });
  }
  for (const s of samples) {
    const m = byName.get(s.labels.monitor_name ?? '');
    if (!m || !Number.isFinite(s.value)) continue;
    if (s.name === 'monitor_response_time' && s.value >= 0) m.responseMs = s.value;
    if (s.name === 'monitor_cert_days_remaining') m.certDaysRemaining = Math.trunc(s.value);
  }
  return [...byName.values()];
}

const importedSchema = z.record(z.string(), z.string().max(64));

/**
 * Uptime Kuma (SPEC 16): reads the monitors over /metrics with an API key and
 * turns them into own checks ("Übernehmen"), so Kuma can be switched off later.
 */
export class KumaService extends IntegrationService<KumaData> {
  constructor(
    deps: IntegrationDeps,
    private readonly checks: Pick<CheckService, 'create' | 'validate' | 'row'>,
  ) {
    super(deps, 'uptimekuma', 'Uptime Kuma', KUMA_POLL_MS, KUMA_CACHE_MS);
  }

  protected async fetch(cfg: ReadyConfig): Promise<KumaData> {
    // Kuma: API key as the password of Basic auth, user name empty.
    const basic = Buffer.from(`:${cfg.secret}`, 'utf8').toString('base64');
    const res = requireOk(
      await this.deps.http.request({
        base: cfg.url,
        path: '/metrics',
        headers: { authorization: `Basic ${basic}`, accept: 'text/plain' },
        ca: cfg.caCert,
      }),
    );
    return parseKumaMetrics(res.body);
  }

  private imported(): Record<string, string> {
    const p = importedSchema.safeParse(this.store.readExtra(IMPORTED) ?? {});
    return p.success ? p.data : {};
  }

  /** Check id for a monitor, if the check still exists. */
  private checkIdOf(map: Record<string, string>, name: string): string | null {
    const id = Object.hasOwn(map, name) ? map[name] : undefined;
    return id !== undefined && this.checks.row(id) ? id : null;
  }

  async monitors(): Promise<MonitorsResponse> {
    const c = await this.current();
    const map = this.imported();
    return {
      monitors: (c.data ?? []).map((m) => ({ ...m, checkId: this.checkIdOf(map, m.name) })),
      fetchedAt: this.iso(c.fetchedAt),
      error: c.error,
    };
  }

  private defFor(m: Omit<KumaMonitor, 'checkId'>, pingFrom: string | undefined): CheckDef | string {
    const name = m.name.trim().slice(0, 80).trim();
    let input: unknown;
    switch (m.importAs) {
      case 'http':
        if (m.url === null) return 'Adresse fehlt';
        input = { kind: 'http', name, url: m.url };
        break;
      case 'tcp':
        if (m.hostname === null || m.port === null) return 'Adresse fehlt';
        input = { kind: 'tcp', name, host: m.hostname, port: m.port };
        break;
      case 'ping':
        if (m.hostname === null) return 'Adresse fehlt';
        if (pingFrom === undefined) return 'Ping braucht einen Server mit Agent';
        input = { kind: 'ping', name, host: m.hostname, runFrom: pingFrom };
        break;
      default:
        return 'Typ nicht unterstützt';
    }
    const p = checkDefSchema.safeParse(input);
    if (!p.success) return 'Adresse ungültig';
    if (!this.checks.validate(p.data)) {
      return m.importAs === 'ping' ? 'Server unbekannt' : 'Adresse ungültig';
    }
    return p.data;
  }

  /** Creates checks from monitors; already imported ones are skipped. */
  async importMonitors(
    body: ImportRequest,
  ): Promise<ImportResponse & { createdIds: { id: string; def: CheckDef }[] }> {
    const list = await this.act(async (cfg) => this.fetch(cfg));
    const byName = new Map(list.map((m) => [m.name, m]));
    const map = this.imported();
    const createdIds: { id: string; def: CheckDef }[] = [];
    const skipped: ImportResponse['skipped'] = [];
    for (const name of new Set(body.names)) {
      const m = byName.get(name);
      if (!m) {
        skipped.push({ name, reason: 'Monitor nicht gefunden' });
        continue;
      }
      if (this.checkIdOf(map, name) !== null) {
        skipped.push({ name, reason: 'Schon übernommen' });
        continue;
      }
      const def = this.defFor(m, body.pingFrom);
      if (typeof def === 'string') {
        skipped.push({ name, reason: def });
        continue;
      }
      const check = this.checks.create(def);
      map[name] = check.id;
      createdIds.push({ id: check.id, def });
    }
    this.store.writeExtra(IMPORTED, map);
    this.invalidate();
    return { created: createdIds.length, skipped, createdIds };
  }
}

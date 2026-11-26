import {
  MAX_ALLOWED_PORTS,
  PORT_NOTE_MAX,
  parsePortAlertKey,
  portAuditResponseSchema,
  type AllowedPort,
  type OpenPort,
  type PortAllowRequest,
  type PortAuditProto,
  type PortAuditResponse,
} from '@hz/shared';
import { api } from './api.js';
import { plural } from './format.js';

export { MAX_ALLOWED_PORTS, PORT_NOTE_MAX, parsePortAlertKey };

export const portAuditKey = (serverId: string) => ['server', serverId, 'ports'] as const;

const enc = encodeURIComponent;

export function fetchPortAudit(serverId: string, signal?: AbortSignal): Promise<PortAuditResponse> {
  return api(`/api/servers/${enc(serverId)}/ports/allowed`, {
    schema: portAuditResponseSchema,
    signal,
  });
}

/** Replaces the whole list. */
export function saveAllowedPorts(
  serverId: string,
  ports: AllowedPort[],
): Promise<PortAuditResponse> {
  return api(`/api/servers/${enc(serverId)}/ports/allowed`, {
    method: 'PUT',
    body: { ports },
    schema: portAuditResponseSchema,
  });
}

/** Idempotent; resolves the "Neuer offener Port" alert at once. */
export function allowPort(serverId: string, body: PortAllowRequest): Promise<PortAuditResponse> {
  return api(`/api/servers/${enc(serverId)}/ports/allow`, {
    method: 'POST',
    body,
    schema: portAuditResponseSchema,
  });
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure, unit tested)

/** "8081/tcp" like ss -tulpn. */
export function portText(p: Pick<OpenPort, 'port' | 'proto'>): string {
  return `${p.port}/${p.proto}`;
}

/** Statussatz of the tile: "1 Port nicht erlaubt" or "alle 3 erlaubt". */
export function portAuditSummary(r: Pick<PortAuditResponse, 'open'>): {
  status: 'ok' | 'warn';
  label: string;
} {
  const bad = r.open.filter((p) => !p.allowed).length;
  if (bad) return { status: 'warn', label: `${plural(bad, 'Port', 'Ports')} nicht erlaubt` };
  if (!r.open.length) return { status: 'ok', label: 'keine offen' };
  return { status: 'ok', label: r.open.length === 1 ? 'erlaubt' : `alle ${r.open.length} erlaubt` };
}

export interface AllowedRowDraft {
  /** Local key for React; not sent. */
  key: string;
  port: string;
  proto: PortAuditProto;
  note: string;
}

let rowSeq = 0;
export function draftRow(p?: AllowedPort): AllowedRowDraft {
  rowSeq++;
  return {
    key: `row-${rowSeq}`,
    port: p ? String(p.port) : '',
    proto: p?.proto ?? 'tcp',
    note: p?.note ?? '',
  };
}

export function draftFromAllowed(list: readonly AllowedPort[]): AllowedRowDraft[] {
  return list.map((p) => draftRow(p));
}

export type AllowedErrors = Record<string, string>;

/**
 * Checks the editable list like allowedPortListSchema: port 1–65535, note up to 80
 * characters, no (proto, port) twice, at most 200 entries. Errors by `<key>:port`
 * / `<key>:note`, plus `list` for the count.
 */
export function validateAllowed(rows: readonly AllowedRowDraft[]): {
  ports: AllowedPort[];
  errors: AllowedErrors;
} {
  const errors: AllowedErrors = {};
  const ports: AllowedPort[] = [];
  const seen = new Set<string>();
  if (rows.length > MAX_ALLOWED_PORTS) {
    errors.list = `Höchstens ${MAX_ALLOWED_PORTS} Ports.`;
  }
  for (const r of rows) {
    const raw = r.port.trim();
    const n = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      errors[`${r.key}:port`] = 'Port 1 bis 65535.';
      continue;
    }
    const id = `${r.proto}/${n}`;
    if (seen.has(id)) {
      errors[`${r.key}:port`] =
        `${portText({ port: n, proto: r.proto })} steht schon in der Liste.`;
      continue;
    }
    seen.add(id);
    const note = r.note.trim();
    if (note.length > PORT_NOTE_MAX) {
      errors[`${r.key}:note`] = `Höchstens ${PORT_NOTE_MAX} Zeichen.`;
      continue;
    }
    ports.push(note ? { port: n, proto: r.proto, note } : { port: n, proto: r.proto });
  }
  return { ports, errors };
}

/** "Erlauben" on the alerts page: the server and port from the alert key, or null. */
export function portAlertTarget(
  key: string,
): { serverId: string; proto: PortAuditProto; port: number } | null {
  return parsePortAlertKey(key);
}

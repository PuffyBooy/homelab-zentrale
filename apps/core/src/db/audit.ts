import type { Db } from './index.js';
import { auditLog } from './schema.js';

export interface AuditEntry {
  /** `admin`, `anonymous`, `system`, later `share:<id>`. */
  actor: string;
  action: string;
  target?: string | null;
  /** Free-form context. Callers must never put secrets here. */
  details?: Record<string, unknown>;
}

export function writeAudit(db: Db, ts: number, entry: AuditEntry): void {
  db.insert(auditLog)
    .values({
      ts,
      actor: entry.actor,
      action: entry.action,
      target: entry.target ?? null,
      detailsJson: entry.details ? JSON.stringify(entry.details) : null,
    })
    .run();
}

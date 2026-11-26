import { eq } from 'drizzle-orm';
import type { Db } from './index.js';
import { settings } from './schema.js';

/**
 * Key/value settings (JSON). Secret values must be encrypted with crypto.ts
 * by the caller before they are stored here.
 */
export function readSetting(db: Db, key: string): unknown {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return undefined;
  try {
    return JSON.parse(row.valueJson) as unknown;
  } catch {
    return undefined;
  }
}

export function writeSetting(db: Db, key: string, value: unknown, now: number): void {
  const valueJson = JSON.stringify(value);
  db.insert(settings)
    .values({ key, valueJson, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt: now } })
    .run();
}

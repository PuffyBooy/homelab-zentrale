import { backupDoneDataSchema } from '@hz/shared';
import type { z } from 'zod';

/**
 * Progress lines of the agent's game actions are English; the UI is German.
 * Known phrases are translated, unknown lines pass through unchanged.
 * See apps/agent/src/actions/game-backup.ts.
 */

/** Prefix of the last backup progress line; the rest is JSON (backupDoneDataSchema). */
export const BACKUP_RESULT_PREFIX = 'result ';

export type BackupDone = z.infer<typeof backupDoneDataSchema>;

const decimal = (n: string): string => n.replace('.', ',');

const RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^world saved, autosave paused$/, () => 'Welt gespeichert, Autosave pausiert'],
  [/^could not pause autosave \(rcon\)$/, () => 'Autosave konnte nicht pausiert werden (RCON)'],
  [/^autosave resumed$/, () => 'Autosave wieder aktiv'],
  [/^could not resume autosave$/, () => 'Autosave konnte nicht fortgesetzt werden'],
  [/^\$ tar\b.*$/, () => 'Archiv wird erstellt (tar.zst)'],
  [/^backup: ([\d.]+) MiB written$/, (m) => `${decimal(m[1] ?? '0')} MiB geschrieben`],
  [
    /^warning: some files changed while they were read$/,
    () => 'Warnung: Einige Dateien haben sich beim Lesen geändert',
  ],
  [/^removed (\d+) old backup\(s\)$/, (m) => `${m[1] ?? '0'} alte Sicherung(en) entfernt`],
  [/^error: (.*)$/, (m) => `Fehler: ${m[1] ?? ''}`],
];

export function translateProgress(line: string): string {
  for (const [re, fn] of RULES) {
    const m = re.exec(line);
    if (m) return fn(m);
  }
  return line;
}

/** The backup result line, or null if `line` is not one (or not valid). */
export function parseBackupResult(line: string): BackupDone | 'invalid' | null {
  if (!line.startsWith(BACKUP_RESULT_PREFIX)) return null;
  let json: unknown;
  try {
    json = JSON.parse(line.slice(BACKUP_RESULT_PREFIX.length));
  } catch {
    return 'invalid';
  }
  const parsed = backupDoneDataSchema.safeParse(json);
  return parsed.success ? parsed.data : 'invalid';
}

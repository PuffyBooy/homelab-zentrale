import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { requireStepUp } from '../auth/guard.js';
import { localTime } from '../calendar.js';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../http/errors.js';

export interface ExportRoutesOptions {
  db: Db;
  sqlite: Database.Database;
  now: Clock;
  dataDir: string;
  log: FastifyBaseLogger;
}

/** Temp files of a running export: `.export-<random>.sqlite` in the data dir. */
const TEMP_PREFIX = '.export-';
const TEMP_RE = /^\.export-[A-Za-z0-9_-]{16,}\.sqlite$/;

const pad = (n: number): string => String(n).padStart(2, '0');

/** "homelab-zentrale-20261126-2304.sqlite" (local time, HZ_TIMEZONE). */
export function exportFileName(ms: number): string {
  const t = localTime(ms);
  return `homelab-zentrale-${t.year}${pad(t.month)}${pad(t.day)}-${pad(t.hour)}${pad(t.minute)}.sqlite`;
}

/** Removes temp files left by a crash during an export. */
export async function removeStaleExports(dataDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dataDir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!TEMP_RE.test(name)) continue;
    await unlink(join(dataDir, name)).catch(() => undefined);
    n += 1;
  }
  return n;
}

/**
 * POST /api/settings/export (step-up): a consistent snapshot of the whole database
 * (`VACUUM INTO` a temp file in the data dir), streamed as a download and deleted
 * afterwards. Secrets inside stay AES-256-GCM encrypted. One export at a time.
 */
export const exportRoutes: FastifyPluginAsync<ExportRoutesOptions> = async (app, o) => {
  const stepUp = requireStepUp(o.now);
  let running = false;

  app.post('/settings/export', { preHandler: stepUp }, async (_request, reply) => {
    if (running) throw new HttpError(409, 'busy');
    running = true;
    const path = join(o.dataDir, `${TEMP_PREFIX}${randomToken(16)}.sqlite`);
    const done = (): void => {
      running = false;
      void unlink(path).catch(() => undefined);
    };
    let size: number;
    try {
      await mkdir(o.dataDir, { recursive: true });
      // Empty 0600 file first (VACUUM INTO accepts an empty target), so the copy
      // is never readable by other users, whatever the umask.
      await writeFile(path, '', { mode: 0o600, flag: 'wx' });
      o.sqlite.prepare('VACUUM INTO ?').run(path);
      size = (await stat(path)).size;
    } catch (err) {
      done();
      o.log.error({ err: err instanceof Error ? err.name : 'error' }, 'settings export failed');
      throw err;
    }
    const now = o.now();
    writeAudit(o.db, now, { actor: 'admin', action: 'settings.export', details: { bytes: size } });
    const stream = createReadStream(path);
    stream.once('close', done);
    reply.raw.once('close', () => stream.destroy());
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(size))
      .header('content-disposition', `attachment; filename="${exportFileName(now)}"`)
      .header('x-content-type-options', 'nosniff')
      .send(stream);
  });
};

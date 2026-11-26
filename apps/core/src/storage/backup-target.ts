import { createHash } from 'node:crypto';
import { open, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  BACKUP_TARGET_ALERT_PREFIX,
  BACKUP_TARGET_DEFAULTS,
  CORE_DB_MAX_BYTES,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_WINDOW,
  backupTargetAlertKey,
  backupTargetRunSchema,
  backupTargetSettingsSchema,
  backupTargetStatusDataSchema,
  backupTargetStoreDataSchema,
  backupTargetSyncDataSchema,
  coreDbFileNameSchema,
  type BackupTargetError,
  type BackupTargetResponse,
  type BackupTargetRun,
  type BackupTargetSettings,
  type BackupTargetStatusData,
} from '@hz/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AgentHub, RpcStream, TransferFrame } from '../agents/hub.js';
import type { AlertService } from '../alerts/service.js';
import { hhmmToMinutes, nextWallClock } from '../calendar.js';
import type { Clock } from '../clock.js';
import { randomToken } from '../crypto.js';
import { writeAudit } from '../db/audit.js';
import type { Db } from '../db/index.js';
import { gameServers, servers } from '../db/schema.js';
import { readSetting, writeSetting } from '../db/settings.js';
import { gigabytes } from '../format.js';
import { exportFileName } from '../settings/export.js';

/**
 * M13b: NAS als Backup-Ziel (contract in @hz/shared api/backup-target.ts and
 * agent-backup-target.ts). Part of module `storage`.
 *
 * Nightly at settings.time and on demand:
 * 1. For each server in serverIds: backup.target.status; not mounted -> warning
 *    alert, nothing is written. Else backup.target.sync with the folder names of
 *    the game servers on that server; failed games -> warning alert.
 * 2. dbServerId: VACUUM INTO a 0600 temp file in the data dir (like the settings
 *    export; secrets stay AES-GCM encrypted, HZ_SECRET_KEY never leaves the core),
 *    then sent with backup.target.store (core is the sender, TRANSFER_WINDOW chunks
 *    in flight, acks from the agent). The temp file is always deleted.
 * Settings and the last results live in the settings table (no migration).
 */

const SETTINGS_KEY = 'backup_target';
const STATE_KEY = 'backup_target_state';
const STATUS_TIMEOUT_MS = 30_000;
const SYNC_TIMEOUT_MS = 6 * 60 * 60_000;
const STORE_TIMEOUT_MS = 2 * 60 * 60_000;
const ACCEPT_TIMEOUT_MS = 60_000;
const ACK_TIMEOUT_MS = 60_000;
/** Temp names removeStaleExports() cleans after a crash. */
const TEMP_PREFIX = '.export-';

const runSchema = backupTargetRunSchema;
const stateSchema = z.object({
  servers: z
    .record(
      z.string(),
      z.object({
        status: backupTargetStatusDataSchema.nullable(),
        statusAt: z.number().nullable(),
        lastRun: runSchema.nullable(),
      }),
    )
    .default({}),
  db: z
    .object({ lastRun: runSchema.extend({ fileName: coreDbFileNameSchema.nullable() }).nullable() })
    .default({ lastRun: null }),
});
type State = z.infer<typeof stateSchema>;
type ServerState = State['servers'][string];

export class BackupTargetBusyError extends Error {}

export interface BackupTargetDeps {
  db: Db;
  sqlite: Database.Database;
  hub: AgentHub;
  alerts: AlertService;
  now: Clock;
  dataDir: string;
  log: FastifyBaseLogger;
}

export class BackupTargetService {
  private moduleOn = true;
  private running: Promise<void> | null = null;
  private next: number | null = null;

  constructor(private readonly deps: BackupTargetDeps) {
    this.plan();
  }

  setEnabled(on: boolean): void {
    this.moduleOn = on;
    if (!on) this.deps.alerts.resolveAllWithPrefix(BACKUP_TARGET_ALERT_PREFIX);
    this.plan();
  }

  settings(): BackupTargetSettings {
    const r = backupTargetSettingsSchema.safeParse(readSetting(this.deps.db, SETTINGS_KEY));
    return r.success ? r.data : { ...BACKUP_TARGET_DEFAULTS };
  }

  /** Throws 'unknown_server' when an id is not a server of this core. */
  update(input: BackupTargetSettings): BackupTargetSettings {
    const s = backupTargetSettingsSchema.parse(input);
    const serverIds = [...new Set(s.serverIds)];
    const ids = [...serverIds, ...(s.dbServerId ? [s.dbServerId] : [])];
    if (ids.length > 0) {
      const known = new Set(
        this.deps.db
          .select({ id: servers.id })
          .from(servers)
          .where(inArray(servers.id, ids))
          .all()
          .map((r) => r.id),
      );
      if (ids.some((id) => !known.has(id))) throw new Error('unknown_server');
    }
    const next = { ...s, serverIds };
    const now = this.deps.now();
    writeSetting(this.deps.db, SETTINGS_KEY, next, now);
    writeAudit(this.deps.db, now, {
      actor: 'admin',
      action: 'storage.backupTarget.update',
      details: {
        enabled: next.enabled,
        servers: next.serverIds.length,
        db: next.dbServerId !== null,
        keep: next.keep,
        time: next.time,
      },
    });
    // Servers that are no longer targets keep no alerts.
    this.resolveStale(next);
    this.plan();
    return next;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  get nextRunAt(): number | null {
    return this.next;
  }

  /** Scheduler (every minute): starts the nightly run when it is due. */
  tick(): void {
    if (this.next === null || this.deps.now() < this.next) return;
    this.plan(this.deps.now());
    if (this.running) return;
    void this.start().catch(() => undefined);
  }

  /** "Jetzt kopieren". Throws BackupTargetBusyError while a run is going on. */
  start(): Promise<void> {
    if (this.running) return Promise.reject(new BackupTargetBusyError());
    const run = this.runAll().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  view(): BackupTargetResponse {
    const s = this.settings();
    const state = this.state();
    const ids = [...new Set([...s.serverIds, ...(s.dbServerId ? [s.dbServerId] : [])])];
    const rows =
      ids.length === 0
        ? []
        : this.deps.db
            .select({ id: servers.id, name: servers.name })
            .from(servers)
            .where(inArray(servers.id, ids))
            .all();
    const names = new Map(rows.map((r) => [r.id, r.name]));
    return {
      settings: s,
      running: this.isRunning,
      nextRunAt: this.next,
      servers: ids
        .filter((id) => names.has(id))
        .map((id) => {
          const st = state.servers[id];
          return {
            serverId: id,
            name: names.get(id) ?? id,
            online: this.deps.hub.isConnected(id),
            status: st?.status ?? null,
            statusAt: st?.statusAt ?? null,
            lastRun: st?.lastRun ?? null,
          };
        }),
      db: { lastRun: state.db.lastRun },
    };
  }

  // ---------------------------------------------------------------------------

  private plan(from = this.deps.now()): void {
    const s = this.settings();
    if (!this.moduleOn || !s.enabled || (s.serverIds.length === 0 && !s.dbServerId)) {
      this.next = null;
      return;
    }
    const m = hhmmToMinutes(s.time);
    this.next = nextWallClock(from, { hour: Math.floor(m / 60), minute: m % 60 });
  }

  private state(): State {
    const r = stateSchema.safeParse(readSetting(this.deps.db, STATE_KEY) ?? {});
    return r.success ? r.data : { servers: {}, db: { lastRun: null } };
  }

  private saveServer(id: string, patch: Partial<ServerState>): void {
    const st = this.state();
    const prev = st.servers[id] ?? { status: null, statusAt: null, lastRun: null };
    st.servers[id] = { ...prev, ...patch };
    writeSetting(this.deps.db, STATE_KEY, st, this.deps.now());
  }

  private saveDb(lastRun: State['db']['lastRun']): void {
    const st = this.state();
    st.db = { lastRun };
    writeSetting(this.deps.db, STATE_KEY, st, this.deps.now());
  }

  private serverName(id: string): string {
    return (
      this.deps.db.select({ name: servers.name }).from(servers).where(eq(servers.id, id)).get()
        ?.name ?? id
    );
  }

  private resolveStale(s: BackupTargetSettings): void {
    for (const id of Object.keys(this.state().servers)) {
      if (s.enabled && s.serverIds.includes(id)) continue;
      this.deps.alerts.resolve(backupTargetAlertKey({ serverId: id, kind: 'mount' }));
      this.deps.alerts.resolve(backupTargetAlertKey({ serverId: id, kind: 'sync' }));
    }
    if (!s.enabled || !s.dbServerId) this.deps.alerts.resolve(backupTargetAlertKey({ kind: 'db' }));
  }

  private async runAll(): Promise<void> {
    const s = this.settings();
    if (!this.moduleOn || !s.enabled) return;
    for (const id of s.serverIds) {
      try {
        await this.runServer(id, s.keep);
      } catch (err) {
        this.logError(err, 'backup target run failed');
      }
    }
    if (s.dbServerId) {
      try {
        await this.runDb(s.dbServerId, s.keep);
      } catch (err) {
        this.logError(err, 'backup target database copy failed');
      }
    }
  }

  private async status(id: string): Promise<BackupTargetStatusData> {
    const data = await this.deps.hub.call(
      id,
      'backup.target.status',
      {},
      {
        timeoutMs: STATUS_TIMEOUT_MS,
      },
    );
    const status = backupTargetStatusDataSchema.parse(data);
    this.saveServer(id, { status, statusAt: this.deps.now() });
    return status;
  }

  /** Raises or resolves the "not mounted" warning; returns whether the target is usable. */
  private checkMount(id: string, status: BackupTargetStatusData): BackupTargetError | null {
    const key = backupTargetAlertKey({ serverId: id, kind: 'mount' });
    const name = this.serverName(id);
    if (status.state === 'mounted') {
      this.deps.alerts.resolve(key, {
        title: `Backup-Ziel auf ${name} wieder eingebunden`,
        body: 'Die Kopien laufen wieder.',
      });
      return null;
    }
    const ro = status.state === 'read_only';
    this.deps.alerts.raise(
      key,
      'warn',
      ro
        ? `Backup-Ziel auf ${name} ist schreibgeschützt`
        : `Backup-Ziel auf ${name} ist nicht eingebunden`,
      ro
        ? 'Die Freigabe ist nur lesbar eingebunden. Rechte des NAS-Benutzers und die Mount-Optionen prüfen.'
        : 'Unter /opt/homelab/backup-target ist keine Freigabe eingebunden, es wurde nichts kopiert. NAS einschalten und die Freigabe neu einbinden (sudo mount /opt/homelab/backup-target).',
      id,
      'system',
    );
    return ro ? 'read_only' : 'not_mounted';
  }

  private async runServer(id: string, keep: number): Promise<void> {
    const at = this.deps.now();
    const record = (run: Omit<BackupTargetRun, 'at'>) =>
      this.saveServer(id, { lastRun: { at, ...run } });
    if (!this.deps.hub.isConnected(id)) {
      record({ ok: false, copied: 0, bytes: 0, error: 'offline' });
      return;
    }
    const mountError = this.checkMount(id, await this.status(id));
    if (mountError) {
      record({ ok: false, copied: 0, bytes: 0, error: mountError });
      return;
    }
    const gameIds = this.deps.db
      .select({ name: gameServers.name })
      .from(gameServers)
      .where(eq(gameServers.serverId, id))
      .all()
      .map((r) => r.name);
    const data = backupTargetSyncDataSchema.parse(
      await this.deps.hub.call(
        id,
        'backup.target.sync',
        { gameIds, keep },
        {
          timeoutMs: SYNC_TIMEOUT_MS,
        },
      ),
    );
    if (data.state !== 'mounted') {
      // Dropped between status and sync.
      const err = this.checkMount(id, { ...emptyStatus(), state: data.state });
      record({ ok: false, copied: 0, bytes: 0, error: err ?? 'not_mounted' });
      return;
    }
    const copied = data.games.reduce((a, g) => a + g.copied, 0);
    const bytes = data.games.reduce((a, g) => a + g.bytes, 0);
    const failed = data.games.filter((g) => g.error !== null);
    const key = backupTargetAlertKey({ serverId: id, kind: 'sync' });
    const name = this.serverName(id);
    if (failed.length > 0) {
      const noSpace = failed.some((g) => g.error === 'no_space');
      this.deps.alerts.raise(
        key,
        'warn',
        noSpace
          ? `Backup-Ziel auf ${name} ist voll`
          : `Backups von ${name} nicht vollständig aufs NAS kopiert`,
        `${failed.map((g) => g.gameId).join(', ')}: ${
          noSpace
            ? 'auf dem NAS ist zu wenig Platz. Alte Dateien auf der Freigabe löschen oder weniger Kopien behalten.'
            : 'Kopieren fehlgeschlagen. Freigabe und Verbindung zum NAS prüfen; der nächste Lauf versucht es wieder.'
        }`,
        id,
        'system',
      );
    } else {
      this.deps.alerts.resolve(key, {
        title: `Backups von ${name} wieder aufs NAS kopiert`,
        body: `${copied} neue Kopien, ${gigabytes(bytes)}.`,
      });
    }
    record({
      ok: failed.length === 0,
      copied,
      bytes,
      error:
        failed.length === 0
          ? null
          : failed.some((g) => g.error === 'no_space')
            ? 'no_space'
            : 'failed',
    });
    await this.status(id).catch(() => undefined);
  }

  private async runDb(id: string, keep: number): Promise<void> {
    const at = this.deps.now();
    const fileName = exportFileName(at);
    const key = backupTargetAlertKey({ kind: 'db' });
    const fail = (error: BackupTargetError) => {
      this.saveDb({ at, ok: false, copied: 0, bytes: 0, error, fileName: null });
      if (error === 'offline') return;
      const name = this.serverName(id);
      this.deps.alerts.raise(
        key,
        'warn',
        'Datenbank-Kopie aufs NAS fehlgeschlagen',
        error === 'not_mounted' || error === 'read_only'
          ? `Das Backup-Ziel auf ${name} ist nicht beschreibbar eingebunden. Freigabe prüfen; der nächste Lauf versucht es wieder.`
          : error === 'no_space'
            ? `Auf dem Backup-Ziel auf ${name} ist zu wenig Platz.`
            : `Die Kopie an ${name} ist abgebrochen. Der nächste Lauf versucht es wieder.`,
        id,
        'system',
      );
    };
    if (!this.deps.hub.isConnected(id)) return fail('offline');
    const status = await this.status(id).catch(() => null);
    if (!status) return fail('failed');
    const mountError = this.checkMount(id, status);
    if (mountError) return fail(mountError);

    const tmp = join(this.deps.dataDir, `${TEMP_PREFIX}${randomToken(16)}.sqlite`);
    let fh: FileHandle | null = null;
    try {
      await writeFile(tmp, '', { mode: 0o600, flag: 'wx' });
      this.deps.sqlite.prepare('VACUUM INTO ?').run(tmp);
      fh = await open(tmp, 'r');
      const bytes = (await fh.stat()).size;
      if (bytes < 1 || bytes > CORE_DB_MAX_BYTES) return fail('failed');
      const sha256 = await hashHandle(fh, bytes);
      if (status.freeBytes !== null && status.freeBytes < bytes) return fail('no_space');
      const result = await this.send(id, fh, { fileName, bytes, sha256, keep });
      if (!result) return fail('failed');
      this.saveDb({ at, ok: true, copied: 1, bytes, error: null, fileName });
      this.deps.alerts.resolve(key, {
        title: 'Datenbank-Kopie aufs NAS wieder erfolgreich',
        body: `${fileName}, ${gigabytes(bytes)}.`,
      });
      await this.status(id).catch(() => undefined);
    } finally {
      await fh?.close().catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
    }
  }

  /** Sends the open snapshot with backup.target.store; true when the agent stored it. */
  private async send(
    id: string,
    fh: FileHandle,
    p: { fileName: string; bytes: number; sha256: string; keep: number },
  ): Promise<boolean> {
    const chunks = Math.ceil(p.bytes / TRANSFER_CHUNK_BYTES);
    let acked = -1;
    let wake: (() => void) | null = null;
    let protocolError = false;
    let stream: RpcStream;
    let sent = 0;
    try {
      stream = this.deps.hub.stream(
        id,
        'backup.target.store',
        { ...p, chunks },
        {
          timeoutMs: STORE_TIMEOUT_MS,
          onTransfer: (f: TransferFrame) => {
            if (f.type !== 'transfer.ack' || f.seq >= sent) protocolError = true;
            else if (f.seq > acked) acked = f.seq;
            wake?.();
          },
        },
      );
    } catch {
      return false;
    }
    let resultLine = '';
    let partial = '';
    stream.on('data', (c: { channel: string; chunk: string }) => {
      if (c.channel !== 'progress') return;
      const lines = (partial + c.chunk).split('\n');
      partial = (lines.pop() ?? '').slice(-4096);
      for (const line of lines) if (line.startsWith('result ')) resultLine = line;
    });
    let ended = false;
    void stream.done.then(() => {
      ended = true;
      wake?.();
    });
    const waitFor = async (ready: () => boolean, ms: number): Promise<boolean> => {
      const until = Date.now() + ms;
      while (!ready()) {
        if (ended || protocolError || Date.now() > until) return false;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 50);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = null;
      }
      return true;
    };
    try {
      let accepted = false;
      void stream.result.then(() => {
        if (!stream.isEnded) accepted = true;
        wake?.();
      });
      if (!(await waitFor(() => accepted, ACCEPT_TIMEOUT_MS))) return false;
      const hash = createHash('sha256');
      for (let seq = 0; seq < chunks; seq++) {
        const ok = await waitFor(
          () =>
            sent - (acked + 1) < TRANSFER_WINDOW &&
            this.deps.hub.bufferedAmount(id) < 4 * 1024 * 1024,
          ACK_TIMEOUT_MS,
        );
        if (!ok) return false;
        const len = Math.min(TRANSFER_CHUNK_BYTES, p.bytes - seq * TRANSFER_CHUNK_BYTES);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, seq * TRANSFER_CHUNK_BYTES);
        if (bytesRead !== len) return false;
        hash.update(buf);
        const frame = {
          type: 'transfer.chunk' as const,
          streamId: stream.id,
          seq,
          data: buf.toString('base64'),
        };
        if (!this.deps.hub.sendTransfer(id, frame)) return false;
        sent = seq + 1;
      }
      if (!(await waitFor(() => acked === chunks - 1, ACK_TIMEOUT_MS))) return false;
      if (hash.digest('hex') !== p.sha256) return false;
      this.deps.hub.sendTransfer(id, {
        type: 'transfer.end',
        streamId: stream.id,
        chunks,
        bytes: p.bytes,
        sha256: p.sha256,
      });
      const end = await stream.done;
      if (end.code !== 0) return false;
      if (partial.startsWith('result ')) resultLine = partial;
      let json: unknown = null;
      try {
        json = JSON.parse(resultLine.slice('result '.length));
      } catch {
        return false;
      }
      const r = backupTargetStoreDataSchema.safeParse(json);
      return r.success && r.data.sha256 === p.sha256 && r.data.bytes === p.bytes;
    } finally {
      if (!stream.isEnded) stream.cancel();
    }
  }

  private logError(err: unknown, msg: string): void {
    this.deps.log.error(
      {
        err:
          err instanceof Error ? { name: err.name, message: err.message.slice(0, 200) } : 'error',
      },
      msg,
    );
  }
}

function emptyStatus(): BackupTargetStatusData {
  return {
    state: 'not_mounted',
    fs: null,
    freeBytes: null,
    totalBytes: null,
    games: [],
    core: { files: 0, bytes: 0, newest: null },
  };
}

async function hashHandle(fh: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const step = 1024 * 1024;
  const buf = Buffer.alloc(step);
  for (let pos = 0; pos < size;) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(step, size - pos), pos);
    if (bytesRead === 0) throw new Error('short read');
    hash.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
  return hash.digest('hex');
}

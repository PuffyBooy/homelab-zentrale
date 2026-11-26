import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  statfs,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {
  BACKUP_TARGET_DIR,
  BACKUP_TARGET_MAX_GAMES,
  BACKUP_TARGET_RESERVE_BYTES,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_IDLE_TIMEOUT_MS,
  TRANSFER_WINDOW,
  type BackupTargetState,
  type BackupTargetStatusData,
  type BackupTargetStoreData,
  type BackupTargetSyncData,
  type RpcParams,
  type TransferChunk,
  type TransferEnd,
  type TransferErrorCode,
} from '@hz/shared';
import { hostPath } from '../host.js';
import type { StreamSink, TransferIn } from '../streams.js';
import { backupFilePattern } from './game-backup.js';
import { GAME_NAME } from './game-common.js';
import { TransferFailure } from './game-transfer.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * M13b: backup.target.status / .sync / .store (contract in
 * packages/shared/src/agent-backup-target.ts).
 *
 * The target is /opt/homelab/backup-target on the HOST. The agent sees the host's
 * mount namespace through hostRoot (/host/proc/1/root), so a share the admin
 * mounts after the agent started is visible without restarting it, and reads
 * the host mount table from /host/proc/1/mounts.
 *
 * Rules:
 * - Nothing is written unless the target path is itself a mount point (mount table
 *   entry AND a different device than its parent folder) and mounted read-write.
 *   A dropped share therefore never fills the server's own disk.
 * - Below the target only games/<gameId>/ and core/ are used; every folder is checked
 *   with lstat (no symlink is ever followed, files are opened with O_NOFOLLOW).
 * - Copies are written to a dot-name `.partial` file (O_EXCL), read back and compared
 *   (size + sha256), then renamed into place. Retention deletes only names that
 *   match the backup patterns.
 * - One sync or store at a time per agent.
 */

const COPY_STEP = 1024 * 1024;
const WRITE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
export const CORE_DB_PATTERN = /^homelab-zentrale-\d{8}-\d{4}\.sqlite$/;
const PARTIAL_RE = /^\.(.+)\.[0-9a-f]{8}\.partial$/;

let busy = false;
/** Tests only. */
export function resetBackupTargetLock(): void {
  busy = false;
}

function acquire(): () => void {
  if (busy) throw new ActionError('busy', 'a backup target copy is already running', false);
  busy = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    busy = false;
  };
}

export interface Target {
  state: BackupTargetState;
  fs: string | null;
  /** Where the agent reads and writes the target (host path via hostRoot). */
  view: string;
}

/** source, mount point, fs, options of /proc/<pid>/mounts (octal escapes decoded). */
export function parseMountLines(text: string): { mount: string; fs: string; options: string[] }[] {
  const dec = (s: string) =>
    s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
  const out: { mount: string; fs: string; options: string[] }[] = [];
  for (const line of text.split('\n')) {
    const [, mount, fs, opts] = line.split(' ');
    if (!mount || !fs || !opts) continue;
    out.push({ mount: dec(mount), fs, options: opts.split(',') });
  }
  return out;
}

/** Device id of a path (stat follows the last component, like the kernel for a mount point). */
export type DevOf = (p: string) => Promise<number | null>;
const devOf: DevOf = (p) =>
  stat(p).then(
    (s) => s.dev,
    () => null,
  );

export async function resolveTarget(ctx: ActionContext, dev: DevOf = devOf): Promise<Target> {
  const mountPath = path.join(ctx.homelabRoot, BACKUP_TARGET_DIR);
  const view = hostPath(ctx.host, mountPath);
  const st = await lstat(view).catch(() => null);
  if (!st) return { state: 'missing', fs: null, view };
  if (!st.isDirectory()) return { state: 'not_mounted', fs: null, view };
  const text = await readFile(path.join(ctx.host.hostProc, '1', 'mounts'), 'utf8').catch(() => '');
  // The last entry for a path is the one on top (mounted last).
  const entry = parseMountLines(text)
    .filter((e) => e.mount === mountPath)
    .at(-1);
  if (!entry) return { state: 'not_mounted', fs: null, view };
  // Second opinion from the file system itself: a mount point has its own device.
  const [own, parent] = await Promise.all([dev(view), dev(path.dirname(view))]);
  if (own === null || parent === null || own === parent) {
    return { state: 'not_mounted', fs: null, view };
  }
  const fs = entry.fs.slice(0, 32);
  if (entry.options.includes('ro')) return { state: 'read_only', fs, view };
  return { state: 'mounted', fs, view };
}

async function space(view: string): Promise<{ free: number | null; total: number | null }> {
  const s = await statfs(view).catch(() => null);
  if (!s) return { free: null, total: null };
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
}

/** Creates (if needed) `parent/name` and checks it is a real folder, never a symlink. */
async function ensureDir(parent: string, name: string): Promise<string> {
  const p = path.join(parent, name);
  let st = await lstat(p).catch(() => null);
  if (!st) {
    try {
      await mkdir(p, { mode: 0o750 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ActionError('failed', 'creating a folder on the backup target failed');
      }
    }
    st = await lstat(p).catch(() => null);
  }
  if (!st?.isDirectory())
    throw new ActionError('bad_path', 'not a real folder on the backup target');
  return p;
}

/** Regular files in `dir` whose names match `re` (lstat: symlinks are skipped). */
async function matchingFiles(dir: string, re: RegExp): Promise<{ name: string; size: number }[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: { name: string; size: number }[] = [];
  for (const name of names.filter((n) => re.test(n)).sort()) {
    const st = await lstat(path.join(dir, name)).catch(() => null);
    if (st?.isFile()) out.push({ name, size: st.size });
  }
  return out;
}

/** Deletes all but the newest `keep` (by name = time stamp) files matching `re`. */
async function retention(dir: string, re: RegExp, keep: number): Promise<number> {
  const files = await matchingFiles(dir, re);
  let removed = 0;
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    // unlink never follows a symlink; matchingFiles only returned regular files.
    await unlink(path.join(dir, f.name))
      .then(() => (removed += 1))
      .catch(() => undefined);
  }
  return removed;
}

/** Leftover `.partial` files of `re`-names (only one copy runs at a time, so all are stale). */
async function removePartials(dir: string, re: RegExp): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const m = PARTIAL_RE.exec(name);
    if (!m?.[1] || !re.test(m[1])) continue;
    const st = await lstat(path.join(dir, name)).catch(() => null);
    if (st?.isFile()) await unlink(path.join(dir, name)).catch(() => undefined);
  }
}

const partialName = (name: string) => `.${name}.${randomBytes(4).toString('hex')}.partial`;

async function hashFile(fh: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(COPY_STEP);
  let pos = 0;
  while (pos < size) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(COPY_STEP, size - pos), pos);
    if (bytesRead === 0) throw new Error('short read');
    hash.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
  return hash.digest('hex');
}

/** Reads `tmp` back and compares size and sha256 (catches a share that stored garbage). */
async function verifyCopy(tmp: string, size: number, sha256: string): Promise<boolean> {
  const fh = await open(tmp, READ_FLAGS);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size !== size) return false;
    return (await hashFile(fh, size)) === sha256;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Copies one open source file to dir/name via a verified .partial file. */
async function copyInto(src: FileHandle, size: number, dir: string, name: string): Promise<void> {
  const tmp = path.join(dir, partialName(name));
  let out: FileHandle | null = await open(tmp, WRITE_FLAGS, 0o640);
  try {
    const hash = createHash('sha256');
    const buf = Buffer.alloc(COPY_STEP);
    let pos = 0;
    while (pos < size) {
      const { bytesRead } = await src.read(buf, 0, Math.min(COPY_STEP, size - pos), pos);
      if (bytesRead === 0) throw new Error('source changed');
      const chunk = buf.subarray(0, bytesRead);
      hash.update(chunk);
      let off = 0;
      while (off < chunk.length) {
        const { bytesWritten } = await out.write(chunk, off, chunk.length - off);
        off += bytesWritten;
      }
      pos += bytesRead;
    }
    await out.sync();
    await out.close();
    out = null;
    if (!(await verifyCopy(tmp, size, hash.digest('hex')))) throw new Error('copy differs');
    await rename(tmp, path.join(dir, name));
  } catch (err) {
    await out?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// ---- backup.target.status ---------------------------------------------------------

/** Tests: replaces the mount check (a test cannot mount a share). */
export interface TargetOptions {
  resolve?: (ctx: ActionContext) => Promise<Target>;
  idleTimeoutMs?: number;
}

export async function backupTargetStatus(
  _params: RpcParams<'backup.target.status'>,
  ctx: ActionContext,
  opts: TargetOptions = {},
): Promise<BackupTargetStatusData> {
  const t = await (opts.resolve ?? resolveTarget)(ctx);
  const empty = { files: 0, bytes: 0, newest: null };
  if (t.state !== 'mounted' && t.state !== 'read_only') {
    return { state: t.state, fs: t.fs, freeBytes: null, totalBytes: null, games: [], core: empty };
  }
  const { free, total } = await space(t.view);
  const summary = async (dir: string, re: RegExp) => {
    const files = await matchingFiles(dir, re);
    return {
      files: files.length,
      bytes: files.reduce((a, f) => a + f.size, 0),
      newest: files.at(-1)?.name ?? null,
    };
  };
  const games: BackupTargetStatusData['games'] = [];
  const gamesDir = path.join(t.view, 'games');
  const gst = await lstat(gamesDir).catch(() => null);
  if (gst?.isDirectory()) {
    const names = (await readdir(gamesDir).catch(() => [] as string[]))
      .filter((n) => GAME_NAME.test(n))
      .sort()
      .slice(0, BACKUP_TARGET_MAX_GAMES);
    for (const gameId of names) {
      const dir = path.join(gamesDir, gameId);
      const st = await lstat(dir).catch(() => null);
      if (!st?.isDirectory()) continue;
      games.push({ gameId, ...(await summary(dir, backupFilePattern(gameId))) });
    }
  }
  const coreDir = path.join(t.view, 'core');
  const cst = await lstat(coreDir).catch(() => null);
  const core = cst?.isDirectory() ? await summary(coreDir, CORE_DB_PATTERN) : empty;
  return { state: t.state, fs: t.fs, freeBytes: free, totalBytes: total, games, core };
}

// ---- backup.target.sync -----------------------------------------------------------

type SyncGame = BackupTargetSyncData['games'][number];

async function syncGame(
  ctx: ActionContext,
  targetView: string,
  gameId: string,
  keep: number,
): Promise<SyncGame> {
  const r: SyncGame = { gameId, copied: 0, skipped: 0, removed: 0, bytes: 0, error: null };
  const src = path.join(ctx.homelabRoot, 'backups', gameId);
  const sst = await lstat(src).catch(() => null);
  if (!sst) return r;
  if (!sst.isDirectory()) return { ...r, error: 'bad_path' };
  const re = backupFilePattern(gameId);
  // Only the newest `keep`: older ones would be deleted by retention right away.
  const want = (await matchingFiles(src, re)).slice(-keep);
  let dst: string;
  try {
    dst = await ensureDir(await ensureDir(targetView, 'games'), gameId);
  } catch (err) {
    return {
      ...r,
      error: err instanceof ActionError && err.code === 'bad_path' ? 'bad_path' : 'io',
    };
  }
  await removePartials(dst, re);
  for (const f of want) {
    let fh: FileHandle | null = null;
    try {
      fh = await open(path.join(src, f.name), READ_FLAGS);
      const st = await fh.stat();
      if (!st.isFile()) continue;
      const existing = await lstat(path.join(dst, f.name)).catch(() => null);
      if (existing && !existing.isFile()) return { ...r, error: 'bad_path' };
      if (existing && existing.size === st.size) {
        r.skipped += 1;
        continue;
      }
      const { free } = await space(dst);
      if (free !== null && free < st.size + BACKUP_TARGET_RESERVE_BYTES) {
        return { ...r, error: 'no_space' };
      }
      await copyInto(fh, st.size, dst, f.name);
      r.copied += 1;
      r.bytes += st.size;
    } catch {
      return { ...r, error: 'io' };
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }
  r.removed = await retention(dst, re, keep);
  return r;
}

export async function backupTargetSync(
  params: RpcParams<'backup.target.sync'>,
  ctx: ActionContext,
  opts: TargetOptions = {},
): Promise<BackupTargetSyncData> {
  const release = acquire();
  try {
    const t = await (opts.resolve ?? resolveTarget)(ctx);
    if (t.state !== 'mounted') {
      return { state: t.state, games: [], freeBytes: null, totalBytes: null };
    }
    const games: SyncGame[] = [];
    for (const gameId of [...new Set(params.gameIds)]) {
      games.push(await syncGame(ctx, t.view, gameId, params.keep));
    }
    const { free, total } = await space(t.view);
    return { state: 'mounted', games, freeBytes: free, totalBytes: total };
  } finally {
    release();
  }
}

// ---- backup.target.store (stream, the core sends) -----------------------------------

export const STORE_RESULT_PREFIX = 'result ';

export async function backupTargetStore(
  params: RpcParams<'backup.target.store'>,
  ctx: ActionContext,
  rpcId: string,
  opts: TargetOptions = {},
): Promise<{ streamId: string }> {
  const release = acquire();
  let started = false;
  try {
    const t = await (opts.resolve ?? resolveTarget)(ctx);
    if (t.state !== 'mounted') {
      throw new ActionError('failed', `backup target ${t.state.replace('_', ' ')}`, false);
    }
    const { free } = await space(t.view);
    if (free !== null && free < params.bytes + BACKUP_TARGET_RESERVE_BYTES) {
      throw new ActionError('failed', 'not enough space on the backup target', false);
    }
    const dir = await ensureDir(t.view, 'core');
    await removePartials(dir, CORE_DB_PATTERN);
    const tmp = path.join(dir, partialName(params.fileName));
    const fh = await open(tmp, WRITE_FLAGS, 0o600);
    const sink = ctx.streams.open(rpcId);
    started = true;
    void runStore({ params, dir, tmp, fh }, sink, opts.idleTimeoutMs ?? TRANSFER_IDLE_TIMEOUT_MS)
      .catch((err: unknown) => ctx.log.error('backup target store failed', { error: err }))
      .finally(release);
    return { streamId: rpcId };
  } finally {
    if (!started) release();
  }
}

async function runStore(
  job: { params: RpcParams<'backup.target.store'>; dir: string; tmp: string; fh: FileHandle },
  sink: StreamSink,
  idleMs: number,
): Promise<void> {
  const { params, dir, tmp } = job;
  const streamId = sink.id;
  let fh: FileHandle | null = job.fh;
  let next = 0;
  let received = 0;
  const hash = createHash('sha256');
  let writes: Promise<void> = Promise.resolve();
  let idle: NodeJS.Timeout | null = null;
  let settle: ((r: TransferFailure | TransferEnd) => void) | null = null;
  const done = new Promise<TransferFailure | TransferEnd>((resolve) => (settle = resolve));
  const finish = (r: TransferFailure | TransferEnd) => {
    const s = settle;
    settle = null;
    if (idle) clearTimeout(idle);
    idle = null;
    s?.(r);
  };
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(
      () => finish(new TransferFailure('timeout', 'no data from the core')),
      idleMs,
    );
  };
  let acked = -1;

  const onChunk = (msg: TransferChunk) => {
    if (msg.seq !== next || msg.seq >= params.chunks) {
      return finish(new TransferFailure('sequence', 'unexpected chunk seq'));
    }
    if (msg.seq - acked > TRANSFER_WINDOW) {
      return finish(new TransferFailure('sequence', 'transfer window exceeded'));
    }
    const buf = Buffer.from(msg.data, 'base64');
    if (buf.toString('base64') !== msg.data) {
      return finish(new TransferFailure('sequence', 'invalid chunk encoding'));
    }
    const last = msg.seq === params.chunks - 1;
    const want = last
      ? params.bytes - TRANSFER_CHUNK_BYTES * (params.chunks - 1)
      : TRANSFER_CHUNK_BYTES;
    if (buf.length !== want) return finish(new TransferFailure('sequence', 'wrong chunk size'));
    next += 1;
    received += buf.length;
    hash.update(buf);
    armIdle();
    const seq = msg.seq;
    const out = fh;
    writes = writes.then(async () => {
      if (!settle || !out) return;
      try {
        let off = 0;
        while (off < buf.length) {
          const { bytesWritten } = await out.write(buf, off, buf.length - off);
          off += bytesWritten;
        }
      } catch {
        finish(new TransferFailure('io', 'writing to the backup target failed'));
        return;
      }
      if (!settle) return;
      acked = seq;
      sink.transfer({ type: 'transfer.ack', streamId, seq });
    });
  };

  sink.onCancel(() => finish(new TransferFailure('cancelled', 'cancelled')));
  sink.onTransfer((msg: TransferIn) => {
    if (!settle) return;
    if (msg.type === 'transfer.chunk') onChunk(msg);
    else if (msg.type === 'transfer.end') {
      if (next !== params.chunks) {
        return finish(new TransferFailure('sequence', 'transfer ended early'));
      }
      if (
        msg.chunks !== params.chunks ||
        msg.bytes !== params.bytes ||
        msg.sha256 !== params.sha256
      ) {
        return finish(new TransferFailure('checksum_mismatch', 'transfer.end differs'));
      }
      if (idle) clearTimeout(idle);
      idle = null;
      void writes.then(() => finish(msg));
    } else finish(new TransferFailure('sequence', 'unexpected transfer frame'));
  });
  armIdle();

  let failed: TransferErrorCode | null = null;
  let result: BackupTargetStoreData | null = null;
  try {
    const r = await done;
    if (r instanceof TransferFailure) throw r;
    await writes;
    await fh.sync();
    await fh.close();
    fh = null;
    const sha256 = hash.digest('hex');
    if (received !== params.bytes || sha256 !== params.sha256) {
      throw new TransferFailure('checksum_mismatch', 'size or checksum differs');
    }
    if (!(await verifyCopy(tmp, params.bytes, params.sha256))) {
      throw new TransferFailure('io', 'the copy on the backup target differs');
    }
    await rename(tmp, path.join(dir, params.fileName));
    const removed = await retention(dir, CORE_DB_PATTERN, params.keep);
    result = { fileName: params.fileName, bytes: received, sha256, removed };
  } catch (err) {
    failed = err instanceof TransferFailure ? err.code : 'io';
  } finally {
    if (idle) clearTimeout(idle);
    await fh?.close().catch(() => undefined);
    if (!result) await unlink(tmp).catch(() => undefined);
  }
  if (result) {
    sink.data('progress', `${STORE_RESULT_PREFIX}${JSON.stringify(result)}\n`);
    sink.end(0);
  } else if (failed !== 'cancelled') sink.end(1, failed ?? 'io');
}

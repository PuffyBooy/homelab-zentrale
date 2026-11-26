import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, stat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  TRANSFER_CHUNK_BYTES,
  TRANSFER_IDLE_TIMEOUT_MS,
  TRANSFER_WINDOW,
  type RpcParams,
  type TransferErrorCode,
} from '@hz/shared';
import type { SpawnHandle } from '../exec.js';
import type { StreamSink, TransferIn } from '../streams.js';
import { acquireDirLock } from './dir-lock.js';
import { ensureBackupDir, templateOf } from './game-backup.js';
import { readGameEnv, rconFromEnv, resolveGameDir, type GameDir } from './game-common.js';
import {
  TAR_TIMEOUT_MS,
  TransferFailure,
  exportFileName,
  exportTarArgs,
  listAndCheckArchive,
  type Compression,
} from './game-transfer.js';
import { rconRun } from './rcon.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * game.export (M11), a stream with rpc id = stream id = transfer id.
 *
 * Before the rpc.result: /opt/homelab/games/<gameId>/ and its `data` are real
 * directories, /opt/homelab/backups/<gameId>/ is (or becomes) a real directory, the
 * per-folder lock is free (no backup/compose action in parallel).
 *
 * Then:
 *   1. [Minecraft Java: save-off, save-all flush over RCON, best effort]
 *   2. tar --zstd of `data` only (never compose.yml or .env) into
 *      backups/<gameId>/.export-<streamId>.tar.zst (O_EXCL, 0600). transfer.begin needs
 *      size and sha256 up front, so the archive is built completely first. Growing
 *      past maxBytes kills tar (too_large).
 *   3. sha256 over the file, transfer.begin {bytes, sha256, chunks}.
 *   4. transfer.chunk seq 0..chunks-1 of exactly TRANSFER_CHUNK_BYTES (last shorter).
 *      At most TRANSFER_WINDOW chunks are unacknowledged; the file is read only when
 *      the window (and the WebSocket buffer) has room.
 *   5. After the ack of the last chunk: transfer.end, stream.end 0.
 * Errors end the stream with code 1 and error = transferErrorCode. The temp file is
 * always deleted (end, error, cancel). No ack for TRANSFER_IDLE_TIMEOUT_MS: timeout.
 */

export interface TransferOptions {
  compression?: Compression;
  idleTimeoutMs?: number;
  /** game.import: lchown replacement for tests. */
  chown?: (p: string, uid: number, gid: number) => Promise<void>;
}

const SIZE_POLL_MS = 1000;
const WAIT_POLL_MS = 50;

async function readExact(fh: FileHandle, len: number, pos: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
    if (bytesRead === 0) throw new TransferFailure('io', 'archive changed while sending');
    off += bytesRead;
  }
  return buf;
}

async function sha256Of(fh: FileHandle, size: number, isCancelled: () => boolean): Promise<string> {
  const hash = createHash('sha256');
  const step = 1024 * 1024;
  for (let pos = 0; pos < size && !isCancelled(); pos += step) {
    hash.update(await readExact(fh, Math.min(step, size - pos), pos));
  }
  return hash.digest('hex');
}

interface ExportJob {
  game: GameDir;
  tmp: string;
  maxBytes: number;
}

export async function runExport(
  job: ExportJob,
  ctx: ActionContext,
  sink: StreamSink,
  opts: TransferOptions = {},
): Promise<void> {
  const compression = opts.compression ?? 'zstd';
  const idleMs = opts.idleTimeoutMs ?? TRANSFER_IDLE_TIMEOUT_MS;
  const progress = (text: string) => sink.data('progress', `${text}\n`);
  const streamId = sink.id;

  let cancelled = false;
  let tar: SpawnHandle | null = null;
  let wake: (() => void) | null = null;
  let fh: FileHandle | null = null;
  let tmpCreated = false;
  let poll: NodeJS.Timeout | null = null;
  let checkKill: (() => void) | null = null;
  // Ack state: highest acknowledged seq, number of chunks sent, a protocol error.
  let acked = -1;
  let sent = 0;
  let lastAckAt = Date.now();
  let ackError: TransferFailure | null = null;

  sink.onCancel(() => {
    cancelled = true;
    tar?.kill();
    checkKill?.();
    wake?.();
  });
  sink.onTransfer((msg: TransferIn) => {
    if (msg.type !== 'transfer.ack') {
      ackError ??= new TransferFailure('sequence', 'unexpected transfer frame');
    } else if (msg.seq >= sent) {
      ackError ??= new TransferFailure('sequence', 'ack for a chunk that was not sent');
    } else if (msg.seq > acked) {
      acked = msg.seq;
      lastAckAt = Date.now();
    }
    wake?.();
  });

  /** Waits until `ready()` holds; throws on cancel, a bad ack or the idle timeout. */
  const waitUntil = async (ready: () => boolean): Promise<void> => {
    for (;;) {
      if (cancelled) throw new TransferFailure('cancelled', 'cancelled');
      if (ackError) throw ackError;
      if (ready()) return;
      if (sent - 1 > acked && Date.now() - lastAckAt > idleMs) {
        throw new TransferFailure('timeout', 'no acknowledgement from the core');
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, WAIT_POLL_MS);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
    }
  };

  // Minecraft Java: flush the world and pause autosave while tar reads it (best effort).
  let rcon: { port: number; password: string } | null = null;
  let savedOff = false;
  const rconQuiet = async (commands: string[]): Promise<boolean> => {
    if (!rcon) return false;
    try {
      await rconRun({ ...rcon, timeoutMs: 15_000 }, commands);
      return true;
    } catch {
      return false;
    }
  };

  const { game, tmp, maxBytes } = job;
  let ok = false;
  let failed: TransferErrorCode | null = null;
  try {
    if ((await templateOf(ctx, game.name)) === 'minecraft-java') {
      try {
        rcon = rconFromEnv(await readGameEnv(game.dir));
      } catch {
        rcon = null;
      }
      if (rcon) {
        ctx.log.addSecret(rcon.password);
        savedOff = await rconQuiet(['save-off', 'save-all flush']);
        progress(savedOff ? 'world saved, autosave paused' : 'could not pause autosave (rcon)');
      }
    }
    if (cancelled) return;

    // O_EXCL: fails on anything existing, symlinks included. tar then truncates it.
    const created = await open(tmp, 'wx', 0o600);
    tmpCreated = true;
    await created.close();

    progress(`$ tar ${compression === 'zstd' ? '--zstd' : '--gzip'} -c -C ${game.dir} data`);
    let tooLarge = false;
    tar = ctx.spawn(
      'tar',
      exportTarArgs(tmp, game.dir, compression),
      { onStdout: () => undefined, onStderr: () => undefined },
      { timeoutMs: TAR_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 },
    );
    const running = tar;
    poll = setInterval(() => {
      void stat(tmp)
        .then((st) => {
          if (st.size > maxBytes) {
            tooLarge = true;
            running.kill();
          }
        })
        .catch(() => undefined);
    }, SIZE_POLL_MS);
    const r = await tar.done;
    tar = null;
    clearInterval(poll);
    poll = null;
    if (cancelled) return;
    if (tooLarge) throw new TransferFailure('too_large', 'archive is larger than allowed');
    if (r.error === 'not_found') throw new TransferFailure('io', 'tar not available');
    if (r.error === 'timeout') throw new TransferFailure('timeout', 'archive timed out');
    // GNU tar: 1 = some files changed while being read (the server keeps running).
    if (r.error || (r.code !== 0 && r.code !== 1)) {
      throw new TransferFailure('io', 'creating the archive failed');
    }
    if (savedOff) {
      savedOff = false;
      progress((await rconQuiet(['save-on'])) ? 'autosave resumed' : 'could not resume autosave');
    }
    // The target accepts only files and folders below data/ (checkArchiveMember). Check
    // the archive with the same rule here, so a world with a symlink, FIFO or device
    // fails now with bad_archive instead of after the whole transfer.
    await listAndCheckArchive(ctx.spawn, tmp, compression, (kill) => {
      checkKill = kill;
    });
    checkKill = null;
    if (cancelled) return;
    progress('archive checked');

    fh = await open(tmp, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile()) throw new TransferFailure('io', 'archive is not a regular file');
    const bytes = st.size;
    if (bytes > maxBytes) throw new TransferFailure('too_large', 'archive is larger than allowed');
    if (bytes < 1) throw new TransferFailure('io', 'empty archive');
    const sha256 = await sha256Of(fh, bytes, () => cancelled);
    if (cancelled) return;
    const chunks = Math.ceil(bytes / TRANSFER_CHUNK_BYTES);
    progress(`archive: ${bytes} bytes, ${chunks} chunks`);

    sink.transfer({ type: 'transfer.begin', streamId, bytes, sha256, chunks });
    lastAckAt = Date.now();
    const check = createHash('sha256');
    for (let seq = 0; seq < chunks; seq++) {
      // Backpressure: at most TRANSFER_WINDOW unacked chunks, and a drained socket.
      await waitUntil(() => sent - (acked + 1) < TRANSFER_WINDOW && !sink.congested());
      if (sent === acked + 1) lastAckAt = Date.now();
      const pos = seq * TRANSFER_CHUNK_BYTES;
      const buf = await readExact(fh, Math.min(TRANSFER_CHUNK_BYTES, bytes - pos), pos);
      check.update(buf);
      sink.transfer({ type: 'transfer.chunk', streamId, seq, data: buf.toString('base64') });
      sent = seq + 1;
    }
    await waitUntil(() => acked === chunks - 1);
    if (check.digest('hex') !== sha256)
      throw new TransferFailure('io', 'archive changed while sending');
    sink.transfer({ type: 'transfer.end', streamId, chunks, bytes, sha256 });
    progress('transfer complete');
    ok = true;
  } catch (err) {
    if (cancelled) return;
    const failure =
      err instanceof TransferFailure ? err : new TransferFailure('io', 'export failed');
    if (!(err instanceof TransferFailure)) ctx.log.error('export failed', { error: err });
    progress(`error: ${failure.message}`);
    failed = failure.code;
  } finally {
    if (poll) clearInterval(poll);
    tar?.kill();
    await fh?.close().catch(() => undefined);
    if (tmpCreated) await unlink(tmp).catch(() => undefined);
    if (savedOff) await rconQuiet(['save-on']);
  }
  // Only after the temp files are gone, so the core never sees a leftover.
  if (ok) sink.end(0);
  else if (failed) sink.end(1, failed);
}

export async function gameExport(
  params: RpcParams<'game.export'>,
  ctx: ActionContext,
  rpcId: string,
  opts: TransferOptions = {},
): Promise<{ streamId: string }> {
  // The path is built here from the validated name; nothing path-like comes from the wire.
  const base = ctx.homelabRoot.endsWith('/') ? ctx.homelabRoot : `${ctx.homelabRoot}/`;
  const game = await resolveGameDir(`${base}games/${params.gameId}`, ctx.homelabRoot);
  if (game.name !== params.gameId) throw new ActionError('bad_path', 'game folder mismatch');
  const data = path.join(game.dir, 'data');
  const st = await lstat(data).catch(() => null);
  if (!st) throw new ActionError('not_found', 'the game has no data folder', false);
  if (!st.isDirectory()) throw new ActionError('bad_path', 'data is not a directory');
  const backupDir = await ensureBackupDir(game.root, game.name);
  const tmp = path.join(backupDir, exportFileName(rpcId));

  const release = acquireDirLock(game.dir);
  let started = false;
  try {
    const sink = ctx.streams.open(rpcId);
    started = true;
    void runExport({ game, tmp, maxBytes: params.maxBytes }, ctx, sink, opts).finally(release);
    return { streamId: rpcId };
  } finally {
    if (!started) release();
  }
}

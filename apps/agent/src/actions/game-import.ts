import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  rmdir,
  statfs,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {
  GAME_ARCHIVE_ROOT,
  IMPORT_STAGING_PREFIX,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_IDLE_TIMEOUT_MS,
  TRANSFER_WINDOW,
  type GameImportDoneData,
  type RpcParams,
  type TransferErrorCode,
  type TransferChunk,
  type TransferEnd,
} from '@hz/shared';
import type { SpawnHandle } from '../exec.js';
import type { StreamSink, TransferIn } from '../streams.js';
import { acquireDirLock } from './dir-lock.js';
import { GAME_NAME } from './game-common.js';
import type { TransferOptions } from './game-export.js';
import {
  TAR_TIMEOUT_MS,
  TransferFailure,
  extractTarArgs,
  listAndCheckArchive,
  verifyExtractedTree,
} from './game-transfer.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * game.import (M11), a stream with rpc id = stream id = transfer id.
 *
 * Before the rpc.result (refusals are rpc errors): games/ is a real directory;
 * games/<gameId> is missing or a real directory (else bad_path); games/<gameId>/data
 * does not exist and no other action holds the folder lock (else busy); chunks matches
 * bytes; enough free space for the archive. Then the staging folder
 * games/.import-<streamId>/ is created (0700) with the archive file in it (0600).
 *
 * Then the core sends transfer.chunk seq 0..chunks-1. Each chunk must have the next
 * seq and exactly TRANSFER_CHUNK_BYTES (the last: the rest), at most TRANSFER_WINDOW
 * unacknowledged; it is written and then acknowledged (transfer.ack seq). On
 * transfer.end the received size and sha256 are compared with the rpc params and the
 * frame. Then every archive member is listed and checked (checkArchiveMember) before
 * anything is extracted into staging; the extracted tree is walked again; finally
 * staging/data is renamed to games/<gameId>/data (same file system, atomic).
 * Last progress line: `result {json}` (gameImportDoneDataSchema), then stream.end 0.
 * Any failure or cancel deletes the staging folder; games/<gameId> is left as it was.
 */

export const IMPORT_RESULT_PREFIX = 'result ';

interface ImportJob {
  gameDir: string;
  gameDirExisted: boolean;
  gamesRoot: string;
  staging: string;
  archive: string;
  fh: FileHandle;
  params: RpcParams<'game.import'>;
}

function expectedChunks(bytes: number): number {
  return Math.ceil(bytes / TRANSFER_CHUNK_BYTES);
}

async function writeAll(fh: FileHandle, buf: Buffer): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    off += bytesWritten;
  }
}

export async function runImport(
  job: ImportJob,
  ctx: ActionContext,
  sink: StreamSink,
  opts: TransferOptions = {},
): Promise<void> {
  const compression = opts.compression ?? 'zstd';
  const idleMs = opts.idleTimeoutMs ?? TRANSFER_IDLE_TIMEOUT_MS;
  const { params, staging, archive } = job;
  const streamId = sink.id;
  const progress = (text: string) => sink.data('progress', `${text}\n`);

  let fh: FileHandle | null = job.fh;
  let cancelled = false;
  let tar: SpawnHandle | null = null;
  let idle: NodeJS.Timeout | null = null;
  // Kills the running tar listing (set by listAndCheckArchive).
  const listing$ = { kill: null as (() => void) | null };

  // Receive state.
  let next = 0;
  let acked = -1;
  let received = 0;
  const hash = createHash('sha256');
  let writes: Promise<void> = Promise.resolve();
  let settle: ((r: TransferFailure | TransferEnd) => void) | null = null;
  const done = new Promise<TransferFailure | TransferEnd>((resolve) => {
    settle = resolve;
  });
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

  const onChunk = (msg: TransferChunk) => {
    if (msg.seq !== next) return finish(new TransferFailure('sequence', 'unexpected chunk seq'));
    if (msg.seq >= params.chunks) return finish(new TransferFailure('sequence', 'too many chunks'));
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
    if (received + buf.length > params.bytes) {
      return finish(new TransferFailure('too_large', 'more bytes than announced'));
    }
    next += 1;
    received += buf.length;
    hash.update(buf);
    armIdle();
    const seq = msg.seq;
    const out = fh;
    writes = writes.then(async () => {
      if (!settle || !out) return;
      try {
        await writeAll(out, buf);
      } catch {
        finish(new TransferFailure('io', 'writing the archive failed'));
        return;
      }
      if (!settle) return;
      acked = seq;
      sink.transfer({ type: 'transfer.ack', streamId, seq });
    });
  };

  const onEnd = (msg: TransferEnd) => {
    if (next !== params.chunks)
      return finish(new TransferFailure('sequence', 'transfer ended early'));
    if (
      msg.chunks !== params.chunks ||
      msg.bytes !== params.bytes ||
      msg.sha256 !== params.sha256
    ) {
      return finish(
        new TransferFailure('checksum_mismatch', 'transfer.end differs from the request'),
      );
    }
    if (idle) clearTimeout(idle);
    idle = null;
    void writes.then(() => finish(msg));
  };

  sink.onCancel(() => {
    cancelled = true;
    tar?.kill();
    listing$.kill?.();
    finish(new TransferFailure('cancelled', 'cancelled'));
  });
  sink.onTransfer((msg: TransferIn) => {
    if (!settle) return;
    if (msg.type === 'transfer.chunk') onChunk(msg);
    else if (msg.type === 'transfer.end') onEnd(msg);
    else finish(new TransferFailure('sequence', 'unexpected transfer frame'));
  });
  armIdle();

  let ok = false;
  let failed: TransferErrorCode | null = null;
  let createdGameDir = false;
  try {
    const r = await done;
    if (r instanceof TransferFailure) throw r;
    await writes;
    await fh.close();
    fh = null;
    if (cancelled) return;
    const sha256 = hash.digest('hex');
    if (received !== params.bytes || sha256 !== params.sha256) {
      throw new TransferFailure('checksum_mismatch', 'size or checksum differs');
    }
    progress(`received ${received} bytes, checksum ok`);

    const listing = await listAndCheckArchive(ctx.spawn, archive, compression, (kill) => {
      listing$.kill = kill;
    });
    listing$.kill = null;
    if (cancelled) return;
    progress(`archive checked: ${listing.entries} entries`);
    const fsInfo = await statfs(staging).catch(() => null);
    if (fsInfo && listing.totalBytes > fsInfo.bavail * fsInfo.bsize) {
      throw new TransferFailure('io', 'not enough disk space');
    }

    tar = ctx.spawn(
      'tar',
      extractTarArgs(archive, staging, compression),
      { onStdout: () => undefined, onStderr: () => undefined },
      { timeoutMs: TAR_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 },
    );
    const x = await tar.done;
    tar = null;
    if (cancelled) return;
    if (x.error === 'not_found') throw new TransferFailure('io', 'tar not available');
    if (x.error || x.code !== 0) throw new TransferFailure('bad_archive', 'extracting failed');
    // The game folder may have appeared or changed meanwhile: check it again.
    if (!job.gameDirExisted) {
      try {
        await mkdir(job.gameDir, { mode: 0o750 });
        createdGameDir = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new TransferFailure('io', 'creating the game folder failed');
        }
      }
    }
    const gst = await lstat(job.gameDir).catch(() => null);
    const greal = await realpath(job.gameDir).catch(() => null);
    if (!gst?.isDirectory() || greal !== job.gameDir) {
      throw new TransferFailure('io', 'game folder is not a real directory');
    }
    // Files belong to the owner of the game folder (compose.write / the admin set it,
    // e.g. uid 1000 for the itzg images), never to the archive's owners.
    const stagedData = path.join(staging, GAME_ARCHIVE_ROOT);
    const entries = await verifyExtractedTree(stagedData, {
      uid: gst.uid,
      gid: gst.gid,
      ...(opts.chown ? { chown: opts.chown } : {}),
    });
    if (cancelled) return;
    const target = path.join(job.gameDir, GAME_ARCHIVE_ROOT);
    if (await lstat(target).catch(() => null)) {
      throw new TransferFailure('exists', 'the game already has a data folder');
    }
    try {
      await rename(stagedData, target);
    } catch {
      throw new TransferFailure('io', 'moving the data folder failed');
    }
    const result: GameImportDoneData = { bytes: received, sha256, entries };
    progress(`${IMPORT_RESULT_PREFIX}${JSON.stringify(result)}`);
    ok = true;
  } catch (err) {
    if (cancelled) return;
    const failure =
      err instanceof TransferFailure ? err : new TransferFailure('io', 'import failed');
    if (!(err instanceof TransferFailure)) ctx.log.error('import failed', { error: err });
    progress(`error: ${failure.message}`);
    failed = failure.code;
  } finally {
    if (idle) clearTimeout(idle);
    tar?.kill();
    listing$.kill?.();
    await writes.catch(() => undefined);
    await fh?.close().catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    // A game folder this import created is removed again on failure (only if empty).
    if (!ok && createdGameDir) await rmdir(job.gameDir).catch(() => undefined);
  }
  // Only after the temp files are gone, so the core never sees a leftover.
  if (ok) sink.end(0);
  else if (failed) sink.end(1, failed);
}

export async function gameImport(
  params: RpcParams<'game.import'>,
  ctx: ActionContext,
  rpcId: string,
  opts: TransferOptions = {},
): Promise<{ streamId: string }> {
  if (!GAME_NAME.test(params.gameId)) throw new ActionError('bad_path', 'invalid game name');
  if (params.chunks !== expectedChunks(params.bytes)) {
    throw new ActionError('invalid_params', 'chunks does not match bytes');
  }
  let root: string;
  try {
    root = await realpath(ctx.homelabRoot);
  } catch {
    throw new ActionError('bad_path', 'homelab root missing');
  }
  const gamesRoot = path.join(root, 'games');
  const gst = await lstat(gamesRoot).catch(() => null);
  if (!gst?.isDirectory() || (await realpath(gamesRoot).catch(() => null)) !== gamesRoot) {
    throw new ActionError('bad_path', 'games folder must be a real directory');
  }
  const gameDir = path.join(gamesRoot, params.gameId);
  const st = await lstat(gameDir).catch(() => null);
  if (st && !st.isDirectory()) throw new ActionError('bad_path', 'game folder is not a directory');
  if (st && (await lstat(path.join(gameDir, GAME_ARCHIVE_ROOT)).catch(() => null))) {
    throw new ActionError('busy', 'the game already has a data folder', false);
  }
  const fsInfo = await statfs(gamesRoot).catch(() => null);
  if (fsInfo && params.bytes > fsInfo.bavail * fsInfo.bsize) {
    throw new ActionError('failed', 'not enough disk space', false);
  }

  // Same key as every other action on this folder (backup, compose, remove).
  const release = acquireDirLock(gameDir);
  const staging = path.join(gamesRoot, `${IMPORT_STAGING_PREFIX}${rpcId}`);
  let stagingCreated = false;
  let started = false;
  try {
    try {
      await mkdir(staging, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ActionError('busy', 'staging folder exists', false);
      }
      throw new ActionError('failed', 'creating the staging folder failed', false);
    }
    stagingCreated = true;
    const archive = path.join(staging, 'archive');
    const fh = await open(archive, 'wx', 0o600);
    let sink: StreamSink;
    try {
      sink = ctx.streams.open(rpcId);
    } catch (err) {
      await fh.close();
      throw err;
    }
    started = true;
    void runImport(
      { gameDir, gameDirExisted: st !== null, gamesRoot, staging, archive, fh, params },
      ctx,
      sink,
      opts,
    ).finally(release);
    return { streamId: rpcId };
  } finally {
    if (!started) {
      release();
      if (stagingCreated)
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

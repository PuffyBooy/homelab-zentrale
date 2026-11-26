import { lstat, mkdir, realpath, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import {
  GAME_ARCHIVE_ROOT,
  backupFileNameSchema,
  type GameRestoreDoneData,
  type RpcParams,
  type TransferErrorCode,
} from '@hz/shared';
import type { SpawnHandle } from '../exec.js';
import type { StreamSink } from '../streams.js';
import { acquireDirLock } from './dir-lock.js';
import { GAME_NAME, resolveGameDir } from './game-common.js';
import type { TransferOptions } from './game-export.js';
import { removeTree } from './game-remove.js';
import {
  RESTORE_STAGING_PREFIX,
  TAR_TIMEOUT_MS,
  TransferFailure,
  extractTarArgs,
  listAndCheckArchive,
  verifyExtractedTree,
} from './game-transfer.js';
import { gameContainerRunning } from './game-wake.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * game.restore (M12), a stream (rpc id = stream id).
 *
 * Before the rpc.result (refusals are rpc errors): the game folder is
 * /opt/homelab/games/<gameId> (real directory), the backup is a regular file
 * /opt/homelab/backups/<gameId>/<fileName> in a real directory (no symlinks), the
 * container game-<gameId> does not run (else busy) and no other action holds the
 * folder lock (else busy).
 *
 * Then, as progress lines: every archive member is listed and checked with
 * checkArchiveMember (same code as game.import) before anything is extracted into
 * /opt/homelab/games/.restore-<streamId>/ (0700, no owners or permissions from the
 * archive); the extracted tree is walked again and gets the owner of the current
 * data folder. Right before the swap the container is checked again. Swap:
 * an older data/../.data-before-restore is deleted, data -> .data-before-restore,
 * staged data -> data (same file system, rename). If the second rename fails the
 * first one is undone. On any error the old data stays in place. The game is never
 * started. Last progress line: `result {json}` (gameRestoreDoneDataSchema).
 */

export const RESTORE_RESULT_PREFIX = 'result ';
export const BEFORE_RESTORE_DIR = '.data-before-restore';

interface RestoreJob {
  gameId: string;
  gameDir: string;
  archive: string;
  staging: string;
}

export async function runRestore(
  job: RestoreJob,
  ctx: ActionContext,
  sink: StreamSink,
  opts: TransferOptions = {},
): Promise<void> {
  const compression = opts.compression ?? 'zstd';
  const progress = (text: string) => sink.data('progress', `${text}\n`);
  let cancelled = false;
  let tar: SpawnHandle | null = null;
  const listing$ = { kill: null as (() => void) | null };
  sink.onCancel(() => {
    cancelled = true;
    tar?.kill();
    listing$.kill?.();
  });

  let ok = false;
  let failed: TransferErrorCode | null = null;
  try {
    await mkdir(job.staging, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      throw new TransferFailure('io', err.code === 'EEXIST' ? 'staging exists' : 'staging failed');
    });
    const listing = await listAndCheckArchive(ctx.spawn, job.archive, compression, (kill) => {
      listing$.kill = kill;
    });
    listing$.kill = null;
    if (cancelled) return;
    progress(`archive checked: ${listing.entries} entries`);
    const fsInfo = await statfs(job.staging).catch(() => null);
    if (fsInfo && listing.totalBytes > fsInfo.bavail * fsInfo.bsize) {
      throw new TransferFailure('io', 'not enough disk space');
    }

    tar = ctx.spawn(
      'tar',
      extractTarArgs(job.archive, job.staging, compression),
      { onStdout: () => undefined, onStderr: () => undefined },
      { timeoutMs: TAR_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 },
    );
    const x = await tar.done;
    tar = null;
    if (cancelled) return;
    if (x.error === 'not_found') throw new TransferFailure('io', 'tar not available');
    if (x.error || x.code !== 0) throw new TransferFailure('bad_archive', 'extracting failed');

    const gst = await lstat(job.gameDir).catch(() => null);
    if (!gst?.isDirectory() || (await realpath(job.gameDir).catch(() => null)) !== job.gameDir) {
      throw new TransferFailure('io', 'game folder is not a real directory');
    }
    const data = path.join(job.gameDir, GAME_ARCHIVE_ROOT);
    const dst = await lstat(data).catch(() => null);
    if (dst && !dst.isDirectory()) throw new TransferFailure('io', 'data is not a directory');
    const owner = dst ?? gst;
    const staged = path.join(job.staging, GAME_ARCHIVE_ROOT);
    const entries = await verifyExtractedTree(staged, {
      uid: owner.uid,
      gid: owner.gid,
      ...(opts.chown ? { chown: opts.chown } : {}),
    });
    if (cancelled) return;
    progress(`extracted ${entries} entries`);

    if (await gameContainerRunning(ctx, job.gameId).catch(() => true)) {
      throw new TransferFailure('io', 'the game is running');
    }
    const before = path.join(job.gameDir, BEFORE_RESTORE_DIR);
    const bst = await lstat(before).catch(() => null);
    if (bst) {
      try {
        if (bst.isDirectory()) await removeTree(before, bst.dev);
        else await rm(before, { force: true });
      } catch {
        throw new TransferFailure('io', 'removing the previous pre-restore copy failed');
      }
    }
    if (dst) {
      try {
        await rename(data, before);
      } catch {
        throw new TransferFailure('io', 'moving the old data folder failed');
      }
    }
    try {
      await rename(staged, data);
    } catch {
      if (dst) await rename(before, data).catch(() => undefined);
      throw new TransferFailure('io', 'moving the restored data folder failed');
    }
    const result: GameRestoreDoneData = { entries };
    progress(`${RESTORE_RESULT_PREFIX}${JSON.stringify(result)}`);
    ok = true;
  } catch (err) {
    if (cancelled) return;
    const failure =
      err instanceof TransferFailure ? err : new TransferFailure('io', 'restore failed');
    if (!(err instanceof TransferFailure)) ctx.log.error('restore failed', { error: err });
    progress(`error: ${failure.message}`);
    failed = failure.code;
  } finally {
    tar?.kill();
    listing$.kill?.();
    await rm(job.staging, { recursive: true, force: true }).catch(() => undefined);
  }
  if (ok) sink.end(0);
  else if (failed) sink.end(1, failed);
}

/** Checks /opt/homelab/backups/<gameId>/<fileName>: real folder, regular file. */
async function resolveBackupFile(root: string, gameId: string, fileName: string): Promise<string> {
  const base = path.join(root, 'backups');
  const dir = path.join(base, gameId);
  for (const p of [base, dir]) {
    const st = await lstat(p).catch(() => null);
    if (!st) throw new ActionError('not_found', 'backup not found', false);
    if (!st.isDirectory() || (await realpath(p).catch(() => null)) !== p) {
      throw new ActionError('bad_path', 'backup folder must be a real directory');
    }
  }
  const file = path.join(dir, fileName);
  const st = await lstat(file).catch(() => null);
  if (!st) throw new ActionError('not_found', 'backup not found', false);
  if (!st.isFile()) throw new ActionError('bad_path', 'backup is not a regular file');
  return file;
}

export async function gameRestore(
  params: RpcParams<'game.restore'>,
  ctx: ActionContext,
  rpcId: string,
  opts: TransferOptions = {},
): Promise<{ streamId: string }> {
  if (!GAME_NAME.test(params.gameId)) throw new ActionError('bad_path', 'invalid game name');
  if (!backupFileNameSchema.safeParse(params.fileName).success) {
    throw new ActionError('invalid_params', 'invalid backup file name');
  }
  // The backup must belong to this game (<gameId>-YYYYMMDD-HHMMSS.tar.zst).
  if (!new RegExp(`^${params.gameId}-\\d{8}-\\d{6}\\.tar\\.zst$`).test(params.fileName)) {
    throw new ActionError('invalid_params', 'backup of another game');
  }
  const game = await resolveGameDir(
    path.join(ctx.homelabRoot, 'games', params.gameId),
    ctx.homelabRoot,
  );
  if (game.name !== params.gameId) throw new ActionError('bad_path', 'game folder mismatch');
  const archive = await resolveBackupFile(game.root, params.gameId, params.fileName);
  if (await gameContainerRunning(ctx, params.gameId)) {
    throw new ActionError('busy', 'the game is running', false);
  }
  const release = acquireDirLock(game.dir);
  let started = false;
  try {
    const staging = path.join(path.dirname(game.dir), `${RESTORE_STAGING_PREFIX}${rpcId}`);
    if (await lstat(staging).catch(() => null)) {
      throw new ActionError('busy', 'staging folder exists', false);
    }
    const sink = ctx.streams.open(rpcId);
    started = true;
    void runRestore(
      { gameId: params.gameId, gameDir: game.dir, archive, staging },
      ctx,
      sink,
      opts,
    ).finally(release);
    return { streamId: rpcId };
  } finally {
    if (!started) release();
  }
}

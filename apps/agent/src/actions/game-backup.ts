import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import type { RpcParams } from '@hz/shared';
import type { SpawnHandle } from '../exec.js';
import type { StreamSink } from '../streams.js';
import { acquireDirLock } from './dir-lock.js';
import { readGameEnv, rconFromEnv, resolveGameDir, type GameDir } from './game-common.js';
import { LineBuffer, LogChunker, type LogChannel } from './logs.js';
import { rconRun } from './rcon.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * game.backup as a stream (rpc id = stream id).
 *
 * What is backed up: `<gameDir>/data`. Every template mounts its world data there
 * (template.json dataDir is always "./data"); the agent does not trust a path from
 * the wire or from a label. Server installs that live in named volumes (CS2, Valheim,
 * Palworld) are not part of the backup.
 *
 * Before the rpc.result (refusals are rpc errors): gameDir is /opt/homelab/games/<name>,
 * `data` is a real directory, /opt/homelab/backups/<name>/ exists or is created and is a
 * real directory at exactly that place (no symlinks), the per-dir lock is free.
 *
 * Then, streamed as progress lines:
 *   [save-off, save-all flush]      Minecraft Java only, best effort over RCON
 *   $ tar --zstd -cf <tmp> -C <gameDir> -- data
 *   backup: <n> MiB written        every few seconds
 *   [save-on]
 *   result {"path": ..., "sizeBytes": ...}   last progress line (backupDoneDataSchema)
 * and stream.end 0. The archive is written to a hidden temp file (created with O_EXCL,
 * so tar never writes through a symlink) and renamed when complete. Then only the
 * newest `keep` archives `<name>-YYYYMMDD-HHMMSS.tar.zst` (UTC) are kept.
 */

export const BACKUP_TIMEOUT_MS = 2 * 60 * 60_000;
/** Prefix of the last progress line; the rest is JSON (backupDoneDataSchema). */
export const BACKUP_RESULT_PREFIX = 'result ';
const PROGRESS_EVERY_MS = 3000;

export function backupStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

export function backupFilePattern(name: string): RegExp {
  return new RegExp(`^${name}-\\d{8}-\\d{6}\\.tar\\.zst$`);
}

/** Fixed tar arguments. All paths are absolute; members follow `--`. */
export function tarArgs(archive: string, gameDir: string): string[] {
  if (!path.isAbsolute(archive) || !path.isAbsolute(gameDir)) {
    throw new ActionError('bad_path', 'paths must be absolute');
  }
  return [
    '--create',
    '--zstd',
    '--force-local',
    '--one-file-system',
    '--warning=no-file-changed',
    '--file',
    archive,
    '--directory',
    gameDir,
    '--',
    'data',
  ];
}

/** Creates (if needed) and checks /opt/homelab/backups/<name>/. Returns its path. */
export async function ensureBackupDir(root: string, name: string): Promise<string> {
  const base = path.join(root, 'backups');
  const dir = path.join(base, name);
  // One level at a time and never through a symlink (mkdir -p would follow one).
  for (const p of [base, dir]) {
    let st = await lstat(p).catch(() => null);
    if (!st) {
      try {
        await mkdir(p, { mode: 0o750 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new ActionError('failed', 'creating the backup folder failed');
        }
      }
      st = await lstat(p).catch(() => null);
    }
    const real = await realpath(p).catch(() => null);
    if (!st?.isDirectory() || real !== p) {
      throw new ActionError('bad_path', 'backup folder must be a real directory');
    }
  }
  return dir;
}

/** Deletes all but the newest `keep` backups of `name` in `dir`. Returns the deleted names. */
export async function applyRetention(dir: string, name: string, keep: number): Promise<string[]> {
  const re = backupFilePattern(name);
  const files = (await readdir(dir)).filter((f) => re.test(f)).sort();
  const old = files.slice(0, Math.max(0, files.length - keep));
  const removed: string[] = [];
  for (const f of old) {
    const p = path.join(dir, f);
    const st = await lstat(p).catch(() => null);
    // unlink never follows a symlink; directories with that name are left alone.
    if (!st || st.isDirectory()) continue;
    await unlink(p).catch(() => undefined);
    removed.push(f);
  }
  return removed;
}

/** Template of the running game container (label homelab.template), if docker is available. */
async function templateOf(ctx: ActionContext, name: string): Promise<string | null> {
  const docker = ctx.host.docker;
  if (!docker) return null;
  try {
    const info = (await docker.getContainer(`game-${name}`).inspect()) as {
      Config?: { Labels?: Record<string, string> | null } | null;
    };
    const labels = info.Config?.Labels ?? {};
    if (labels['homelab.game'] !== name) return null;
    return labels['homelab.template'] ?? null;
  } catch {
    return null;
  }
}

export interface BackupJob {
  game: GameDir;
  backupDir: string;
  keep: number;
  now: Date;
}

/** Runs the backup into the sink and ends it. Never throws. */
export async function runBackup(
  job: BackupJob,
  ctx: ActionContext,
  sink: StreamSink,
): Promise<void> {
  const chunker = new LogChunker((ch, chunk) => sink.data(ch, chunk));
  const lines: Record<LogChannel, LineBuffer> = {
    stdout: new LineBuffer((l) => chunker.add('stdout', l)),
    stderr: new LineBuffer((l) => chunker.add('stderr', l)),
  };
  const progress = (text: string) => {
    lines.stdout.flush();
    lines.stderr.flush();
    chunker.flush();
    sink.data('progress', `${text}\n`);
  };

  let handle: SpawnHandle | null = null;
  let cancelled = false;
  let poll: NodeJS.Timeout | null = null;
  sink.onCancel(() => {
    cancelled = true;
    handle?.kill();
  });

  const { game, backupDir } = job;
  const file = `${game.name}-${backupStamp(job.now)}.tar.zst`;
  const target = path.join(backupDir, file);
  const tmp = path.join(backupDir, `.${file}.${randomBytes(4).toString('hex')}.partial`);
  let tmpCreated = false;

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

    if (await lstat(target).catch(() => null)) {
      throw new ActionError('busy', 'a backup with this time stamp exists');
    }
    // O_EXCL: fails on anything existing, symlinks included. tar then truncates this file.
    const fh = await open(tmp, 'wx', 0o640);
    tmpCreated = true;
    await fh.close();

    const args = tarArgs(tmp, game.dir);
    progress(`$ tar --zstd -cf ${file} -C ${game.dir} data`);
    handle = ctx.spawn(
      'tar',
      args,
      {
        onStdout: (b) => lines.stdout.push(b),
        onStderr: (b) => lines.stderr.push(b),
      },
      { timeoutMs: BACKUP_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 },
    );
    poll = setInterval(() => {
      void stat(tmp)
        .then((st) => {
          if (!cancelled) progress(`backup: ${(st.size / 1024 / 1024).toFixed(1)} MiB written`);
        })
        .catch(() => undefined);
    }, PROGRESS_EVERY_MS);
    const r = await handle.done;
    handle = null;
    clearInterval(poll);
    poll = null;
    if (cancelled) return;
    // GNU tar: 1 = some files changed while being read (the server keeps running).
    if (r.error === 'not_found') throw new ActionError('failed', 'tar not available');
    if (r.error === 'timeout') throw new ActionError('timeout', 'backup timed out');
    if (r.error) throw new ActionError('failed', `tar failed (${r.error})`);
    if (r.code !== 0 && r.code !== 1)
      throw new ActionError('failed', `tar failed (exit ${r.code})`);
    if (r.code === 1) progress('warning: some files changed while they were read');

    await chmod(tmp, 0o640);
    await rename(tmp, target);
    tmpCreated = false;
    const size = (await stat(target)).size;
    const removed = await applyRetention(backupDir, game.name, job.keep);
    if (removed.length > 0) progress(`removed ${removed.length} old backup(s)`);
    if (savedOff) {
      savedOff = false;
      progress((await rconQuiet(['save-on'])) ? 'autosave resumed' : 'could not resume autosave');
    }
    progress(`${BACKUP_RESULT_PREFIX}${JSON.stringify({ path: target, sizeBytes: size })}`);
    sink.end(0);
  } catch (err) {
    if (cancelled) return;
    const message = err instanceof ActionError ? err.message : 'backup failed';
    if (!(err instanceof ActionError)) ctx.log.error('backup failed', { error: err });
    progress(`error: ${message}`);
    sink.end(1, message);
  } finally {
    if (poll) clearInterval(poll);
    if (tmpCreated) await unlink(tmp).catch(() => undefined);
    if (savedOff) await rconQuiet(['save-on']);
    lines.stdout.flush();
    lines.stderr.flush();
    chunker.dispose();
  }
}

export async function gameBackup(
  params: RpcParams<'game.backup'>,
  ctx: ActionContext,
  rpcId: string,
  now: () => Date = () => new Date(),
): Promise<{ streamId: string }> {
  const game = await resolveGameDir(params.gameDir, ctx.homelabRoot);
  const data = path.join(game.dir, 'data');
  const st = await lstat(data).catch(() => null);
  if (!st) throw new ActionError('not_found', 'the game has no data folder', false);
  if (!st.isDirectory()) throw new ActionError('bad_path', 'data is not a directory');
  const backupDir = await ensureBackupDir(game.root, game.name);

  const release = acquireDirLock(game.dir);
  let started = false;
  try {
    const sink = ctx.streams.open(rpcId);
    started = true;
    void runBackup({ game, backupDir, keep: params.keep, now: now() }, ctx, sink).finally(release);
    return { streamId: rpcId };
  } finally {
    if (!started) release();
  }
}

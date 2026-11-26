import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lchown,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {
  MOD_MAX_BYTES,
  modFileNameSchema,
  type GameModFile,
  type GameModsListData,
  type ModKind,
  type RpcParams,
} from '@hz/shared';
import { GAME_NAME, resolveGameDir } from './game-common.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * game.mods.list / install / remove (M12, Paper plugins and Fabric mods).
 *
 * Folder: /opt/homelab/games/<gameId>/data/<kind> (kind = plugins | mods). The game
 * folder, `data` and `<kind>` must be real directories (no symlinks anywhere,
 * realpath equals the expected path). A missing <kind> folder is created on install
 * (mode 0755, owner of `data`, the uid the image runs as).
 *
 * Downloads: only https://cdn.modrinth.com (the url is checked by the schema; a
 * redirect is only followed when it stays on https://cdn.modrinth.com), the body
 * must be exactly sizeBytes (never more is read) and match sha512. It is written to
 * a hidden temp file created with O_EXCL in the same folder and then hard-linked to
 * its name (fails if the name exists, never replaces a file) and the temp name is
 * removed. On any error the temp file is deleted.
 */

export const MODS_MAX_FILES = 500;
export const MOD_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 3;
const CDN_HOST = 'cdn.modrinth.com';
const TEMP_RE = /^\.mod-[0-9a-f]{12}\.part$/;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface ModsDir {
  /** data/<kind> (may not exist yet). */
  dir: string;
  data: string;
  dataUid: number;
  dataGid: number;
  exists: boolean;
}

async function realDir(p: string): Promise<{ uid: number; gid: number } | null> {
  const st = await lstat(p).catch(() => null);
  if (!st) return null;
  if (!st.isDirectory())
    throw new ActionError('bad_path', `${path.basename(p)} is not a directory`);
  if ((await realpath(p).catch(() => null)) !== p) {
    throw new ActionError('bad_path', `${path.basename(p)} must be a real directory`);
  }
  return { uid: st.uid, gid: st.gid };
}

export async function resolveModsDir(
  homelabRoot: string,
  gameId: string,
  kind: ModKind,
): Promise<ModsDir> {
  if (!GAME_NAME.test(gameId)) throw new ActionError('bad_path', 'invalid game name');
  if (kind !== 'plugins' && kind !== 'mods')
    throw new ActionError('invalid_params', 'invalid kind');
  const game = await resolveGameDir(path.join(homelabRoot, 'games', gameId), homelabRoot);
  if (path.basename(game.dir) !== gameId) throw new ActionError('bad_path', 'game folder mismatch');
  const data = path.join(game.dir, 'data');
  const dataSt = await realDir(data);
  if (!dataSt) throw new ActionError('not_found', 'the game has no data folder', false);
  const dir = path.join(data, kind);
  const st = await realDir(dir);
  return { dir, data, dataUid: dataSt.uid, dataGid: dataSt.gid, exists: st !== null };
}

/** Opens a regular file without following a symlink. */
async function openRegular(p: string): Promise<FileHandle | null> {
  let fh: FileHandle;
  try {
    fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  const st = await fh.stat();
  if (!st.isFile()) {
    await fh.close();
    return null;
  }
  return fh;
}

async function sha512Of(fh: FileHandle): Promise<string> {
  const hash = createHash('sha512');
  const buf = Buffer.alloc(1024 * 1024);
  let pos = 0;
  for (;;) {
    const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
    if (bytesRead === 0) break;
    hash.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
    if (pos > MOD_MAX_BYTES) throw new Error('too large');
  }
  return hash.digest('hex');
}

export async function gameModsList(
  params: RpcParams<'game.mods.list'>,
  ctx: ActionContext,
): Promise<GameModsListData> {
  const m = await resolveModsDir(ctx.homelabRoot, params.gameId, params.kind);
  if (!m.exists) return { files: [] };
  const names = (await readdir(m.dir)).filter((n) => modFileNameSchema.safeParse(n).success).sort();
  const files: GameModFile[] = [];
  for (const fileName of names) {
    if (files.length >= MODS_MAX_FILES) break;
    const st = await lstat(path.join(m.dir, fileName)).catch(() => null);
    if (!st?.isFile() || st.size > MOD_MAX_BYTES) continue;
    const fh = await openRegular(path.join(m.dir, fileName));
    if (!fh) continue;
    try {
      const size = (await fh.stat()).size;
      files.push({ fileName, sizeBytes: size, sha512: await sha512Of(fh) });
    } catch {
      // changed while reading: skipped
    } finally {
      await fh.close();
    }
  }
  return { files };
}

/** Creates data/<kind> (0755, owner of data) if missing and checks it again. */
async function ensureModsDir(m: ModsDir, chown: ChownFn): Promise<void> {
  if (!m.exists) {
    try {
      await mkdir(m.dir, { mode: 0o755 });
      await chown(m.dir, m.dataUid, m.dataGid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ActionError('failed', 'creating the folder failed', false);
      }
    }
  }
  if (!(await realDir(m.dir))) throw new ActionError('failed', 'creating the folder failed', false);
}

/** True for https://cdn.modrinth.com URLs (default port, no credentials). */
export function isCdnUrl(u: URL): boolean {
  return (
    u.protocol === 'https:' &&
    u.hostname === CDN_HOST &&
    u.port === '' &&
    u.username === '' &&
    u.password === ''
  );
}

/** Fetches the url, following at most 3 redirects and only on cdn.modrinth.com. */
async function fetchCdn(fetchImpl: FetchLike, url: string, signal: AbortSignal): Promise<Response> {
  let current = new URL(url);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!isCdnUrl(current))
      throw new ActionError('not_allowed', 'download only from cdn.modrinth.com');
    const res = await fetchImpl(current.toString(), {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'homelab-zentrale-agent' },
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const loc = res.headers.get('location');
      if (!loc) throw new ActionError('failed', 'redirect without location', false);
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        throw new ActionError('not_allowed', 'invalid redirect');
      }
      if (!isCdnUrl(next)) throw new ActionError('not_allowed', 'redirect to another host refused');
      current = next;
      continue;
    }
    return res;
  }
  throw new ActionError('failed', 'too many redirects', false);
}

export type ChownFn = (p: string, uid: number, gid: number) => Promise<void>;

export interface ModsOptions {
  fetch?: FetchLike;
  chown?: ChownFn;
  timeoutMs?: number;
}

async function writeAll(fh: FileHandle, buf: Uint8Array): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    off += bytesWritten;
  }
}

export async function gameModsInstallWith(
  params: RpcParams<'game.mods.install'>,
  ctx: ActionContext,
  opts: ModsOptions = {},
): Promise<GameModFile> {
  if (params.sizeBytes > MOD_MAX_BYTES) throw new ActionError('invalid_params', 'file too large');
  if (!modFileNameSchema.safeParse(params.fileName).success) {
    throw new ActionError('invalid_params', 'invalid file name');
  }
  const fetchImpl = opts.fetch ?? ((u, init) => fetch(u, init));
  const chown = opts.chown ?? lchown;
  const m = await resolveModsDir(ctx.homelabRoot, params.gameId, params.kind);
  await ensureModsDir(m, chown);
  const target = path.join(m.dir, params.fileName);
  if (await lstat(target).catch(() => null)) {
    throw new ActionError('busy', 'the file exists already', false);
  }

  const tmp = path.join(m.dir, `.mod-${randomBytes(6).toString('hex')}.part`);
  if (!TEMP_RE.test(path.basename(tmp))) throw new ActionError('failed', 'temp name');
  const fh = await open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    const signal = AbortSignal.timeout(opts.timeoutMs ?? MOD_DOWNLOAD_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchCdn(fetchImpl, params.url, signal);
    } catch (err) {
      if (err instanceof ActionError) throw err;
      throw new ActionError('failed', 'download failed', false);
    }
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new ActionError('failed', `download failed (HTTP ${res.status})`, false);
    }
    const declared = res.headers.get('content-length');
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > params.sizeBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new ActionError('failed', 'file is larger than announced', false);
    }
    const hash = createHash('sha512');
    let received = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > params.sizeBytes) {
          throw new ActionError('failed', 'file is larger than announced', false);
        }
        hash.update(value);
        await writeAll(fh, value);
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      if (err instanceof ActionError) throw err;
      throw new ActionError('failed', 'download failed', false);
    }
    if (received !== params.sizeBytes) throw new ActionError('failed', 'size mismatch', false);
    const sha512 = hash.digest('hex');
    if (sha512 !== params.sha512) throw new ActionError('failed', 'sha512 mismatch', false);
    await fh.sync();
    await fh.chown(m.dataUid, m.dataGid).catch(() => undefined);
    await fh.close();
    try {
      // link() never replaces an existing name (unlike rename).
      await link(tmp, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ActionError('busy', 'the file exists already', false);
      }
      throw new ActionError('failed', 'saving the file failed', false);
    }
    ctx.log.info('mod installed', {
      game: params.gameId,
      kind: params.kind,
      file: params.fileName,
    });
    return { fileName: params.fileName, sizeBytes: received, sha512 };
  } finally {
    await fh.close().catch(() => undefined);
    // After link() the temp name is a second name of the file; it always goes.
    await unlink(tmp).catch(() => undefined);
  }
}

export function gameModsInstall(
  params: RpcParams<'game.mods.install'>,
  ctx: ActionContext,
): Promise<GameModFile> {
  return gameModsInstallWith(params, ctx);
}

export async function gameModsRemove(
  params: RpcParams<'game.mods.remove'>,
  ctx: ActionContext,
): Promise<{ removed: true }> {
  if (!modFileNameSchema.safeParse(params.fileName).success) {
    throw new ActionError('invalid_params', 'invalid file name');
  }
  const m = await resolveModsDir(ctx.homelabRoot, params.gameId, params.kind);
  if (!m.exists) throw new ActionError('not_found', 'file not found', false);
  const p = path.join(m.dir, params.fileName);
  const st = await lstat(p).catch(() => null);
  if (!st) throw new ActionError('not_found', 'file not found', false);
  if (!st.isFile()) throw new ActionError('bad_path', 'not a regular file');
  await unlink(p);
  ctx.log.info('mod removed', { game: params.gameId, kind: params.kind, file: params.fileName });
  return { removed: true };
}

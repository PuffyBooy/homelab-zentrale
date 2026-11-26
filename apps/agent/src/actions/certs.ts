import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { certNameSchema, type RpcParams } from '@hz/shared';
import { writeFileAtomic } from './compose.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * cert.write / cert.remove (M20): certificates in /opt/homelab/certs/<name>/.
 *
 * - The path is built from the validated name (certNameSchema); no path from the wire.
 * - certs/ and certs/<name>/ must be real directories (a symlink -> bad_path). The
 *   homelab root itself may be a symlink (resolved with realpath, like paths.ts).
 * - Folder 0750, fullchain.pem 0644, privkey.pem 0600. Each file is written as an
 *   O_EXCL temp file with its final mode and renamed over the target; an existing
 *   target that is a symlink or not a regular file -> bad_path (never written through).
 * - cert.remove deletes only regular files, then the folder; anything else inside
 *   (symlink, folder, device) -> bad_path and nothing is deleted. Missing = success.
 * - The certificate and key are never logged and never part of a result.
 */

export const CERTS_DIR = 'certs';
export const FULLCHAIN = 'fullchain.pem';
export const PRIVKEY = 'privkey.pem';
const CERT_FILES = new Map<string, number>([
  [FULLCHAIN, 0o644],
  [PRIVKEY, 0o600],
]);

async function homelabReal(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    throw new ActionError('bad_path', 'homelab root missing');
  }
}

/** lstat that returns null for a missing entry. */
async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ActionError('bad_path', 'path not accessible');
  }
}

/** A real directory at `p` (never a symlink), created with `mode` if missing. */
async function ensureDir(p: string, mode: number, label: string): Promise<void> {
  let st = await lstatOrNull(p);
  if (!st) {
    try {
      // mkdir never follows a symlink at the last component (EEXIST instead).
      await mkdir(p, { mode });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ActionError('failed', `could not create ${label}`);
      }
    }
    st = await lstatOrNull(p);
  }
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    throw new ActionError('bad_path', `${label} is not a directory`);
  }
}

/** chmod through an O_NOFOLLOW handle, so a swapped-in symlink is never followed. */
async function chmodDir(p: string, mode: number): Promise<void> {
  let fh;
  try {
    fh = await open(p, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new ActionError('bad_path', 'certificate folder is not a directory');
  }
  try {
    await fh.chmod(mode);
  } finally {
    await fh.close();
  }
}

function certDir(rootReal: string, name: string): string {
  if (!certNameSchema.safeParse(name).success) throw new ActionError('bad_path', 'invalid name');
  const dir = path.join(rootReal, CERTS_DIR, name);
  if (path.dirname(dir) !== path.join(rootReal, CERTS_DIR) || path.basename(dir) !== name) {
    throw new ActionError('bad_path', 'invalid name');
  }
  return dir;
}

export async function certWrite(
  p: RpcParams<'cert.write'>,
  ctx: ActionContext,
): Promise<{ path: string }> {
  const rootReal = await homelabReal(ctx.homelabRoot);
  const dir = certDir(rootReal, p.name);
  await ensureDir(path.dirname(dir), 0o755, 'certs folder');
  await ensureDir(dir, 0o750, 'certificate folder');
  await chmodDir(dir, 0o750);
  // Nothing may resolve outside the folder: re-check right before writing.
  if ((await realpath(dir)) !== dir) throw new ActionError('bad_path', 'certificate folder moved');

  const contents: [string, string][] = [
    [PRIVKEY, p.privkeyPem],
    [FULLCHAIN, p.fullchainPem],
  ];
  for (const [name] of contents) {
    const st = await lstatOrNull(path.join(dir, name));
    if (st && (st.isSymbolicLink() || !st.isFile())) {
      throw new ActionError('bad_path', `${name} is not a regular file`);
    }
  }
  for (const [name, text] of contents) {
    try {
      await writeFileAtomic(dir, name, text, CERT_FILES.get(name) ?? 0o600);
    } catch (err) {
      if (err instanceof ActionError) throw err;
      throw new ActionError('failed', `writing ${name} failed`);
    }
  }
  ctx.log.info('certificate written', { name: p.name });
  return { path: dir };
}

export async function certRemove(
  p: RpcParams<'cert.remove'>,
  ctx: ActionContext,
): Promise<{ removed: boolean }> {
  const rootReal = await homelabReal(ctx.homelabRoot);
  const dir = certDir(rootReal, p.name);
  const parent = await lstatOrNull(path.dirname(dir));
  if (!parent) return { removed: false };
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new ActionError('bad_path', 'certs folder is not a directory');
  }
  const st = await lstatOrNull(dir);
  if (!st) return { removed: false };
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new ActionError('bad_path', 'certificate folder is not a directory');
  }
  const entries = await readdir(dir);
  for (const e of entries) {
    const est = await lstatOrNull(path.join(dir, e));
    if (est && !est.isFile()) {
      throw new ActionError('bad_path', 'certificate folder contains more than regular files');
    }
  }
  for (const e of entries) {
    const f = path.join(dir, e);
    const est = await lstatOrNull(f);
    if (!est) continue;
    if (!est.isFile()) throw new ActionError('bad_path', 'certificate folder changed meanwhile');
    await unlink(f);
  }
  try {
    await rmdir(dir);
  } catch {
    throw new ActionError('failed', 'removing the certificate folder failed');
  }
  ctx.log.info('certificate removed', { name: p.name });
  return { removed: true };
}

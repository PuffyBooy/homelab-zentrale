import { constants as fsc } from 'node:fs';
import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileNameSchema, type RpcParams } from '@hz/shared';
import { ActionError, type ActionContext } from './types.js';

/**
 * deploy.key: one ed25519 key pair per name in <HZ_AGENT_DATA>/deploy-keys/<name>
 * (directory 0700, private key 0600). Only the public key line leaves the agent.
 *
 * The key is generated with node:crypto and written in the OpenSSH private key format
 * ("openssh-key-v1", unencrypted), which ssh reads directly. No external program runs.
 *
 * Creation is exclusive and never follows symlinks:
 * - the key directory must be a real directory (lstat), owned by us; it is chmod 0700,
 * - the key is written to a fresh temp file (O_CREAT|O_EXCL|O_NOFOLLOW, 0600),
 *   fsynced and then hard-linked to its final name. link() fails with EEXIST if
 *   anything (also a dangling symlink) exists there; then the existing key is used,
 * - an existing key is opened with O_NOFOLLOW and must be a regular file with a
 *   single link, owned by us, mode 0600 (fixed if wider) and parse as an ed25519 key.
 */

export const DEPLOY_KEY_DIR = 'deploy-keys';
const KEY_TYPE = 'ssh-ed25519';
/** PEM armor, built from parts so secret scanners do not mistake the code for a key. */
const PEM_LABEL = ['OPENSSH', 'PRIVATE', 'KEY'].join(' ');
export const PEM_BEGIN = `-----BEGIN ${PEM_LABEL}-----`;
export const PEM_END = `-----END ${PEM_LABEL}-----`;
const MAGIC = Buffer.from('openssh-key-v1\0', 'latin1');
const MAX_KEY_FILE = 16 * 1024;
/** Paths inside GIT_SSH_COMMAND (run by git through a shell) must be this harmless. */
export const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/;

export function keyComment(name: string): string {
  return `homelab-zentrale ${name}`;
}

function sshString(data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

/** The SSH wire blob of an ed25519 public key. */
export function publicBlob(pub: Buffer): Buffer {
  return Buffer.concat([sshString(KEY_TYPE), sshString(pub)]);
}

export function publicKeyLine(pub: Buffer, comment: string): string {
  return `${KEY_TYPE} ${publicBlob(pub).toString('base64')} ${comment}`;
}

/** Serializes an ed25519 key (32 byte seed, 32 byte public key) as an OpenSSH private key. */
export function encodeOpenSshPrivateKey(seed: Buffer, pub: Buffer, comment: string): string {
  if (seed.length !== 32 || pub.length !== 32) throw new Error('invalid ed25519 key');
  const check = randomBytes(4);
  let priv = Buffer.concat([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  // Pad to the cipher block size (8 for "none") with 1, 2, 3, ...
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const body = Buffer.concat([
    MAGIC,
    sshString('none'),
    sshString('none'),
    sshString(''),
    u32(1),
    sshString(publicBlob(pub)),
    sshString(priv),
  ]).toString('base64');
  return armor(body);
}

/** Wraps base64 at 70 columns between the PEM lines (like ssh-keygen). */
export function armor(base64: string): string {
  const lines = base64.match(/.{1,70}/g) ?? [];
  return `${PEM_BEGIN}\n${lines.join('\n')}\n${PEM_END}\n`;
}

class Reader {
  private off = 0;
  constructor(private readonly buf: Buffer) {}
  u32(): number {
    if (this.off + 4 > this.buf.length) throw new Error('truncated');
    const v = this.buf.readUInt32BE(this.off);
    this.off += 4;
    return v;
  }
  bytes(): Buffer {
    const len = this.u32();
    if (len > this.buf.length - this.off) throw new Error('truncated');
    const v = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return v;
  }
  take(n: number): Buffer {
    if (this.off + n > this.buf.length) throw new Error('truncated');
    const v = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return v;
  }
}

/**
 * Parses an unencrypted OpenSSH ed25519 private key and returns its public key.
 * Checks that the private part matches the public key. Throws on anything else.
 */
export function decodeOpenSshPublicKey(text: string): Buffer {
  const t = text.endsWith('\n') ? text : `${text}\n`;
  if (!t.startsWith(`${PEM_BEGIN}\n`) || !t.endsWith(`\n${PEM_END}\n`)) {
    throw new Error('not an OpenSSH private key');
  }
  const inner = t.slice(PEM_BEGIN.length + 1, t.length - PEM_END.length - 2);
  if (!/^[A-Za-z0-9+/=\n]+$/.test(inner)) throw new Error('not an OpenSSH private key');
  const raw = Buffer.from(inner.replace(/\n/g, ''), 'base64');
  const r = new Reader(raw);
  if (!r.take(MAGIC.length).equals(MAGIC)) throw new Error('bad magic');
  if (r.bytes().toString() !== 'none' || r.bytes().toString() !== 'none') {
    throw new Error('encrypted keys are not supported');
  }
  r.bytes();
  if (r.u32() !== 1) throw new Error('expected one key');
  const pubR = new Reader(r.bytes());
  if (pubR.bytes().toString() !== KEY_TYPE) throw new Error('not an ed25519 key');
  const pub = Buffer.from(pubR.bytes());
  if (pub.length !== 32) throw new Error('bad public key');
  const priv = new Reader(r.bytes());
  if (!priv.take(4).equals(priv.take(4))) throw new Error('check bytes differ');
  if (priv.bytes().toString() !== KEY_TYPE) throw new Error('not an ed25519 key');
  if (!priv.bytes().equals(pub)) throw new Error('public key mismatch');
  const secret = priv.bytes();
  if (secret.length !== 64 || !secret.subarray(32).equals(pub)) throw new Error('bad private key');
  return pub;
}

export function generateEd25519(): { seed: Buffer; pub: Buffer } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string') throw new Error('keygen failed');
  return { seed: Buffer.from(jwk.d, 'base64url'), pub: Buffer.from(jwk.x, 'base64url') };
}

/** Sanity check: the seed really derives the public key (node computes it from d). */
function derivesPublic(seed: Buffer, pub: Buffer): boolean {
  const key = createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: seed.toString('base64url'),
      x: pub.toString('base64url'),
    },
    format: 'jwk',
  });
  const x = key.export({ format: 'jwk' }).x;
  return typeof x === 'string' && Buffer.from(x, 'base64url').equals(pub);
}

const ownUid = (): number | null =>
  typeof process.getuid === 'function' ? process.getuid() : null;

/** <dataDir>/deploy-keys, created 0700. Must be a real directory owned by the agent. */
export async function ensureKeyDir(dataDir: string): Promise<string> {
  const dir = path.join(path.resolve(dataDir), DEPLOY_KEY_DIR);
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new ActionError('failed', 'creating the key directory failed');
    }
  }
  const st = await lstat(dir);
  if (!st.isDirectory()) throw new ActionError('failed', 'key directory is not a directory');
  const uid = ownUid();
  if (uid !== null && st.uid !== uid)
    throw new ActionError('failed', 'key directory has a foreign owner');
  if ((st.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
  return dir;
}

/** Path of the private key `name`. The name is validated again (it becomes a file name). */
export function keyPath(keyDir: string, name: string): string {
  if (!fileNameSchema.safeParse(name).success)
    throw new ActionError('invalid_params', 'invalid key name');
  return path.join(keyDir, name);
}

/**
 * Opens an existing key without following symlinks and returns its public key.
 * Returns null if it does not exist.
 */
export async function readExistingKey(file: string): Promise<Buffer | null> {
  let fh;
  try {
    fh = await open(file, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new ActionError('failed', 'deploy key is a symlink');
    throw new ActionError('failed', 'reading the deploy key failed');
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_KEY_FILE) {
      throw new ActionError('failed', 'deploy key is not a regular file');
    }
    const uid = ownUid();
    if (uid !== null && st.uid !== uid)
      throw new ActionError('failed', 'deploy key has a foreign owner');
    if ((st.mode & 0o777) !== 0o600) await fh.chmod(0o600);
    const text = await fh.readFile('utf8');
    try {
      return decodeOpenSshPublicKey(text);
    } catch {
      throw new ActionError('failed', 'deploy key is unreadable');
    }
  } finally {
    await fh.close();
  }
}

async function createKey(keyDir: string, file: string, name: string): Promise<Buffer | null> {
  const { seed, pub } = generateEd25519();
  if (!derivesPublic(seed, pub)) throw new ActionError('failed', 'key generation failed');
  const text = encodeOpenSshPrivateKey(seed, pub, keyComment(name));
  seed.fill(0);
  // Leading dot: never collides with a key name (fileNameSchema needs [A-Za-z0-9] first).
  const tmp = path.join(keyDir, `.tmp-${randomBytes(8).toString('hex')}`);
  const fh = await open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  try {
    try {
      await fh.chmod(0o600);
      await fh.writeFile(text, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await link(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
    return pub;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/** Returns the public key of `name`, creating the key pair first if needed. */
export async function ensureDeployKey(dataDir: string, name: string): Promise<string> {
  const keyDir = await ensureKeyDir(dataDir);
  const file = keyPath(keyDir, name);
  let pub = await readExistingKey(file);
  if (!pub) {
    try {
      pub = await createKey(keyDir, file, name);
    } catch (err) {
      if (err instanceof ActionError) throw err;
      throw new ActionError('failed', 'creating the deploy key failed');
    }
    // Lost a race (or something appeared at the name): use what is there, with all checks.
    pub ??= await readExistingKey(file);
    if (!pub) throw new ActionError('failed', 'creating the deploy key failed');
  }
  return publicKeyLine(pub, keyComment(name));
}

/**
 * Path of an existing deploy key for git/ssh. Throws not_found if it does not exist.
 * The path goes into GIT_SSH_COMMAND, so it must match SAFE_PATH.
 */
export async function existingKeyPath(dataDir: string, name: string): Promise<string> {
  const keyDir = await ensureKeyDir(dataDir);
  const file = keyPath(keyDir, name);
  if (!SAFE_PATH.test(file)) throw new ActionError('failed', 'unsupported data directory path');
  const pub = await readExistingKey(file);
  if (!pub) throw new ActionError('not_found', 'deploy key not found');
  return file;
}

export async function deployKey(
  params: RpcParams<'deploy.key'>,
  ctx: ActionContext,
): Promise<{ publicKey: string }> {
  return { publicKey: await ensureDeployKey(ctx.dataDir, params.name) };
}

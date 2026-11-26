import { chmod, lchown, lstat, readdir, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_PATH,
  GAME_ARCHIVE_ROOT,
  IMPORT_STAGING_PREFIX,
  checkArchiveMember,
  type ArchiveMemberKind,
  type TransferErrorCode,
} from '@hz/shared';
import type { Spawner } from '../exec.js';
import { GAME_NAME } from './game-common.js';
import { ActionError } from './types.js';

/**
 * Shared parts of game.export and game.import (M11 migration).
 *
 * The archive is a tar of the folder `data` only (like game.backup), compressed with
 * zstd. tar is the only program used, with fixed argument arrays (exec.ts, no shell):
 *
 *   export:  tar --create --zstd ... --file <tmp> --directory <gameDir> -- data
 *   list:    tar --list --verbose --quoting-style=c --absolute-names ... --file <archive>
 *   extract: tar --extract --zstd --no-same-owner --no-same-permissions --keep-old-files
 *            ... --file <archive> --directory <staging> -- data
 *
 * The listing and the extraction are done by the same tar binary on the same file, so
 * the member names that are checked (checkArchiveMember) are the names that tar writes.
 * The listing uses --absolute-names so tar shows absolute and `..` names unchanged and
 * the check rejects them (extraction never uses that flag). After extracting, the
 * staging tree is walked again with lstat (defense in depth).
 */

/** Compression flag of tar. Production always uses zstd; tests may use gzip. */
export type Compression = 'zstd' | 'gzip';
export const TAR_TIMEOUT_MS = 2 * 60 * 60_000;
/** Longest listing line: every byte of the name as a 4-char octal escape plus the fields. */
export const MAX_LIST_LINE = ARCHIVE_MAX_PATH * 4 + 512;
export const EXPORT_FILE_RE = /^\.export-[A-Za-z0-9_-]{8,64}\.tar\.zst$/;
export const STAGING_DIR_RE = new RegExp(`^\\${IMPORT_STAGING_PREFIX}[A-Za-z0-9_-]{8,64}$`);

export function exportFileName(streamId: string): string {
  return `.export-${streamId}.tar.zst`;
}

/** A failed transfer: ends the stream with code 1 and error = code. */
export class TransferFailure extends Error {
  constructor(
    public readonly code: TransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TransferFailure';
  }
}

function compressFlag(c: Compression): string {
  return c === 'zstd' ? '--zstd' : '--gzip';
}

function mustBeAbsolute(...paths: string[]): void {
  for (const p of paths) {
    if (!path.isAbsolute(p) || path.normalize(p) !== p) {
      throw new ActionError('bad_path', 'paths must be absolute');
    }
  }
}

/** tar arguments of game.export: only the `data` member of the game folder. */
export function exportTarArgs(archive: string, gameDir: string, c: Compression = 'zstd'): string[] {
  mustBeAbsolute(archive, gameDir);
  return [
    '--create',
    compressFlag(c),
    '--force-local',
    '--one-file-system',
    '--warning=no-file-changed',
    '--file',
    archive,
    '--directory',
    gameDir,
    '--',
    GAME_ARCHIVE_ROOT,
  ];
}

/** tar arguments that list every member with its type and raw name (C-quoted). */
export function listTarArgs(archive: string, c: Compression = 'zstd'): string[] {
  mustBeAbsolute(archive);
  return [
    '--list',
    '--verbose',
    compressFlag(c),
    '--force-local',
    '--numeric-owner',
    '--quoting-style=c',
    // Show names exactly as stored (no stripping of `/`), so the check sees them.
    '--absolute-names',
    '--file',
    archive,
  ];
}

/**
 * tar arguments that extract `data` into the staging folder: no owners or special
 * permission bits from the archive, never replace an existing file (duplicate
 * members fail), no ACLs/xattrs/SELinux labels.
 */
export function extractTarArgs(
  archive: string,
  staging: string,
  c: Compression = 'zstd',
): string[] {
  mustBeAbsolute(archive, staging);
  return [
    '--extract',
    compressFlag(c),
    '--force-local',
    '--no-same-owner',
    '--no-same-permissions',
    '--keep-old-files',
    '--no-acls',
    '--no-xattrs',
    '--no-selinux',
    '--file',
    archive,
    '--directory',
    staging,
    '--',
    GAME_ARCHIVE_ROOT,
  ];
}

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '\\': 92,
  '"': 34,
  '?': 63,
  "'": 39,
};

/** Decodes a tar --quoting-style=c name (without the quotes). Null if malformed. */
export function unquoteC(text: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch > 0x7e || ch < 0x20) return null;
    if (text[i] !== '\\') {
      bytes.push(ch);
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) return null;
    const oct = /^[0-7]{3}/.exec(text.slice(i + 1, i + 4));
    if (oct) {
      const v = parseInt(oct[0], 8);
      if (v > 255) return null;
      bytes.push(v);
      i += 3;
      continue;
    }
    const e = C_ESCAPES[next];
    if (e === undefined) return null;
    bytes.push(e);
    i += 1;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

export interface ListedMember {
  path: string;
  kind: ArchiveMemberKind;
  /** Size of a regular file (0 for the rest). */
  size: number;
}

/**
 * Parses one line of `tar --list --verbose --quoting-style=c --numeric-owner`, e.g.
 * `-rw-r--r-- 0/0   12 2024-01-01 10:00 "data/world/level.dat"`. Returns null for a
 * line that does not have that shape.
 */
export function parseListLine(line: string): ListedMember | null {
  const q = line.indexOf('"');
  if (q < 0) return null;
  const head = line.slice(0, q);
  const m = /^"((?:[^"\\]|\\.)*)"(.*)$/.exec(line.slice(q));
  if (!m) return null;
  const name = unquoteC(m[1] ?? '');
  if (name === null) return null;
  const rest = m[2] ?? '';
  const fields = head.trim().split(/\s+/);
  if (fields.length < 3) return null;
  const type = line[0];
  let kind: ArchiveMemberKind;
  if (type === '-' && rest === '') kind = 'file';
  else if (type === 'd' && rest === '') kind = 'dir';
  else if (type === 'l') kind = 'symlink';
  else if (type === 'h') kind = 'hardlink';
  else kind = 'other';
  let size = 0;
  if (kind === 'file') {
    const s = fields[2] ?? '';
    if (!/^\d{1,16}$/.test(s)) return null;
    size = Number(s);
  }
  return { path: name, kind, size };
}

export interface ListSummary {
  entries: number;
  /** Sum of the regular file sizes. */
  totalBytes: number;
}

/**
 * Lists the archive with tar and checks every member (checkArchiveMember, entry and
 * line limits). Throws TransferFailure('bad_archive') on the first bad member; nothing
 * is extracted before this returned.
 */
export async function listAndCheckArchive(
  spawn: Spawner,
  archive: string,
  c: Compression,
  onCancel: (kill: () => void) => void,
): Promise<ListSummary> {
  let bad: string | null = null;
  let entries = 0;
  let totalBytes = 0;
  let partial: Buffer = Buffer.alloc(0);
  let kill: () => void = () => undefined;
  const fail = (reason: string) => {
    bad ??= reason;
    kill();
  };
  const onLine = (raw: string) => {
    if (bad !== null) return;
    const member = parseListLine(raw);
    if (!member) return fail('unreadable archive listing');
    const check = checkArchiveMember(member.path, member.kind);
    if (!check.ok) {
      const name = JSON.stringify(member.path.slice(0, 120));
      return fail(`archive member rejected: ${check.reason} (${name})`);
    }
    entries += 1;
    totalBytes += member.size;
    if (entries > ARCHIVE_MAX_ENTRIES) fail('too many archive entries');
  };
  const handle = spawn(
    'tar',
    listTarArgs(archive, c),
    {
      onStdout: (b) => {
        if (bad !== null) return;
        partial = partial.length === 0 ? b : Buffer.concat([partial, b]);
        let nl: number;
        while (bad === null && (nl = partial.indexOf(10)) >= 0) {
          const line = partial.subarray(0, nl).toString('latin1');
          partial = partial.subarray(nl + 1);
          if (line.length > MAX_LIST_LINE) fail('archive member path too long');
          else onLine(line);
        }
        if (partial.length > MAX_LIST_LINE) fail('archive member path too long');
      },
      onStderr: () => undefined,
    },
    {
      timeoutMs: TAR_TIMEOUT_MS,
      maxOutputBytes: (ARCHIVE_MAX_ENTRIES + 1) * (MAX_LIST_LINE + 1),
    },
  );
  kill = () => handle.kill();
  onCancel(kill);
  const r = await handle.done;
  if (bad !== null) throw new TransferFailure('bad_archive', bad);
  if (r.error === 'not_found') throw new TransferFailure('io', 'tar not available');
  if (r.error || r.code !== 0)
    throw new TransferFailure('bad_archive', 'tar could not list the archive');
  if (partial.length > 0) {
    onLine(partial.toString('latin1'));
    if (bad !== null) throw new TransferFailure('bad_archive', bad);
  }
  if (entries === 0) throw new TransferFailure('bad_archive', 'empty archive');
  return { entries, totalBytes };
}

/** Owner the extracted tree gets (uid:gid of the target game folder). */
export interface TreeOwner {
  uid: number;
  gid: number;
  /** lchown (never follows a link); injected by tests. */
  chown?: (p: string, uid: number, gid: number) => Promise<void>;
}

/**
 * Walks the extracted `data` tree with lstat: only directories and regular files,
 * at most ARCHIVE_MAX_ENTRIES, no setuid/setgid/sticky bits (cleared). With `owner`,
 * every entry (only ever below dataDir, never through a link: none exist, and lchown
 * would not follow one) gets that uid:gid. Returns the number of entries (data
 * itself included).
 */
export async function verifyExtractedTree(dataDir: string, owner?: TreeOwner): Promise<number> {
  const top = await lstat(dataDir).catch(() => null);
  if (!top?.isDirectory()) throw new TransferFailure('bad_archive', 'archive has no data folder');
  const chown = owner?.chown ?? lchown;
  const fix = async (p: string, st: { mode: number; uid: number; gid: number }) => {
    await clearSpecialBits(p, st.mode);
    if (owner && (st.uid !== owner.uid || st.gid !== owner.gid)) {
      try {
        await chown(p, owner.uid, owner.gid);
      } catch {
        throw new TransferFailure('io', 'setting the owner failed');
      }
    }
  };
  let count = 0;
  const stack = [dataDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    count += 1;
    await fix(dir, await lstat(dir));
    for (const name of await readdir(dir)) {
      const p = path.join(dir, name);
      const st = await lstat(p);
      if (st.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!st.isFile()) throw new TransferFailure('bad_archive', 'unexpected file type extracted');
      count += 1;
      await fix(p, st);
      if (count > ARCHIVE_MAX_ENTRIES) throw new TransferFailure('bad_archive', 'too many entries');
    }
    if (count > ARCHIVE_MAX_ENTRIES) throw new TransferFailure('bad_archive', 'too many entries');
  }
  return count;
}

async function clearSpecialBits(p: string, mode: number): Promise<void> {
  // Only called on entries lstat just showed as file/dir inside our 0700 staging folder.
  if ((mode & 0o7000) !== 0) await chmod(p, mode & 0o777);
}

/**
 * On agent start: deletes import staging folders (/opt/homelab/games/.import-<id>/) and
 * export temp archives (/opt/homelab/backups/<name>/.export-<id>.tar.zst) that a
 * crashed agent left behind. No transfer runs yet. Never follows symlinks (lstat; rm
 * removes links instead of following them). Returns the deleted paths. Never throws.
 */
export async function cleanupStaleTransfers(homelabRoot: string): Promise<string[]> {
  const removed: string[] = [];
  let root: string;
  try {
    root = await realpath(homelabRoot);
  } catch {
    return removed;
  }
  const games = path.join(root, 'games');
  if ((await lstat(games).catch(() => null))?.isDirectory()) {
    for (const name of await readdir(games).catch(() => [] as string[])) {
      if (!STAGING_DIR_RE.test(name)) continue;
      const p = path.join(games, name);
      if (!(await lstat(p).catch(() => null))?.isDirectory()) continue;
      try {
        await rm(p, { recursive: true, force: true });
        removed.push(p);
      } catch {
        // next start tries again
      }
    }
  }
  const backups = path.join(root, 'backups');
  if ((await lstat(backups).catch(() => null))?.isDirectory()) {
    for (const name of await readdir(backups).catch(() => [] as string[])) {
      if (!GAME_NAME.test(name)) continue;
      const dir = path.join(backups, name);
      if (!(await lstat(dir).catch(() => null))?.isDirectory()) continue;
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        if (!EXPORT_FILE_RE.test(f)) continue;
        const p = path.join(dir, f);
        if (!(await lstat(p).catch(() => null))?.isFile()) continue;
        try {
          await unlink(p);
          removed.push(p);
        } catch {
          // next start tries again
        }
      }
    }
  }
  return removed;
}

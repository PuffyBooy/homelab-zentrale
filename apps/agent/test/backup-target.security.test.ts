import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TRANSFER_CHUNK_BYTES,
  backupTargetStoreDataSchema,
  parseRpc,
  type TransferAck,
} from '@hz/shared';
import {
  STORE_RESULT_PREFIX,
  backupTargetStatus,
  backupTargetStore,
  backupTargetSync,
  parseMountLines,
  resetBackupTargetLock,
  resolveTarget,
  type Target,
} from '../src/actions/backup-target.js';
import { ActionError } from '../src/actions/types.js';
import { makeCtx } from './game-helpers.js';
import { progressText, recordingStreams, waitEnd, type Frame } from './migrate-helpers.js';

let base: string;
let n = 0;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-btarget-')));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});
beforeEach(() => resetBackupTargetLock());

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A fresh homelab root with backups/, a target folder and a fake host /proc. */
async function world() {
  const dir = path.join(base, `w${++n}`);
  const root = path.join(dir, 'homelab');
  const target = path.join(root, 'backup-target');
  const proc = path.join(dir, 'proc');
  await mkdir(path.join(proc, '1'), { recursive: true });
  await mkdir(target, { recursive: true });
  await mkdir(path.join(root, 'backups'), { recursive: true });
  const outside = path.join(dir, 'outside');
  await mkdir(outside);
  const { streams, frames } = recordingStreams();
  const { ctx } = makeCtx(root, {
    streams,
    host: {
      hostProc: proc,
      hostRoot: '/',
      docker: null,
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    },
  });
  const mounted = async (): Promise<Target> => ({ state: 'mounted', fs: 'cifs', view: target });
  return { dir, root, target, proc, outside, ctx, streams, frames, opts: { resolve: mounted } };
}

async function backup(root: string, gameId: string, stamp: string, data = randomBytes(2000)) {
  const d = path.join(root, 'backups', gameId);
  await mkdir(d, { recursive: true });
  const name = `${gameId}-${stamp}.tar.zst`;
  await writeFile(path.join(d, name), data);
  return { name, data };
}

describe('backup target mount check', () => {
  it('decodes octal escapes of the mount table', () => {
    expect(parseMountLines('//nas/b /opt/home\\040lab/x cifs rw,relatime 0 0\n')).toEqual([
      { mount: '/opt/home lab/x', fs: 'cifs', options: ['rw', 'relatime'] },
    ]);
  });

  it('is missing / not mounted / mounted / read only', async () => {
    const w = await world();
    const mp = w.target;
    const dev = (own: number) => async (p: string) => (p === mp ? own : 1);
    // folder exists, no mount table entry
    await writeFile(path.join(w.proc, '1', 'mounts'), '/dev/sda1 / ext4 rw 0 0\n');
    expect((await resolveTarget(w.ctx, dev(2))).state).toBe('not_mounted');
    // entry, but the same device as the parent folder (e.g. a stale table)
    await writeFile(path.join(w.proc, '1', 'mounts'), `//nas/b ${mp} cifs rw,relatime 0 0\n`);
    expect((await resolveTarget(w.ctx, dev(1))).state).toBe('not_mounted');
    const ok = await resolveTarget(w.ctx, dev(2));
    expect(ok).toMatchObject({ state: 'mounted', fs: 'cifs' });
    // the last entry wins (mounted on top)
    await writeFile(
      path.join(w.proc, '1', 'mounts'),
      `//nas/b ${mp} cifs rw 0 0\n//nas/b ${mp} cifs ro,relatime 0 0\n`,
    );
    expect((await resolveTarget(w.ctx, dev(2))).state).toBe('read_only');
    // a mount somewhere below or above does not count
    await writeFile(path.join(w.proc, '1', 'mounts'), `//nas/b ${mp}/sub cifs rw 0 0\n`);
    expect((await resolveTarget(w.ctx, dev(2))).state).toBe('not_mounted');
    await rm(mp, { recursive: true });
    expect((await resolveTarget(w.ctx, dev(2))).state).toBe('missing');
  });

  it('never treats a symlink as the target, even with a mount table entry', async () => {
    const w = await world();
    await rm(w.target, { recursive: true });
    await symlink(w.outside, w.target);
    await writeFile(path.join(w.proc, '1', 'mounts'), `//nas/b ${w.target} cifs rw 0 0\n`);
    expect((await resolveTarget(w.ctx, async (p) => (p === w.target ? 2 : 1))).state).toBe(
      'not_mounted',
    );
  });

  it('the real check: a plain folder in a test is never "mounted"', async () => {
    const w = await world();
    await writeFile(path.join(w.proc, '1', 'mounts'), `//nas/b ${w.target} cifs rw 0 0\n`);
    expect((await resolveTarget(w.ctx)).state).toBe('not_mounted');
  });
});

describe('backup.target.sync', () => {
  it('writes nothing when the share is not mounted', async () => {
    const w = await world();
    await backup(w.root, 'mc', '20261120-030000');
    for (const state of ['missing', 'not_mounted', 'read_only'] as const) {
      const r = await backupTargetSync({ gameIds: ['mc'], keep: 5 }, w.ctx, {
        resolve: async () => ({ state, fs: null, view: w.target }),
      });
      expect(r.state).toBe(state);
      expect(r.games).toEqual([]);
    }
    expect(await readdir(w.target)).toEqual([]);
  });

  it('copies new backups, skips existing ones, keeps the newest N and leaves other files', async () => {
    const w = await world();
    const a = await backup(w.root, 'mc', '20261120-030000');
    const b = await backup(w.root, 'mc', '20261121-030000');
    const c = await backup(w.root, 'mc', '20261122-030000');
    const r1 = await backupTargetSync(
      { gameIds: ['mc', 'mc', 'nobackups'], keep: 2 },
      w.ctx,
      w.opts,
    );
    expect(r1.games).toEqual([
      { gameId: 'mc', copied: 2, skipped: 0, removed: 0, bytes: 4000, error: null },
      { gameId: 'nobackups', copied: 0, skipped: 0, removed: 0, bytes: 0, error: null },
    ]);
    const dst = path.join(w.target, 'games', 'mc');
    expect((await readdir(dst)).sort()).toEqual([b.name, c.name]);
    expect(await readFile(path.join(dst, c.name))).toEqual(c.data);
    void a;

    // someone else's file and a non-matching name stay untouched
    await writeFile(path.join(dst, 'notes.txt'), 'mine');
    await writeFile(path.join(dst, 'other-20261101-030000.tar.zst'), 'x');
    const d = await backup(w.root, 'mc', '20261123-030000');
    const r2 = await backupTargetSync({ gameIds: ['mc'], keep: 2 }, w.ctx, w.opts);
    expect(r2.games[0]).toMatchObject({ copied: 1, skipped: 1, removed: 1, error: null });
    expect((await readdir(dst)).sort()).toEqual(
      [c.name, d.name, 'notes.txt', 'other-20261101-030000.tar.zst'].sort(),
    );
  });

  it('replaces a copy with the wrong size (an earlier broken copy)', async () => {
    const w = await world();
    const a = await backup(w.root, 'mc', '20261120-030000');
    const dst = path.join(w.target, 'games', 'mc');
    await mkdir(dst, { recursive: true });
    await writeFile(path.join(dst, a.name), 'short');
    const r = await backupTargetSync({ gameIds: ['mc'], keep: 5 }, w.ctx, w.opts);
    expect(r.games[0]).toMatchObject({ copied: 1, error: null });
    expect(await readFile(path.join(dst, a.name))).toEqual(a.data);
  });

  it('never follows a symlink on the target', async () => {
    const w = await world();
    await backup(w.root, 'mc', '20261120-030000');
    // games/ -> outside
    await symlink(w.outside, path.join(w.target, 'games'));
    const r = await backupTargetSync({ gameIds: ['mc'], keep: 5 }, w.ctx, w.opts);
    expect(r.games[0]?.error).toBe('bad_path');
    expect(await readdir(w.outside)).toEqual([]);
  });

  it('never follows a symlinked game folder or copy on the target', async () => {
    const w = await world();
    const a = await backup(w.root, 'mc', '20261120-030000');
    await mkdir(path.join(w.target, 'games'));
    await symlink(w.outside, path.join(w.target, 'games', 'mc'));
    expect(
      (await backupTargetSync({ gameIds: ['mc'], keep: 5 }, w.ctx, w.opts)).games[0]?.error,
    ).toBe('bad_path');
    await rm(path.join(w.target, 'games', 'mc'));
    await mkdir(path.join(w.target, 'games', 'mc'));
    await symlink(path.join(w.outside, 'x'), path.join(w.target, 'games', 'mc', a.name));
    expect(
      (await backupTargetSync({ gameIds: ['mc'], keep: 5 }, w.ctx, w.opts)).games[0]?.error,
    ).toBe('bad_path');
    expect(await readdir(w.outside)).toEqual([]);
  });

  it('never deletes the local originals through a planted relative symlink', async () => {
    const w = await world();
    const files = [];
    for (let i = 0; i < 4; i++) files.push(await backup(w.root, 'mc', `2026112${i}-030000`));
    await mkdir(path.join(w.target, 'games'));
    // A NAS user points games/mc back at the server's own backups folder.
    await symlink('../../backups/mc', path.join(w.target, 'games', 'mc'));
    const r = await backupTargetSync({ gameIds: ['mc'], keep: 1 }, w.ctx, w.opts);
    expect(r.games[0]?.error).toBe('bad_path');
    expect((await readdir(path.join(w.root, 'backups', 'mc'))).sort()).toEqual(
      files.map((f) => f.name).sort(),
    );
  });

  it('stops when the share drops during a sync and creates nothing more', async () => {
    const w = await world();
    await backup(w.root, 'aa', '20261120-030000');
    await backup(w.root, 'bb', '20261120-030000');
    let calls = 0;
    const r = await backupTargetSync({ gameIds: ['aa', 'bb'], keep: 5 }, w.ctx, {
      resolve: async () => ({
        state: ++calls <= 2 ? 'mounted' : 'not_mounted',
        fs: 'cifs',
        view: w.target,
      }),
    });
    expect(r.state).toBe('not_mounted');
    expect(r.games.map((g) => g.gameId)).toEqual(['aa']);
    expect(await readdir(path.join(w.target, 'games'))).toEqual(['aa']);
  });

  it('skips symlinks among the source backups and a symlinked source folder', async () => {
    const w = await world();
    await writeFile(path.join(w.outside, 'secret'), 'secret');
    await mkdir(path.join(w.root, 'backups', 'mc'));
    await symlink(
      path.join(w.outside, 'secret'),
      path.join(w.root, 'backups', 'mc', 'mc-20261120-030000.tar.zst'),
    );
    await symlink(w.outside, path.join(w.root, 'backups', 'evil'));
    const r = await backupTargetSync({ gameIds: ['mc', 'evil'], keep: 5 }, w.ctx, w.opts);
    expect(r.games[0]).toMatchObject({ copied: 0, error: null });
    expect(r.games[1]).toMatchObject({ copied: 0, error: 'bad_path' });
    expect(await readdir(path.join(w.target, 'games', 'mc'))).toEqual([]);
  });

  it('removes stale .partial files of its own names only', async () => {
    const w = await world();
    await backup(w.root, 'mc', '20261120-030000');
    const dst = path.join(w.target, 'games', 'mc');
    await mkdir(dst, { recursive: true });
    await writeFile(path.join(dst, '.mc-20261101-030000.tar.zst.0011aabb.partial'), 'x');
    await writeFile(path.join(dst, '.foreign.0011aabb.partial'), 'x');
    await backupTargetSync({ gameIds: ['mc'], keep: 5 }, w.ctx, w.opts);
    const names = await readdir(dst);
    expect(names).toContain('.foreign.0011aabb.partial');
    expect(names.filter((x) => x.startsWith('.mc-'))).toEqual([]);
  });

  it('runs one copy at a time', async () => {
    const w = await world();
    for (let i = 0; i < 3; i++)
      await backup(w.root, 'mc', `2026112${i}-030000`, randomBytes(300_000));
    const first = backupTargetSync({ gameIds: ['mc'], keep: 5 }, w.ctx, w.opts);
    await expect(
      backupTargetSync({ gameIds: ['mc'], keep: 5 }, w.ctx, w.opts),
    ).rejects.toMatchObject({
      code: 'busy',
    });
    await first;
    await expect(
      backupTargetSync({ gameIds: ['mc'], keep: 5 }, w.ctx, w.opts),
    ).resolves.toBeTruthy();
  });

  it('status lists copies and the database snapshots', async () => {
    const w = await world();
    await backup(w.root, 'mc', '20261120-030000');
    await backupTargetSync({ gameIds: ['mc'], keep: 5 }, w.ctx, w.opts);
    await mkdir(path.join(w.target, 'core'));
    await writeFile(path.join(w.target, 'core', 'homelab-zentrale-20261120-0500.sqlite'), 'db');
    await mkdir(path.join(w.target, 'games', '..evil'), { recursive: true }).catch(() => undefined);
    const s = await backupTargetStatus({}, w.ctx, w.opts);
    expect(s.state).toBe('mounted');
    expect(s.games).toEqual([
      { gameId: 'mc', files: 1, bytes: 2000, newest: 'mc-20261120-030000.tar.zst' },
    ]);
    expect(s.core).toEqual({ files: 1, bytes: 2, newest: 'homelab-zentrale-20261120-0500.sqlite' });
  });
});

describe('backup.target.store', () => {
  const fileName = 'homelab-zentrale-20261126-0500.sqlite';

  async function start(data: Buffer, over: { sha256?: string; idleTimeoutMs?: number } = {}) {
    const w = await world();
    const id = `store-${++n}-${randomBytes(3).toString('hex')}`;
    const params = {
      fileName,
      bytes: data.length,
      sha256: over.sha256 ?? sha(data),
      chunks: Math.ceil(data.length / TRANSFER_CHUNK_BYTES),
      keep: 2,
    };
    await backupTargetStore(params, w.ctx, id, {
      ...w.opts,
      ...(over.idleTimeoutMs ? { idleTimeoutMs: over.idleTimeoutMs } : {}),
    });
    w.streams.activate(id);
    const sendAll = async () => {
      for (let seq = 0; seq < params.chunks; seq++) {
        w.streams.deliver({
          type: 'transfer.chunk',
          streamId: id,
          seq,
          data: data
            .subarray(seq * TRANSFER_CHUNK_BYTES, (seq + 1) * TRANSFER_CHUNK_BYTES)
            .toString('base64'),
        });
        await new Promise((r) => setTimeout(r, 1));
      }
      w.streams.deliver({
        type: 'transfer.end',
        streamId: id,
        chunks: params.chunks,
        bytes: params.bytes,
        sha256: params.sha256,
      });
    };
    return { ...w, id, params, sendAll };
  }

  const acks = (f: Frame[]) => f.filter((x): x is TransferAck => x.type === 'transfer.ack');

  it('stores the snapshot, verifies it and keeps the newest N', async () => {
    const data = randomBytes(TRANSFER_CHUNK_BYTES * 2 + 100);
    const s = await start(data);
    await mkdir(path.join(s.target, 'core'), { recursive: true }).catch(() => undefined);
    await writeFile(path.join(s.target, 'core', 'homelab-zentrale-20261101-0500.sqlite'), 'old');
    await writeFile(path.join(s.target, 'core', 'homelab-zentrale-20261102-0500.sqlite'), 'old');
    await s.sendAll();
    const end = await waitEnd(s.frames);
    expect(end.code).toBe(0);
    expect(acks(s.frames).at(-1)?.seq).toBe(2);
    const line = progressText(s.frames).trim();
    expect(line.startsWith(STORE_RESULT_PREFIX)).toBe(true);
    const result = backupTargetStoreDataSchema.parse(
      JSON.parse(line.slice(STORE_RESULT_PREFIX.length)),
    );
    expect(result).toMatchObject({ fileName, bytes: data.length, removed: 1 });
    expect(await readFile(path.join(s.target, 'core', fileName))).toEqual(data);
    expect((await readdir(path.join(s.target, 'core'))).sort()).toEqual([
      'homelab-zentrale-20261102-0500.sqlite',
      fileName,
    ]);
  });

  it('rejects a checksum mismatch and leaves no file', async () => {
    const data = randomBytes(1000);
    const s = await start(data, { sha256: 'a'.repeat(64) });
    await s.sendAll();
    const end = await waitEnd(s.frames);
    expect(end).toMatchObject({ code: 1, error: 'checksum_mismatch' });
    expect(await readdir(path.join(s.target, 'core'))).toEqual([]);
  });

  it('rejects wrong chunk sizes and gaps', async () => {
    const data = randomBytes(TRANSFER_CHUNK_BYTES + 10);
    const s = await start(data);
    s.streams.deliver({
      type: 'transfer.chunk',
      streamId: s.id,
      seq: 1,
      data: data.subarray(0, 10).toString('base64'),
    });
    expect(await waitEnd(s.frames)).toMatchObject({ code: 1, error: 'sequence' });
    expect(await readdir(path.join(s.target, 'core'))).toEqual([]);
  });

  it('times out and cleans up when the core goes silent', async () => {
    const s = await start(randomBytes(100), { idleTimeoutMs: 50 });
    expect(await waitEnd(s.frames)).toMatchObject({ code: 1, error: 'timeout' });
    expect(await readdir(path.join(s.target, 'core'))).toEqual([]);
  });

  it('is refused before the stream when the target is not mounted or busy', async () => {
    const w = await world();
    const params = { fileName, bytes: 10, sha256: 'a'.repeat(64), chunks: 1, keep: 2 };
    await expect(
      backupTargetStore(params, w.ctx, 'x1', {
        resolve: async () => ({ state: 'not_mounted', fs: null, view: w.target }),
      }),
    ).rejects.toBeInstanceOf(ActionError);
    expect(await readdir(w.target)).toEqual([]);
    // a symlinked core/ is refused
    await symlink(w.outside, path.join(w.target, 'core'));
    await expect(backupTargetStore(params, w.ctx, 'x2', w.opts)).rejects.toMatchObject({
      code: 'bad_path',
    });
    expect(await readdir(w.outside)).toEqual([]);
    expect(await lstat(path.join(w.target, 'core')).then((s) => s.isSymbolicLink())).toBe(true);
  });
});

describe('backup target allowlist', () => {
  const rpc = (action: string, params: unknown) =>
    parseRpc({ type: 'rpc', id: 'abcdefghijkl', action, params });

  it('accepts only plain game names and the snapshot name pattern', () => {
    expect(rpc('backup.target.sync', { gameIds: ['mc'] }).ok).toBe(true);
    for (const g of ['../x', 'a/b', '.hidden', 'A', '', 'x'.repeat(40)]) {
      expect(rpc('backup.target.sync', { gameIds: [g] }).ok).toBe(false);
    }
    expect(rpc('backup.target.sync', { gameIds: [], path: '/etc' }).ok).toBe(false);
    const ok = {
      fileName: 'homelab-zentrale-20261126-0500.sqlite',
      bytes: 1,
      sha256: 'a'.repeat(64),
      chunks: 1,
    };
    expect(rpc('backup.target.store', ok).ok).toBe(true);
    for (const f of [
      '../../etc/passwd',
      'homelab-zentrale-20261126-0500.sqlite/../x',
      'x.sqlite',
    ]) {
      expect(rpc('backup.target.store', { ...ok, fileName: f }).ok).toBe(false);
    }
    expect(rpc('backup.target.store', { ...ok, bytes: 5 * 1024 ** 3 }).ok).toBe(false);
    // chunks must match bytes (48 KiB chunks)
    expect(rpc('backup.target.store', { ...ok, chunks: 2 }).ok).toBe(false);
    expect(rpc('backup.target.store', { ...ok, bytes: 49 * 1024, chunks: 2 }).ok).toBe(true);
    expect(rpc('backup.target.status', { dir: '/' }).ok).toBe(false);
  });
});

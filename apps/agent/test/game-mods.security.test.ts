import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gameModFileSchema, gameModsListDataSchema, rpcParamsByAction } from '@hz/shared';
import {
  gameModsInstallWith,
  gameModsList,
  gameModsRemove,
  isCdnUrl,
  type FetchLike,
} from '../src/actions/game-mods.js';
import { ActionError } from '../src/actions/types.js';
import { makeCtx } from './game-helpers.js';

let base: string;
let root: string;
let games: string;
let outside: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-mods-')));
  root = path.join(base, 'homelab');
  games = path.join(root, 'games');
  outside = path.join(base, 'outside');
  await mkdir(games, { recursive: true });
  await mkdir(outside, { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

let n = 0;
async function makeGame(): Promise<string> {
  const id = `mc-${++n}`;
  await mkdir(path.join(games, id, 'data'), { recursive: true });
  return id;
}

const JAR = Buffer.from('PK\u0003\u0004 fake jar content for tests');
const sha512 = (b: Buffer) => createHash('sha512').update(b).digest('hex');
const URL_OK = 'https://cdn.modrinth.com/data/AANobbMI/versions/abcdEFGH/sodium-0.6.0.jar';

interface Call {
  url: string;
  redirect: RequestInit['redirect'];
}

/** Local fetch: no network. `routes` maps a URL to a Response factory. */
function fakeFetch(routes: Record<string, () => Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, redirect: init.redirect });
      const r = routes[url];
      if (!r) throw new Error(`unexpected fetch ${url}`);
      return r();
    },
  };
}

const ok =
  (body: Buffer, headers: Record<string, string> = {}) =>
  () =>
    new Response(new Uint8Array(body), { status: 200, headers });
const redirect = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });

const params = (
  gameId: string,
  over: Partial<{
    url: string;
    fileName: string;
    sha512: string;
    sizeBytes: number;
    kind: 'plugins' | 'mods';
  }> = {},
) => ({
  gameId,
  kind: over.kind ?? ('plugins' as const),
  url: over.url ?? URL_OK,
  fileName: over.fileName ?? 'sodium-0.6.0.jar',
  sha512: over.sha512 ?? sha512(JAR),
  sizeBytes: over.sizeBytes ?? JAR.length,
});

function rejectsWith(p: Promise<unknown>, code: string, msg?: RegExp) {
  return expect(p).rejects.toSatisfy(
    (e: unknown) => e instanceof ActionError && e.code === code && (!msg || msg.test(e.message)),
  );
}

async function noTemp(dir: string) {
  const names = await readdir(dir).catch(() => [] as string[]);
  expect(names.filter((f) => f.endsWith('.part'))).toEqual([]);
}

describe('mod url schema', () => {
  it('only accepts cdn.modrinth.com jar urls', () => {
    const s = rpcParamsByAction['game.mods.install'].shape.url;
    expect(s.safeParse(URL_OK).success).toBe(true);
    for (const bad of [
      'http://cdn.modrinth.com/data/AANobbMI/versions/abcdEFGH/a.jar',
      'https://cdn.modrinth.com.evil.at/data/AANobbMI/versions/abcdEFGH/a.jar',
      'https://evil.at/data/AANobbMI/versions/abcdEFGH/a.jar',
      'https://cdn.modrinth.com/data/AANobbMI/versions/abcdEFGH/../a.jar',
      'https://cdn.modrinth.com/data/AANobbMI/versions/abcdEFGH/a%2f.jar',
    ]) {
      expect(s.safeParse(bad).success, bad).toBe(false);
    }
    expect(isCdnUrl(new URL('https://cdn.modrinth.com/x'))).toBe(true);
    expect(isCdnUrl(new URL('https://cdn.modrinth.com:8443/x'))).toBe(false);
    expect(isCdnUrl(new URL('https://u:p@cdn.modrinth.com/x'))).toBe(false);
  });
});

describe('game.mods.install', () => {
  it('downloads, verifies and stores the jar; list shows it; remove deletes it', async () => {
    const id = await makeGame();
    const { ctx } = makeCtx(root);
    const f = fakeFetch({ [URL_OK]: ok(JAR, { 'content-length': String(JAR.length) }) });
    const r = await gameModsInstallWith(params(id), ctx, { fetch: f.fetch });
    expect(gameModFileSchema.parse(r)).toEqual({
      fileName: 'sodium-0.6.0.jar',
      sizeBytes: JAR.length,
      sha512: sha512(JAR),
    });
    expect(f.calls).toEqual([{ url: URL_OK, redirect: 'manual' }]);
    const dir = path.join(games, id, 'data', 'plugins');
    expect((await lstat(dir)).mode & 0o777).toBe(0o755);
    expect(await readFile(path.join(dir, 'sodium-0.6.0.jar'))).toEqual(JAR);
    await noTemp(dir);

    await writeFile(path.join(dir, 'notes.txt'), 'x');
    await symlink(path.join(outside, 'x.jar'), path.join(dir, 'link.jar'));
    const list = gameModsListDataSchema.parse(
      await gameModsList({ gameId: id, kind: 'plugins' }, ctx),
    );
    expect(list.files.map((x) => x.fileName)).toEqual(['sodium-0.6.0.jar']);
    expect(await gameModsList({ gameId: id, kind: 'mods' }, ctx)).toEqual({ files: [] });

    await expect(
      gameModsRemove({ gameId: id, kind: 'plugins', fileName: 'sodium-0.6.0.jar' }, ctx),
    ).resolves.toEqual({ removed: true });
    await rejectsWith(
      gameModsRemove({ gameId: id, kind: 'plugins', fileName: 'sodium-0.6.0.jar' }, ctx),
      'not_found',
    );
    // a symlink is not a regular file: never removed (nor followed)
    await rejectsWith(
      gameModsRemove({ gameId: id, kind: 'plugins', fileName: 'link.jar' }, ctx),
      'bad_path',
    );
  });

  it('rejects a wrong hash and leaves nothing behind', async () => {
    const id = await makeGame();
    const { ctx } = makeCtx(root);
    const f = fakeFetch({ [URL_OK]: ok(JAR) });
    await rejectsWith(
      gameModsInstallWith(params(id, { sha512: 'a'.repeat(128) }), ctx, { fetch: f.fetch }),
      'failed',
      /sha512/,
    );
    const dir = path.join(games, id, 'data', 'plugins');
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects a body larger than announced (header or stream) and a short one', async () => {
    const id = await makeGame();
    const { ctx } = makeCtx(root);
    const dir = path.join(games, id, 'data', 'plugins');
    const big = Buffer.concat([JAR, Buffer.alloc(100, 1)]);
    const viaHeader = fakeFetch({ [URL_OK]: ok(big, { 'content-length': String(big.length) }) });
    await rejectsWith(
      gameModsInstallWith(params(id), ctx, { fetch: viaHeader.fetch }),
      'failed',
      /larger/,
    );
    // no content-length: the stream is cut at sizeBytes + 1
    const viaStream = fakeFetch({ [URL_OK]: ok(big) });
    await rejectsWith(
      gameModsInstallWith(params(id), ctx, { fetch: viaStream.fetch }),
      'failed',
      /larger/,
    );
    const short = fakeFetch({ [URL_OK]: ok(JAR.subarray(0, 5)) });
    await rejectsWith(
      gameModsInstallWith(params(id), ctx, { fetch: short.fetch }),
      'failed',
      /size/,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('follows redirects only on cdn.modrinth.com', async () => {
    const id = await makeGame();
    const { ctx } = makeCtx(root);
    const other = 'https://cdn.modrinth.com/data/AANobbMI/versions/abcdEFGH/other.jar';
    const good = fakeFetch({ [URL_OK]: redirect(other), [other]: ok(JAR) });
    await expect(
      gameModsInstallWith(params(id), ctx, { fetch: good.fetch }),
    ).resolves.toMatchObject({
      sizeBytes: JAR.length,
    });
    expect(good.calls.map((c) => c.redirect)).toEqual(['manual', 'manual']);

    for (const loc of [
      'https://evil.example/a.jar',
      'http://cdn.modrinth.com/data/a.jar',
      '//evil.example/a.jar',
      'https://cdn.modrinth.com.evil.example/a.jar',
    ]) {
      const bad = fakeFetch({ [URL_OK]: redirect(loc) });
      await rejectsWith(
        gameModsInstallWith(params(id, { fileName: 'other-1.jar' }), ctx, { fetch: bad.fetch }),
        'not_allowed',
      );
      expect(bad.calls).toHaveLength(1);
    }
    // endless redirects stop
    const loop = fakeFetch({ [URL_OK]: redirect(URL_OK) });
    await rejectsWith(
      gameModsInstallWith(params(id, { fileName: 'loop.jar' }), ctx, { fetch: loop.fetch }),
      'failed',
    );
    await noTemp(path.join(games, id, 'data', 'plugins'));
  });

  it('refuses when the file exists already (never overwrites)', async () => {
    const id = await makeGame();
    const { ctx } = makeCtx(root);
    const dir = path.join(games, id, 'data', 'plugins');
    await mkdir(dir);
    await writeFile(path.join(dir, 'sodium-0.6.0.jar'), 'old');
    const f = fakeFetch({ [URL_OK]: ok(JAR) });
    await rejectsWith(gameModsInstallWith(params(id), ctx, { fetch: f.fetch }), 'busy');
    expect(f.calls).toEqual([]);
    expect(await readFile(path.join(dir, 'sodium-0.6.0.jar'), 'utf8')).toBe('old');
    // a dangling symlink with that name counts as existing too
    await symlink(path.join(outside, 'new.jar'), path.join(dir, 'new.jar'));
    await rejectsWith(
      gameModsInstallWith(params(id, { fileName: 'new.jar' }), ctx, { fetch: f.fetch }),
      'busy',
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a symlinked plugins folder, data folder or game folder', async () => {
    const f = fakeFetch({ [URL_OK]: ok(JAR) });
    const { ctx } = makeCtx(root);

    const a = await makeGame();
    await symlink(outside, path.join(games, a, 'data', 'plugins'));
    await rejectsWith(gameModsInstallWith(params(a), ctx, { fetch: f.fetch }), 'bad_path');
    await rejectsWith(gameModsList({ gameId: a, kind: 'plugins' }, ctx), 'bad_path');

    const b = `mc-${++n}`;
    await mkdir(path.join(games, b));
    await symlink(outside, path.join(games, b, 'data'));
    await rejectsWith(gameModsInstallWith(params(b), ctx, { fetch: f.fetch }), 'bad_path');

    const c = `mc-${++n}`;
    await symlink(outside, path.join(games, c));
    await rejectsWith(gameModsInstallWith(params(c), ctx, { fetch: f.fetch }), 'bad_path');

    const d = `mc-${++n}`;
    await mkdir(path.join(games, d));
    await rejectsWith(gameModsInstallWith(params(d), ctx, { fetch: f.fetch }), 'not_found');

    expect(f.calls).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
  });

  it('a failing download and an HTTP error leave no temp file', async () => {
    const id = await makeGame();
    const { ctx } = makeCtx(root);
    const dir = path.join(games, id, 'data', 'mods');
    const boom: FetchLike = async () => {
      throw new Error('network down');
    };
    await rejectsWith(
      gameModsInstallWith(params(id, { kind: 'mods' }), ctx, { fetch: boom }),
      'failed',
    );
    const notFound = fakeFetch({ [URL_OK]: () => new Response('nope', { status: 404 }) });
    await rejectsWith(
      gameModsInstallWith(params(id, { kind: 'mods' }), ctx, { fetch: notFound.fetch }),
      'failed',
      /404/,
    );
    expect(await readdir(dir)).toEqual([]);
  });
});

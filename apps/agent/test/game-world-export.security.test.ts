import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rpcParamsByAction, type TransferChunk } from '@hz/shared';
import { isDirLocked } from '../src/actions/dir-lock.js';
import { gameExport } from '../src/actions/game-export.js';
import { exportTarArgs, resolveWorldMembers } from '../src/actions/game-transfer.js';
import { ActionError } from '../src/actions/types.js';
import { spawnFile } from '../src/exec.js';
import { makeCtx } from './game-helpers.js';
import { COMPRESSION, recordingStreams, streamEnd, type Frame } from './migrate-helpers.js';

/** M12 world download: game.export with `paths` packs only data/<path>, never configs. */

let base: string;
let root: string;
let games: string;
let n = 0;
// Split so secret scanners do not flag the test fixture.
const RCON_SECRET = ['rcon', 'pw', 'not', 'for', 'friends'].join('-');

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-world-')));
  root = path.join(base, 'homelab');
  games = path.join(root, 'games');
  await mkdir(games, { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function makeGame(): Promise<{ id: string; dir: string }> {
  const id = `world-${++n}`;
  const dir = path.join(games, id);
  const data = path.join(dir, 'data');
  await mkdir(path.join(data, 'world', 'region'), { recursive: true });
  await mkdir(path.join(data, 'world_nether'), { recursive: true });
  await mkdir(path.join(data, 'logs'), { recursive: true });
  await writeFile(path.join(data, 'world', 'level.dat'), 'level');
  await writeFile(path.join(data, 'world', 'region', 'r.0.0.mca'), randomBytes(2000));
  await writeFile(path.join(data, 'world_nether', 'level.dat'), 'nether');
  await writeFile(path.join(data, 'server.properties'), `rcon.password=${RCON_SECRET}\n`);
  await writeFile(path.join(data, '.rcon-cli.env'), `password=${RCON_SECRET}\n`);
  await writeFile(path.join(data, 'logs', 'latest.log'), 'Mia[/203.0.113.7:51234] logged in\n');
  await writeFile(path.join(dir, '.env'), `RCON_PASSWORD=${RCON_SECRET}\n`, { mode: 0o600 });
  return { id, dir };
}

async function exportNames(id: string, paths: string[]): Promise<{ names: string[]; raw: string }> {
  const { streams, frames } = recordingStreams();
  const { ctx } = makeCtx(root, { streams, spawn: spawnFile });
  const rpcId = `world-export-${String(++n).padStart(4, '0')}`;
  await gameExport({ gameId: id, maxBytes: 1e9, paths }, ctx, rpcId, { compression: COMPRESSION });
  streams.activate(rpcId);
  let acked = -1;
  const chunks = (f: Frame[]) => f.filter((x): x is TransferChunk => x.type === 'transfer.chunk');
  while (!streamEnd(frames)) {
    const last = chunks(frames).at(-1);
    if (last && last.seq > acked) {
      acked = last.seq;
      streams.deliver({ type: 'transfer.ack', streamId: rpcId, seq: acked });
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(streamEnd(frames)).toMatchObject({ code: 0 });
  const archive = Buffer.concat(chunks(frames).map((c) => Buffer.from(c.data, 'base64')));
  const file = path.join(base, `${rpcId}.tar`);
  await writeFile(file, archive);
  const flag = COMPRESSION === 'zstd' ? '--zstd' : '--gzip';
  const names = execFileSync('tar', ['--list', flag, '--file', file], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const raw = execFileSync('tar', ['--extract', '--to-stdout', flag, '--file', file]).toString(
    'latin1',
  );
  expect(JSON.stringify(frames)).not.toContain(RCON_SECRET);
  return { names, raw };
}

function rejectsWith(p: Promise<unknown>, code: string) {
  return expect(p).rejects.toSatisfy((e: unknown) => e instanceof ActionError && e.code === code);
}

describe('game.export with world paths', () => {
  it('packs only data/world/..., no server.properties, .rcon-cli.env or logs', async () => {
    const g = await makeGame();
    const { names, raw } = await exportNames(g.id, ['world']);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((m) => m === 'data/world/' || m.startsWith('data/world/'))).toBe(true);
    expect(names).toContain('data/world/level.dat');
    expect(names).toContain('data/world/region/r.0.0.mca');
    expect(raw).not.toContain(RCON_SECRET);
    expect(raw).not.toContain('203.0.113.7');
  });

  it('skips missing paths and keeps several world folders', async () => {
    const g = await makeGame();
    const { names } = await exportNames(g.id, ['world', 'world_nether', 'world_the_end']);
    expect(names.some((m) => m.startsWith('data/world_nether/'))).toBe(true);
    expect(names.some((m) => m.includes('world_the_end'))).toBe(false);
    expect(names.some((m) => m.includes('server.properties') || m.includes('logs'))).toBe(false);
  });

  it('refuses a symlinked world (world -> /) and a symlinked parent', async () => {
    const g = await makeGame();
    const data = path.join(g.dir, 'data');
    await rm(path.join(data, 'world'), { recursive: true });
    await symlink('/', path.join(data, 'world'));
    await rejectsWith(resolveWorldMembers(g.dir, ['world']), 'bad_path');
    const { streams } = recordingStreams();
    const { ctx } = makeCtx(root, { streams, spawn: spawnFile });
    await rejectsWith(
      gameExport({ gameId: g.id, maxBytes: 1e9, paths: ['world'] }, ctx, 'world-export-link1', {
        compression: COMPRESSION,
      }),
      'bad_path',
    );
    expect(isDirLocked(g.dir)).toBe(false);
    expect(await readdir(path.join(root, 'backups', g.id)).catch(() => [])).toEqual([]);

    await symlink(path.join(data, 'logs'), path.join(data, 'saves'));
    await rejectsWith(resolveWorldMembers(g.dir, ['saves/latest.log']), 'bad_path');
  });

  it('refuses when nothing exists, and odd paths', async () => {
    const g = await makeGame();
    await rejectsWith(resolveWorldMembers(g.dir, ['worlds']), 'not_found');
    for (const bad of ['../x', '/etc', 'a//b', '.', 'world/..', '']) {
      await rejectsWith(resolveWorldMembers(g.dir, [bad]), 'invalid_params');
    }
    const schema = rpcParamsByAction['game.export'];
    for (const bad of ['../x', '/etc', 'a/../b', 'a b']) {
      expect(schema.safeParse({ gameId: g.id, maxBytes: 1, paths: [bad] }).success, bad).toBe(
        false,
      );
    }
    expect(await resolveWorldMembers(g.dir, ['world', 'world'])).toEqual(['data/world']);
  });

  it('tar members are fixed and below data/', () => {
    const args = exportTarArgs(
      '/opt/homelab/backups/mc/.e.tar.zst',
      '/opt/homelab/games/mc',
      'zstd',
      ['data/world', 'data/world_nether'],
    );
    expect(args.slice(-3)).toEqual(['--', 'data/world', 'data/world_nether']);
    expect(args).not.toContain('--dereference');
    expect(() => exportTarArgs('/a/x', '/a/g', 'zstd', ['other'])).toThrow(ActionError);
    expect(() => exportTarArgs('/a/x', '/a/g', 'zstd', ['data/../x'])).toThrow(ActionError);
  });
});

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gameStatusDataSchema,
  rconDataSchema,
  rpcParamsByAction,
  type AgentEvent,
} from '@hz/shared';
import { Dispatcher, handlers } from '../src/actions/index.js';
import { composeWrite } from '../src/actions/compose.js';
import {
  cleanOutput,
  parseEnv,
  readGameEnv,
  resolveGameDir,
  stripColors,
} from '../src/actions/game-common.js';
import {
  checkGamedigType,
  gameRcon,
  gameStatus,
  GAMEDIG_TYPES,
  parseTps,
} from '../src/actions/games.js';
import { rconRun } from '../src/actions/rcon.js';
import {
  closedPort,
  makeCtx,
  startFakeJavaStatus,
  startFakePalworld,
  startFakeRcon,
  type FakeRcon,
} from './game-helpers.js';

// Built at runtime so secret scanners do not flag a fake credential.
const PASSWORD = ['Rc0n', 'Secret', 'Pw', randomBytes(4).toString('hex')].join('-');

let base: string;
let root: string;
let outside: string;
let games: string;

async function makeGame(name: string, env?: string): Promise<string> {
  const dir = path.join(games, name);
  await mkdir(path.join(dir, 'data'), { recursive: true });
  if (env !== undefined) await writeFile(path.join(dir, '.env'), env, { mode: 0o600 });
  return dir;
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hz-games-')));
  root = path.join(base, 'homelab');
  outside = path.join(base, 'outside');
  games = path.join(root, 'games');
  await mkdir(games, { recursive: true });
  await mkdir(path.join(root, 'apps', 'web'), { recursive: true });
  await mkdir(path.join(games, 'mc', 'nested'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'stolen.env'), `RCON_PASSWORD=${PASSWORD}\nPORT_RCON=1\n`);
  // game folder symlinks: to another homelab folder and out of the root
  await symlink(path.join(root, 'apps', 'web'), path.join(games, 'to-apps'));
  await symlink(outside, path.join(games, 'to-outside'));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const rpc = (action: string, params: unknown) => ({
  type: 'rpc' as const,
  id: 'rpc_games0001',
  action,
  params,
});

describe('gameDir check', () => {
  it('accepts /opt/homelab/games/<name>', async () => {
    const dir = await makeGame('ok-game');
    await expect(resolveGameDir(dir, `${root}/`)).resolves.toMatchObject({
      dir,
      name: 'ok-game',
    });
  });

  it.each([
    ['the games folder itself', () => games],
    ['another homelab folder', () => path.join(root, 'apps', 'web')],
    ['a nested folder', () => path.join(games, 'mc', 'nested')],
    ['a symlink to another homelab folder', () => path.join(games, 'to-apps')],
    ['a symlink out of the root', () => path.join(games, 'to-outside')],
    ['an invalid name', () => path.join(games, 'Big_Name')],
  ])('refuses %s', async (_label, dir) => {
    await expect(resolveGameDir(dir(), `${root}/`)).rejects.toMatchObject({ code: 'bad_path' });
  });

  it('reports a missing game folder as not_found', async () => {
    await expect(resolveGameDir(path.join(games, 'missing'), `${root}/`)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses a games folder that is a symlink to elsewhere in the root', async () => {
    const r2 = path.join(base, 'homelab2');
    await mkdir(path.join(r2, 'real-games', 'x1'), { recursive: true });
    await symlink(path.join(r2, 'real-games'), path.join(r2, 'games'));
    await expect(resolveGameDir(path.join(r2, 'games', 'x1'), `${r2}/`)).rejects.toMatchObject({
      code: 'bad_path',
    });
  });

  it('every game handler refuses paths outside games/ (bad_path, audited)', async () => {
    const { ctx, rec } = makeCtx(root);
    const dirs = [path.join(root, 'apps', 'web'), path.join(games, 'mc', 'nested')];
    for (const gameDir of dirs) {
      const calls = [
        () => handlers['game.rcon']({ gameDir, command: 'list' }, ctx, 'rpc_games0001'),
        () => handlers['game.backup']({ gameDir, keep: 7 }, ctx, 'rpc_games0002'),
        () =>
          handlers['game.status'](
            { gameDir, method: 'minecraft', port: 25565, timeoutMs: 1000 },
            ctx,
            'rpc_games0003',
          ),
        () => handlers['game.remove']({ gameDir }, ctx, 'rpc_games0004'),
      ];
      for (const c of calls) {
        await expect(c()).rejects.toMatchObject({ code: 'bad_path', audit: true });
      }
    }
    expect(rec.runs).toEqual([]);
    expect(ctx.streams.size).toBe(0);
  });

  it('the dispatcher refuses game actions outside /opt/homelab/games syntactically', async () => {
    const { ctx } = makeCtx(root);
    const events: AgentEvent[] = [];
    const d = new Dispatcher(ctx, (e) => events.push(e));
    const res = await d.handle(rpc('game.remove', { gameDir: '/opt/homelab/../etc' }));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(events[0]?.event.kind).toBe('denied');
  });

  it('the schema already refuses paths outside /opt/homelab/', () => {
    for (const action of ['game.rcon', 'game.backup', 'game.status', 'game.remove'] as const) {
      const r = rpcParamsByAction[action].safeParse({
        gameDir: '/etc',
        command: 'x',
        method: 'none',
        port: 1,
      });
      expect(r.success).toBe(false);
    }
  });
});

describe('.env', () => {
  it('parses KEY=VALUE without shell semantics', () => {
    const env = parseEnv(
      [
        '# comment',
        '',
        'A=$(id)',
        'B=`id`',
        "C='quoted value'",
        'D="dq"',
        'E=${A}',
        'export F=1',
        'not a line',
        'G=a=b\r',
      ].join('\n'),
    );
    expect(env.get('A')).toBe('$(id)');
    expect(env.get('B')).toBe('`id`');
    expect(env.get('C')).toBe('quoted value');
    expect(env.get('D')).toBe('dq');
    expect(env.get('E')).toBe('${A}');
    expect(env.has('F')).toBe(false);
    expect(env.get('G')).toBe('a=b');
  });

  it('refuses a .env symlink (even to a file inside the root)', async () => {
    const dir = await makeGame('env-link');
    await symlink(path.join(outside, 'stolen.env'), path.join(dir, '.env'));
    await expect(readGameEnv(dir)).rejects.toMatchObject({ code: 'bad_path' });
  });

  it('refuses a .env directory and a .env above 64 KB', async () => {
    const d1 = await makeGame('env-dir');
    await mkdir(path.join(d1, '.env'));
    await expect(readGameEnv(d1)).rejects.toMatchObject({ code: 'bad_path' });
    const d2 = await makeGame('env-big', `A=${'x'.repeat(70 * 1024)}\n`);
    await expect(readGameEnv(d2)).rejects.toMatchObject({ code: 'failed' });
  });

  it('missing .env: rcon answers not_found', async () => {
    const dir = await makeGame('no-env');
    const { ctx } = makeCtx(root);
    await expect(gameRcon({ gameDir: dir, command: 'list' }, ctx)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('game.rcon refuses a symlinked .env through the dispatcher', async () => {
    const dir = await makeGame('env-link2');
    await symlink(path.join(outside, 'stolen.env'), path.join(dir, '.env'));
    const { ctx, rec } = makeCtx(root);
    const err = await gameRcon({ gameDir: dir, command: 'list' }, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'bad_path' });
    expect(String((err as Error).message)).not.toContain(PASSWORD);
    expect(rec.logs.join('\n')).not.toContain(PASSWORD);
  });
});

describe('compose.write .env', () => {
  it('writes .env with mode 0600 and other files with 0640', async () => {
    const dir = path.join(games, 'written');
    const { ctx, rec } = makeCtx(root);
    await composeWrite(
      {
        dir,
        files: { 'compose.yml': 'services: {}\n', '.env': `RCON_PASSWORD=${PASSWORD}\n` },
      },
      ctx,
    );
    expect((await stat(path.join(dir, '.env'))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dir, 'compose.yml'))).mode & 0o777).toBe(0o640);
    expect(rec.logs.join('\n')).not.toContain(PASSWORD);
  });

  it('the schema allows exactly .env as dotfile', () => {
    const schema = rpcParamsByAction['compose.write'];
    const ok = (name: string) =>
      schema.safeParse({ dir: '/opt/homelab/games/mc', files: { [name]: 'x' } }).success;
    expect(ok('.env')).toBe(true);
    for (const n of ['.envrc', '.env.local', '.git', '.bashrc', '..env']) expect(ok(n)).toBe(false);
  });
});

describe('game.rcon', () => {
  let rcon: FakeRcon;
  let dir: string;

  beforeAll(async () => {
    rcon = await startFakeRcon({
      password: PASSWORD,
      answer: (cmd) => {
        if (cmd === 'echo-secret') return `the password is ${PASSWORD}`;
        if (cmd === 'big') return 'y'.repeat(10_000);
        if (cmd === 'huge') return 'z'.repeat(100_000);
        if (cmd === 'list') return '§6There are §c1§6 of a max of §c20§6 players online: Alex';
        return `ok: ${cmd}`;
      },
    });
    dir = await makeGame('rcon-game', `RCON_PASSWORD=${PASSWORD}\nPORT_RCON=${rcon.port}\n`);
  });
  afterAll(async () => {
    await rcon.close();
  });

  it('runs one command, strips color codes, never returns the password', async () => {
    const { ctx, rec } = makeCtx(root);
    const res = await gameRcon({ gameDir: dir, command: 'list' }, ctx);
    expect(res.output).toBe('There are 1 of a max of 20 players online: Alex');
    expect(rconDataSchema.safeParse(res).success).toBe(true);
    const echoed = await gameRcon({ gameDir: dir, command: 'echo-secret' }, ctx);
    expect(echoed.output).toBe('the password is [redacted]');
    expect(rec.logs.join('\n')).not.toContain(PASSWORD);
    expect(rcon.commands).toContain('list');
  });

  it('collects fragmented answers and caps the output at 64 KiB', async () => {
    const { ctx } = makeCtx(root);
    expect((await gameRcon({ gameDir: dir, command: 'big' }, ctx)).output).toHaveLength(10_000);
    const huge = await gameRcon({ gameDir: dir, command: 'huge' }, ctx);
    expect(huge.output.length).toBe(64 * 1024);
  });

  it('refuses multi-line commands (schema and handler)', async () => {
    const { ctx } = makeCtx(root);
    const d = new Dispatcher(ctx, () => undefined);
    for (const command of ['say hi\nop evil', 'a\rb', 'a\0b']) {
      const res = await d.handle(rpc('game.rcon', { gameDir: dir, command }));
      expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
      await expect(gameRcon({ gameDir: dir, command }, ctx)).rejects.toMatchObject({
        code: 'invalid_params',
      });
    }
    expect(rcon.commands.some((c) => c.includes('evil'))).toBe(false);
  });

  it('a wrong password fails without echoing it', async () => {
    const bad = await makeGame(
      'rcon-bad',
      `RCON_PASSWORD=wrong-${PASSWORD}\nPORT_RCON=${rcon.port}\n`,
    );
    const { ctx, rec } = makeCtx(root);
    const err = await gameRcon({ gameDir: bad, command: 'list' }, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'failed', message: 'rcon authentication failed' });
    expect(JSON.stringify(err) + String((err as Error).message)).not.toContain(PASSWORD);
    expect(rec.logs.join('\n')).not.toContain(PASSWORD);
  });

  it('times out on a silent server', async () => {
    const silent = await startFakeRcon({ password: PASSWORD, silent: true });
    try {
      await expect(
        rconRun({ port: silent.port, password: PASSWORD, timeoutMs: 500 }, ['list']),
      ).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      await silent.close();
    }
  });

  it('handles Source-style auth (empty response before the auth answer)', async () => {
    const src = await startFakeRcon({ password: PASSWORD, sourceStyleAuth: true });
    try {
      const [out] = await rconRun({ port: src.port, password: PASSWORD, timeoutMs: 2000 }, [
        'status',
      ]);
      expect(out).toBe('ok: status');
    } finally {
      await src.close();
    }
  });

  it('connection refused is a failed result', async () => {
    const port = await closedPort();
    await expect(
      rconRun({ port, password: PASSWORD, timeoutMs: 2000 }, ['x']),
    ).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('game.status', () => {
  it('gamedig types come from an allowlist', () => {
    const base = { gameDir: '/opt/homelab/games/x', port: 1, timeoutMs: 1000 };
    for (const t of GAMEDIG_TYPES.keys()) {
      expect(() =>
        checkGamedigType({ ...base, method: 'gamedig', gamedigType: t as never }),
      ).not.toThrow();
    }
    for (const t of ['minecraft', 'teamspeak3', 'satisfactory', 'csgo', undefined]) {
      expect(() =>
        checkGamedigType({ ...base, method: 'gamedig', ...(t ? { gamedigType: t as never } : {}) }),
      ).toThrow(/gamedigType/);
    }
    expect(() =>
      checkGamedigType({ ...base, method: 'minecraft', gamedigType: 'valheim' }),
    ).toThrow();
    // The schema itself refuses odd strings.
    const schema = rpcParamsByAction['game.status'];
    for (const t of ['../x', 'Valheim', 'a b', 'x'.repeat(41)]) {
      expect(schema.safeParse({ ...base, method: 'gamedig', gamedigType: t }).success).toBe(false);
    }
    expect(schema.safeParse({ ...base, method: 'minecraft', tpsCommand: 'op me' }).success).toBe(
      false,
    );
  });

  it('refuses a gamedig type outside the allowlist before any query', async () => {
    const dir = await makeGame('gd-game');
    const { ctx } = makeCtx(root);
    await expect(
      gameStatus(
        {
          gameDir: dir,
          method: 'gamedig',
          port: 2456,
          gamedigType: 'teamspeak3' as never,
          timeoutMs: 1000,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_params', audit: true });
  });

  it('parses Paper tps output', () => {
    expect(parseTps('§6TPS from last 1m, 5m, 15m: §a*20.0, §a19.9, §a19.8')).toBe(20);
    expect(parseTps('TPS from last 1m, 5m, 15m: 17.53, 18.0, 19.0')).toBe(17.53);
    expect(parseTps('Unknown command')).toBeNull();
    expect(parseTps('TPS: 1000')).toBe(100);
  });

  it('strips colors and controls', () => {
    expect(stripColors('§aHi\x1b[31m red\x1b[0m\x07')).toBe('Hi red');
    expect(cleanOutput(`a ${PASSWORD} b`, PASSWORD)).toBe('a [redacted] b');
  });

  it('minecraft: players, names, version and tps over RCON; no password in the result', async () => {
    const mc = await startFakeJavaStatus({
      version: { name: 'Paper 1.21.10', protocol: 773 },
      players: {
        online: 2,
        max: 20,
        sample: [
          { name: '§cAlex', id: '00000000-0000-0000-0000-000000000001' },
          { name: 'B'.repeat(60), id: '00000000-0000-0000-0000-000000000002' },
        ],
      },
      description: { text: 'Homelab' },
    });
    const rcon = await startFakeRcon({
      password: PASSWORD,
      answer: (c) => (c === 'tps' ? '§6TPS from last 1m, 5m, 15m: §a19.5, 20.0, 20.0' : ''),
    });
    try {
      const dir = await makeGame(
        'status-mc',
        `RCON_PASSWORD="${PASSWORD}"\nPORT_RCON=${rcon.port}\n`,
      );
      const { ctx, rec } = makeCtx(root);
      const res = await gameStatus(
        { gameDir: dir, method: 'minecraft', port: mc.port, tpsCommand: 'tps', timeoutMs: 3000 },
        ctx,
      );
      expect(res).toEqual({
        online: true,
        players: { online: 2, max: 20, names: ['Alex', 'B'.repeat(40)] },
        version: 'Paper 1.21.10',
        tps: 19.5,
      });
      expect(gameStatusDataSchema.safeParse(res).success).toBe(true);
      expect(rcon.commands).toEqual(['tps']);
      expect(JSON.stringify(res)).not.toContain(PASSWORD);
      expect(rec.logs.join('\n')).not.toContain(PASSWORD);
    } finally {
      await mc.close();
      await rcon.close();
    }
  });

  it('an unreachable server is offline, not an error', async () => {
    const dir = await makeGame('status-off');
    const { ctx } = makeCtx(root);
    const port = await closedPort();
    for (const method of ['minecraft', 'none'] as const) {
      await expect(
        gameStatus({ gameDir: dir, method, port, timeoutMs: 1000 }, ctx),
      ).resolves.toEqual({ online: false, players: null, version: null, tps: null });
    }
  });

  it('none: a TCP connect decides online', async () => {
    const mc = await startFakeJavaStatus({});
    try {
      const dir = await makeGame('status-none');
      const { ctx } = makeCtx(root);
      const res = await gameStatus(
        { gameDir: dir, method: 'none', port: mc.port, timeoutMs: 1000 },
        ctx,
      );
      expect(res).toEqual({ online: true, players: null, version: null, tps: null });
    } finally {
      await mc.close();
    }
  });

  it('palworld: the admin password goes only to 127.0.0.1, never into the result', async () => {
    const pal = await startFakePalworld(PASSWORD);
    try {
      const dir = await makeGame('status-pal', `RCON_PASSWORD=${PASSWORD}\nPORT_RCON=25575\n`);
      const { ctx, rec } = makeCtx(root);
      const res = await gameStatus(
        {
          gameDir: dir,
          method: 'gamedig',
          gamedigType: 'palworld',
          port: pal.port,
          timeoutMs: 3000,
        },
        ctx,
      );
      expect(res).toEqual({
        online: true,
        players: { online: 2, max: 16, names: ['Alex', 'Bob'] },
        version: 'v0.6.1',
        tps: null,
      });
      expect(pal.auths.length).toBeGreaterThan(0);
      expect(JSON.stringify(res)).not.toContain(PASSWORD);
      expect(rec.logs.join('\n')).not.toContain(PASSWORD);
    } finally {
      await pal.close();
    }
  });
});

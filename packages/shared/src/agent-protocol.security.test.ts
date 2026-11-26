import { describe, expect, it } from 'vitest';
import {
  homelabPathSchema,
  parseAgentMessage,
  parseCoreMessage,
  parseRpc,
  rpcActions,
  repoUrlSchema,
  composeFilesSchema,
} from './agent-protocol.js';

describe('agent protocol allowlist', () => {
  it('rejects actions that are not on the allowlist', () => {
    for (const action of [
      'exec',
      'shell',
      'system.exec',
      '__proto__',
      'constructor',
      'toString',
      '',
    ]) {
      const r = parseRpc({ type: 'rpc', id: 'abcdefgh', action, params: {} });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('not_allowed');
    }
  });

  it('contains exactly the documented actions', () => {
    expect(rpcActions.sort()).toEqual(
      [
        'check.http',
        'check.ping',
        'check.tcp',
        'compose.down',
        'compose.pull',
        'compose.up',
        'compose.write',
        'container.limit',
        'container.logs',
        'container.restart',
        'container.start',
        'container.stop',
        'container.update',
        'deploy.run',
        'deploy.key',
        'game.status',
        'game.remove',
        'game.backup',
        'game.backups.purge',
        'game.export',
        'game.import',
        'game.rcon',
        'pty.close',
        'pty.input',
        'pty.open',
        'pty.resize',
        'system.cleanup',
        'system.cleanupPreview',
        'system.reboot',
        'wol.send',
      ].sort(),
    );
  });

  it('rejects unknown params (strict) and invalid params', () => {
    const extra = parseRpc({
      type: 'rpc',
      id: 'abcdefgh',
      action: 'container.start',
      params: { id: 'web', cmd: 'rm -rf /' },
    });
    expect(extra.ok).toBe(false);
    const bad = parseRpc({
      type: 'rpc',
      id: 'abcdefgh',
      action: 'container.start',
      params: { id: '; rm -rf /' },
    });
    expect(bad.ok).toBe(false);
    const ok = parseRpc({
      type: 'rpc',
      id: 'abcdefgh',
      action: 'container.start',
      params: { id: 'web-1' },
    });
    expect(ok.ok).toBe(true);
  });

  it('rcon commands are single line', () => {
    const r = parseRpc({
      type: 'rpc',
      id: 'abcdefgh',
      action: 'game.rcon',
      params: { gameDir: '/opt/homelab/games/mc', command: 'say hi\nop evil' },
    });
    expect(r.ok).toBe(false);
  });
});

describe('homelab path check (syntax)', () => {
  it.each(['/opt/homelab/apps/web', '/opt/homelab/games/mc-1'])('accepts %s', (p) =>
    expect(homelabPathSchema.safeParse(p).success).toBe(true),
  );

  it.each([
    '/opt/homelab/',
    '/opt/homelab',
    '/opt/homelab/../etc',
    '/opt/homelab/apps/../../etc/passwd',
    '/opt/homelab/./x',
    '/opt/homelab//x',
    '/etc/passwd',
    'opt/homelab/x',
    '/opt/homelabx/y',
    '/opt/homelab/x\0y',
  ])('rejects %s', (p) => expect(homelabPathSchema.safeParse(p).success).toBe(false));

  it('compose file names cannot traverse', () => {
    expect(composeFilesSchema.safeParse({ '../x': 'a' }).success).toBe(false);
    expect(composeFilesSchema.safeParse({ 'a/b.yml': 'a' }).success).toBe(false);
    expect(composeFilesSchema.safeParse({ 'compose.yml': 'a' }).success).toBe(true);
    expect(composeFilesSchema.safeParse({}).success).toBe(false);
  });

  it('compose.write allows .env but no other dotfiles', () => {
    expect(composeFilesSchema.safeParse({ 'compose.yml': 'a', '.env': 'A=1' }).success).toBe(true);
    for (const name of ['.git', '.envrc', '.env.local', '..env', '.ssh', '.env/x']) {
      expect(composeFilesSchema.safeParse({ [name]: 'a' }).success, name).toBe(false);
    }
  });

  it('repo urls are github only', () => {
    expect(repoUrlSchema.safeParse('https://github.com/a/b.git').success).toBe(true);
    expect(repoUrlSchema.safeParse('git@github.com:a/b.git').success).toBe(true);
    expect(repoUrlSchema.safeParse('https://evil.com/a/b').success).toBe(false);
    expect(repoUrlSchema.safeParse('--upload-pack=touch /tmp/x').success).toBe(false);
    expect(repoUrlSchema.safeParse('ext::sh -c touch% /tmp/x').success).toBe(false);
  });
});

describe('message parsing', () => {
  it('rejects garbage, unknown types and oversized frames', () => {
    expect(parseAgentMessage('not json')).toBeNull();
    expect(parseAgentMessage('{"type":"exec","cmd":"id"}')).toBeNull();
    expect(parseAgentMessage('x'.repeat(2 * 1024 * 1024))).toBeNull();
    expect(parseCoreMessage('{"type":"rpc"}')).toBeNull();
  });

  it('parses rpc results and metrics', () => {
    expect(
      parseAgentMessage(
        JSON.stringify({ type: 'rpc.result', id: 'abcdefgh', ok: true, data: { x: 1 } }),
      )?.type,
    ).toBe('rpc.result');
    expect(
      parseAgentMessage(
        JSON.stringify({
          type: 'rpc.result',
          id: 'abcdefgh',
          ok: false,
          error: { code: 'not_allowed', message: 'no' },
        }),
      )?.type,
    ).toBe('rpc.result');
    const m = parseAgentMessage(
      JSON.stringify({
        type: 'metrics',
        ts: new Date().toISOString(),
        cpu: 12.5,
        ram: { usedBytes: 1, totalBytes: 2 },
        swap: { usedBytes: 0, totalBytes: 0 },
        disks: [{ mount: '/', usedBytes: 1, totalBytes: 2 }],
        temp: null,
        net: { rxBps: 0, txBps: 0 },
        uptimeS: 10,
      }),
    );
    expect(m?.type).toBe('metrics');
  });
});

describe('deploy schemas', () => {
  it('refuses .git segments in homelab paths', async () => {
    const { homelabPathSchema } = await import('./agent-protocol.js');
    for (const p of [
      '/opt/homelab/app/.git',
      '/opt/homelab/app/.git/hooks',
      '/opt/homelab/.GIT/x',
    ]) {
      expect(homelabPathSchema.safeParse(p).success).toBe(false);
    }
    expect(homelabPathSchema.safeParse('/opt/homelab/apps/web.github').success).toBe(true);
  });

  it('accepts only plain github repo urls', async () => {
    const { repoUrlSchema } = await import('./agent-protocol.js');
    for (const u of [
      'https://github.com/puffybooy/homelab-zentrale',
      'https://github.com/puffybooy/homelab-zentrale.git',
      'git@github.com:puffybooy/beispiel.at.git',
    ]) {
      expect(repoUrlSchema.safeParse(u).success, u).toBe(true);
    }
    for (const u of [
      'https://github.com/-x/y',
      'https://github.com/./y',
      'https://github.com/a/..',
      'https://github.com/a/.git',
      'https://github.com/a/..git',
      'git@github.com:a/-y.git',
      'https://user:tok@github.com/a/b',
      'file:///opt/x',
      'ext::sh -c x',
      'https://github.com/a/b;x',
    ]) {
      expect(repoUrlSchema.safeParse(u).success, u).toBe(false);
    }
  });
});

describe('game.backups.purge', () => {
  const rpc = (params: unknown) =>
    parseRpc({ type: 'rpc', id: 'abcdefgh', action: 'game.backups.purge', params });

  it('accepts a game folder name and a day count', () => {
    expect(rpc({ gameId: 'mc-1', olderThanDays: 30 }).ok).toBe(true);
    expect(rpc({ gameId: 'ab', olderThanDays: 1 }).ok).toBe(true);
    expect(rpc({ gameId: 'ab', olderThanDays: 3650 }).ok).toBe(true);
  });

  it('rejects path tricks, bad day counts and extra params', () => {
    for (const gameId of [
      '..',
      '../etc',
      'mc/..',
      '/opt/homelab/backups/mc',
      'MC',
      '-mc',
      'a',
      'mc\0',
      ' mc',
    ]) {
      expect(rpc({ gameId, olderThanDays: 30 }).ok, gameId).toBe(false);
    }
    for (const olderThanDays of [0, -1, 1.5, 3651, '30']) {
      expect(rpc({ gameId: 'mc', olderThanDays }).ok).toBe(false);
    }
    expect(rpc({ gameId: 'mc', olderThanDays: 30, path: '/etc' }).ok).toBe(false);
    expect(rpc({ gameId: 'mc' }).ok).toBe(false);
  });
});

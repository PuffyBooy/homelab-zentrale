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
        'container.logs',
        'container.restart',
        'container.start',
        'container.stop',
        'container.update',
        'deploy.run',
        'deploy.key',
        'game.backup',
        'game.rcon',
        'pty.close',
        'pty.input',
        'pty.open',
        'pty.resize',
        'system.cleanup',
        'system.cleanupPreview',
        'system.reboot',
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

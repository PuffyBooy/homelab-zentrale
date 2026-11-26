import { describe, expect, it } from 'vitest';
import {
  agentToCoreSchema,
  checkArchiveMember,
  coreToAgentSchema,
  MAX_CHUNK_CHARS,
  MAX_TRANSFER_CHUNKS,
  MIGRATION_MAX_BYTES,
  parseRpc,
  streamingActions,
  TRANSFER_CHUNK_BYTES,
  transferChunkSchema,
} from '../agent-protocol.js';
import {
  gameMigrateRequestSchema,
  MIGRATION_PHASES,
  migrationActivePhases,
  migrationSchema,
} from './migrate.js';

const SHA = 'a'.repeat(64);
const rpc = (action: string, params: unknown) =>
  parseRpc({ type: 'rpc', id: 'rpc-00000001', action, params });

describe('transfer limits', () => {
  it('a full chunk fits exactly into MAX_CHUNK_CHARS', () => {
    const b64 = Buffer.alloc(TRANSFER_CHUNK_BYTES, 0xff).toString('base64');
    expect(b64.length).toBe(MAX_CHUNK_CHARS);
    const ok = transferChunkSchema.safeParse({
      type: 'transfer.chunk',
      streamId: 'stream-0001',
      seq: 0,
      data: b64,
    });
    expect(ok.success).toBe(true);
    expect(MIGRATION_MAX_BYTES).toBe(50 * 1024 ** 3);
    expect(MAX_TRANSFER_CHUNKS * TRANSFER_CHUNK_BYTES).toBeGreaterThanOrEqual(MIGRATION_MAX_BYTES);
  });

  it('rejects oversized, non-base64 and out-of-range chunks', () => {
    const base = { type: 'transfer.chunk', streamId: 'stream-0001', seq: 0 };
    const bad: unknown[] = [
      { ...base, data: 'A'.repeat(MAX_CHUNK_CHARS + 4) },
      { ...base, data: 'abc' },
      { ...base, data: 'ab$=' },
      { ...base, data: '' },
      { ...base, data: 'AAAA', seq: -1 },
      { ...base, data: 'AAAA', seq: 1.5 },
      { ...base, data: 'AAAA', seq: MAX_TRANSFER_CHUNKS },
      { ...base, data: 'AAAA', extra: 1 },
      { ...base, data: 'AAAA', streamId: '../x' },
    ];
    for (const b of bad) expect(transferChunkSchema.safeParse(b).success).toBe(false);
  });

  it('transfer frames are accepted in the right directions only', () => {
    const begin = {
      type: 'transfer.begin',
      streamId: 'stream-0001',
      bytes: 10,
      sha256: SHA,
      chunks: 1,
    };
    const end = {
      type: 'transfer.end',
      streamId: 'stream-0001',
      bytes: 10,
      sha256: SHA,
      chunks: 1,
    };
    const ack = { type: 'transfer.ack', streamId: 'stream-0001', seq: 0 };
    expect(agentToCoreSchema.safeParse(begin).success).toBe(true);
    expect(coreToAgentSchema.safeParse(begin).success).toBe(false);
    for (const m of [end, ack]) {
      expect(agentToCoreSchema.safeParse(m).success).toBe(true);
      expect(coreToAgentSchema.safeParse(m).success).toBe(true);
    }
    expect(agentToCoreSchema.safeParse({ ...end, bytes: MIGRATION_MAX_BYTES + 1 }).success).toBe(
      false,
    );
    expect(agentToCoreSchema.safeParse({ ...end, sha256: 'A'.repeat(64) }).success).toBe(false);
    expect(agentToCoreSchema.safeParse({ ...end, bytes: 0 }).success).toBe(false);
  });
});

describe('agent actions game.export / game.import', () => {
  it('are allowlisted streaming actions', () => {
    expect(streamingActions).toContain('game.export');
    expect(streamingActions).toContain('game.import');
    const exp = rpc('game.export', { gameId: 'survival' });
    expect(exp.ok && exp.request.params).toEqual({
      gameId: 'survival',
      maxBytes: MIGRATION_MAX_BYTES,
    });
    const imp = rpc('game.import', { gameId: 'survival', bytes: 1000, sha256: SHA, chunks: 1 });
    expect(imp.ok).toBe(true);
  });

  it('take a folder name, never a path', () => {
    const bad = [
      '../etc',
      '/opt/homelab/games/survival',
      'survival/../x',
      '.import-x',
      'Survival',
      'a',
      '-x',
      'x'.repeat(33),
      '',
    ];
    for (const gameId of bad) {
      expect(rpc('game.export', { gameId }).ok, gameId).toBe(false);
      expect(rpc('game.import', { gameId, bytes: 1, sha256: SHA, chunks: 1 }).ok, gameId).toBe(
        false,
      );
    }
    expect(rpc('game.export', { gameDir: '/opt/homelab/games/survival' }).ok).toBe(false);
    expect(
      rpc('game.import', { gameId: 'survival', bytes: 1, sha256: SHA, chunks: 1, dir: '/' }).ok,
    ).toBe(false);
  });

  it('enforce the size limit and a real checksum', () => {
    expect(rpc('game.export', { gameId: 'survival', maxBytes: MIGRATION_MAX_BYTES + 1 }).ok).toBe(
      false,
    );
    expect(
      rpc('game.import', {
        gameId: 'survival',
        bytes: MIGRATION_MAX_BYTES + 1,
        sha256: SHA,
        chunks: 1,
      }).ok,
    ).toBe(false);
    expect(rpc('game.import', { gameId: 'survival', bytes: 1, sha256: 'x', chunks: 1 }).ok).toBe(
      false,
    );
    expect(rpc('game.import', { gameId: 'survival', bytes: 1, sha256: SHA }).ok).toBe(false);
  });
});

describe('checkArchiveMember', () => {
  it('accepts files and folders below data/', () => {
    expect(checkArchiveMember('data/', 'dir').ok).toBe(true);
    expect(checkArchiveMember('data', 'dir').ok).toBe(true);
    expect(checkArchiveMember('data/world/level.dat', 'file').ok).toBe(true);
    expect(checkArchiveMember('data/world/region/', 'dir').ok).toBe(true);
    expect(checkArchiveMember('data/..hidden', 'file').ok).toBe(true);
  });

  it('rejects traversal, absolute paths, links and everything outside data/', () => {
    const bad: [string, Parameters<typeof checkArchiveMember>[1]][] = [
      ['/etc/passwd', 'file'],
      ['/opt/homelab/games/x/data/a', 'file'],
      ['../data/a', 'file'],
      ['data/../../etc/passwd', 'file'],
      ['data/a/../../b', 'file'],
      ['./data/a', 'file'],
      ['data/./a', 'file'],
      ['data//a', 'file'],
      ['compose.yml', 'file'],
      ['.env', 'file'],
      ['datax/a', 'file'],
      ['data', 'file'],
      ['data/link', 'symlink'],
      ['data/hard', 'hardlink'],
      ['data/dev', 'other'],
      ['data/a\0b', 'file'],
      ['data/a\nb', 'file'],
      ['', 'file'],
      [`data/${'a'.repeat(1100)}`, 'file'],
    ];
    for (const [p, k] of bad) expect(checkArchiveMember(p, k).ok, `${k} ${p}`).toBe(false);
  });
});

describe('migration API', () => {
  it('requires a target server id and bounded ports', () => {
    expect(gameMigrateRequestSchema.safeParse({ targetServerId: 'srv_12345678' }).success).toBe(
      true,
    );
    expect(
      gameMigrateRequestSchema.safeParse({ targetServerId: 'srv_12345678', ports: { game: 25570 } })
        .success,
    ).toBe(true);
    const bad: unknown[] = [
      {},
      { targetServerId: '../x' },
      { targetServerId: 'srv_12345678', ports: {} },
      { targetServerId: 'srv_12345678', ports: { game: 80 } },
      { targetServerId: 'srv_12345678', ports: { game: 70000 } },
      { targetServerId: 'srv_12345678', ports: { Game: 25570 } },
      { targetServerId: 'srv_12345678', sourceDir: '/' },
    ];
    for (const b of bad) expect(gameMigrateRequestSchema.safeParse(b).success).toBe(false);
  });

  it('has the documented phases', () => {
    expect(MIGRATION_PHASES).toEqual([
      'backup',
      'transfer',
      'restore',
      'start',
      'stop_old',
      'done',
      'failed',
    ]);
    expect(migrationActivePhases).not.toContain('done');
    expect(migrationActivePhases).not.toContain('failed');
  });

  it('migration status has no field for agent output or secrets', () => {
    const shape = Object.keys(migrationSchema.shape);
    for (const k of ['log', 'output', 'env', 'token', 'password', 'path'])
      expect(shape).not.toContain(k);
  });
});

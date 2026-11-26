import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRANSFER_CHUNK_BYTES, TRANSFER_WINDOW, type TransferChunk } from '@hz/shared';
import type { OutgoingTransferFrame } from '../src/agents/hub.js';
import { TransferRelay, type RelayFailure } from '../src/agents/transfer.js';

afterEach(() => {
  vi.useRealTimers();
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function chunksOf(data: Buffer): TransferChunk[] {
  const out: TransferChunk[] = [];
  for (let i = 0; i * TRANSFER_CHUNK_BYTES < data.length; i += 1) {
    out.push({
      type: 'transfer.chunk',
      streamId: 'export-0001',
      seq: i,
      data: data
        .subarray(i * TRANSFER_CHUNK_BYTES, (i + 1) * TRANSFER_CHUNK_BYTES)
        .toString('base64'),
    });
  }
  return out;
}

function relay(opts: { idleMs?: number; maxBytes?: number } = {}) {
  const failures: RelayFailure[] = [];
  const toTarget: OutgoingTransferFrame[] = [];
  const toSource: OutgoingTransferFrame[] = [];
  const r = new TransferRelay({ ...opts, onFail: (f) => failures.push(f) });
  r.attachSource('export-0001', (f) => {
    toSource.push(f);
    return true;
  });
  return { r, failures, toTarget, toSource };
}

const begin = (data: Buffer, over: Record<string, unknown> = {}) => ({
  type: 'transfer.begin' as const,
  streamId: 'export-0001',
  bytes: data.length,
  sha256: sha(data),
  chunks: Math.ceil(data.length / TRANSFER_CHUNK_BYTES),
  ...over,
});

describe('TransferRelay', () => {
  it('pipes chunks, acks the source only after the target, checks sha256', async () => {
    const data = randomBytes(2 * TRANSFER_CHUNK_BYTES + 7);
    const { r, failures, toTarget, toSource } = relay();
    r.fromSource(begin(data));
    const cs = chunksOf(data);
    r.fromSource(cs[0] as TransferChunk);
    // Queued until the target accepted.
    r.attachTarget('import-0001', (f) => {
      toTarget.push(f);
      return true;
    });
    expect(toTarget).toHaveLength(1);
    expect(toSource).toHaveLength(0);
    r.fromTarget({ type: 'transfer.ack', streamId: 'import-0001', seq: 0 });
    expect(toSource).toEqual([{ type: 'transfer.ack', streamId: 'export-0001', seq: 0 }]);
    r.fromSource(cs[1] as TransferChunk);
    r.fromSource(cs[2] as TransferChunk);
    r.fromSource({
      type: 'transfer.end',
      streamId: 'export-0001',
      chunks: 3,
      bytes: data.length,
      sha256: sha(data),
    });
    await expect(r.sourceDone).resolves.toEqual({
      bytes: data.length,
      chunks: 3,
      sha256: sha(data),
    });
    expect(toTarget.at(-1)).toMatchObject({ type: 'transfer.end', streamId: 'import-0001' });
    r.fromTarget({ type: 'transfer.ack', streamId: 'import-0001', seq: 2 });
    await r.allAcked;
    expect(r.bytesDone).toBe(data.length);
    expect(failures).toEqual([]);
    expect(r.maxInFlight).toBeLessThanOrEqual(TRANSFER_WINDOW);
  });

  it('recomputes sha256: a forged end is a checksum mismatch', () => {
    const data = randomBytes(100);
    const { r, failures } = relay();
    const fake = 'd'.repeat(64);
    r.fromSource(begin(data, { sha256: fake }));
    r.fromSource(chunksOf(data)[0] as TransferChunk);
    r.fromSource({
      type: 'transfer.end',
      streamId: 'export-0001',
      chunks: 1,
      bytes: 100,
      sha256: fake,
    });
    expect(failures).toEqual(['checksum_mismatch']);
  });

  it('refuses gaps, wrong sizes, acks from the source and too many bytes', () => {
    const data = randomBytes(3 * TRANSFER_CHUNK_BYTES);
    const cs = chunksOf(data);
    const a = relay();
    a.r.fromSource(begin(data));
    a.r.fromSource(cs[1] as TransferChunk);
    expect(a.failures).toEqual(['sequence']);

    const b = relay();
    b.r.fromSource(begin(data));
    b.r.fromSource({ ...(cs[0] as TransferChunk), data: 'AAAA' });
    expect(b.failures).toEqual(['sequence']);

    const c = relay();
    c.r.fromSource(begin(data));
    c.r.fromSource({ type: 'transfer.ack', streamId: 'export-0001', seq: 0 });
    expect(c.failures).toEqual(['sequence']);

    const d = relay({ maxBytes: 1000 });
    d.r.fromSource(begin(data));
    expect(d.failures).toEqual(['too_large']);

    const e = relay();
    e.r.fromSource(begin(data, { bytes: 2 * TRANSFER_CHUNK_BYTES + 1 }));
    e.r.fromSource(cs[0] as TransferChunk);
    e.r.fromSource(cs[1] as TransferChunk);
    e.r.fromSource(cs[2] as TransferChunk);
    expect(e.failures).toEqual(['too_large']);
  });

  it('holds at most the window before the target acks; more is a violation', () => {
    const data = randomBytes((TRANSFER_WINDOW + 2) * TRANSFER_CHUNK_BYTES);
    const cs = chunksOf(data);
    const { r, failures } = relay();
    r.fromSource(begin(data));
    for (let i = 0; i < TRANSFER_WINDOW; i += 1) r.fromSource(cs[i] as TransferChunk);
    expect(failures).toEqual([]);
    expect(r.maxInFlight).toBe(TRANSFER_WINDOW);
    r.fromSource(cs[TRANSFER_WINDOW] as TransferChunk);
    expect(failures).toEqual(['sequence']);
  });

  it('target acks beyond what was forwarded abort', () => {
    const data = randomBytes(10);
    const { r, failures } = relay();
    r.attachTarget('import-0001', () => true);
    r.fromSource(begin(data));
    r.fromTarget({ type: 'transfer.ack', streamId: 'import-0001', seq: 0 });
    expect(failures).toEqual(['sequence']);
  });

  it('idle timeout after transfer.begin', () => {
    vi.useFakeTimers();
    const data = randomBytes(10);
    const { r, failures } = relay({ idleMs: 1000 });
    r.fromSource(begin(data));
    vi.advanceTimersByTime(999);
    expect(failures).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(failures).toEqual(['timeout']);
  });
});

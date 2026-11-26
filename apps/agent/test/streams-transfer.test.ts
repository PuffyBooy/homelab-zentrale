import { describe, expect, it } from 'vitest';
import { recordingStreams } from './migrate-helpers.js';

describe('stream sinks with transfer frames', () => {
  it('queues transfer frames until the rpc.result went out, in order with stream.data', () => {
    const { streams, frames } = recordingStreams();
    const sink = streams.open('stream-0001');
    sink.data('progress', 'building\n');
    sink.transfer({
      type: 'transfer.begin',
      streamId: 'stream-0001',
      bytes: 3,
      sha256: 'a'.repeat(64),
      chunks: 1,
    });
    expect(frames).toEqual([]);
    streams.activate('stream-0001');
    expect(frames.map((f) => f.type)).toEqual(['stream.data', 'transfer.begin']);
  });

  it('delivers incoming frames only to a live stream with a handler, never across streams', () => {
    const { streams } = recordingStreams();
    const got: unknown[] = [];
    const sink = streams.open('stream-0001');
    sink.onTransfer((m) => got.push(m));
    const ack = { type: 'transfer.ack', streamId: 'stream-0001', seq: 0 } as const;
    expect(streams.deliver(ack)).toBe(false); // not active yet
    streams.activate('stream-0001');
    expect(streams.deliver(ack)).toBe(true);
    expect(streams.deliver({ ...ack, streamId: 'stream-0002' })).toBe(false);
    // A sink cannot send frames of another stream.
    sink.transfer({ type: 'transfer.ack', streamId: 'stream-0002', seq: 0 });
    streams.cancel('stream-0001');
    expect(streams.deliver(ack)).toBe(false);
    expect(got).toHaveLength(1);
  });
});

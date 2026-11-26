import { describe, expect, it } from 'vitest';
import { RpcStream, type StreamChunk } from '../src/agents/hub.js';

const chunk = (i: number): StreamChunk => ({ channel: 'stdout', chunk: `line ${i}\n` });

describe('RpcStream buffering (memory bound)', () => {
  it('does not buffer chunks for consumers that only listen on data', () => {
    const s = new RpcStream('r1', () => undefined);
    let seen = 0;
    s.on('data', () => seen++);
    for (let i = 0; i < 10_000; i++) s.pushData(chunk(i));
    expect(seen).toBe(10_000);
    expect(s.queued).toBe(0);
  });

  it('caps the buffer when nobody consumes', () => {
    const s = new RpcStream('r2', () => undefined);
    for (let i = 0; i < 5000; i++) s.pushData(chunk(i));
    expect(s.queued).toBe(RpcStream.MAX_QUEUE);
  });

  it('still delivers everything to an async iterator', async () => {
    const s = new RpcStream('r3', () => undefined);
    const got: unknown[] = [];
    const reader = (async () => {
      for await (const c of s) got.push(c);
    })();
    for (let i = 0; i < 100; i++) s.pushData(chunk(i));
    s.finish({ code: 0 });
    await reader;
    expect(got).toHaveLength(100);
  });
});

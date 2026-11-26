import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CHUNK_CHARS, streamDataSchema, type StreamData, type StreamEnd } from '@hz/shared';
import {
  DockerDemuxer,
  LineBuffer,
  LogChunker,
  MAX_LINE_CHARS,
  createLogPipeline,
  pipeLogStream,
} from '../src/actions/logs.js';
import { StreamManager, splitChunks } from '../src/streams.js';

function frame(type: number, text: string | Buffer): Buffer {
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('docker log demultiplexer', () => {
  it('splits stdout and stderr frames', () => {
    const out: [string, string][] = [];
    const d = new DockerDemuxer((ch, p) => out.push([ch, p.toString('utf8')]));
    d.push(Buffer.concat([frame(1, 'out 1\n'), frame(2, 'err 1\n'), frame(1, 'out 2\n')]));
    expect(out).toEqual([
      ['stdout', 'out 1\n'],
      ['stderr', 'err 1\n'],
      ['stdout', 'out 2\n'],
    ]);
  });

  it('handles headers and payloads split across chunks (byte by byte)', () => {
    const out: [string, string][] = [];
    const d = new DockerDemuxer((ch, p) => out.push([ch, p.toString('utf8')]));
    const all = Buffer.concat([frame(2, 'hello'), frame(1, ' world')]);
    for (const b of all) d.push(Buffer.from([b]));
    expect(out.map(([c]) => c)).toEqual(['stderr', 'stdout']);
    expect(out.map(([, t]) => t).join('')).toBe('hello world');
    expect(d.pendingBytes).toBe(0);
  });

  it('waits for a complete frame', () => {
    const out: string[] = [];
    const d = new DockerDemuxer((_, p) => out.push(p.toString()));
    const f = frame(1, 'abcdef');
    d.push(f.subarray(0, 10));
    expect(out).toEqual([]);
    expect(d.pendingBytes).toBe(10);
    d.push(f.subarray(10));
    expect(out).toEqual(['abcdef']);
  });

  it('falls back to raw output when the data is not multiplexed', () => {
    const out: [string, string][] = [];
    const d = new DockerDemuxer((ch, p) => out.push([ch, p.toString()]));
    d.push(Buffer.from('plain tty output\n'));
    d.push(Buffer.from('more\n'));
    expect(out).toEqual([
      ['stdout', 'plain tty output\n'],
      ['stdout', 'more\n'],
    ]);
  });
});

describe('line buffer', () => {
  it('splits lines, strips \\r and keeps a partial line', () => {
    const lines: string[] = [];
    const b = new LineBuffer((l) => lines.push(l));
    b.push(Buffer.from('a\r\nb\nc'));
    expect(lines).toEqual(['a', 'b']);
    b.push(Buffer.from('d\n'));
    expect(lines).toEqual(['a', 'b', 'cd']);
    b.push(Buffer.from('tail'));
    b.flush();
    expect(lines).toEqual(['a', 'b', 'cd', 'tail']);
  });

  it('decodes UTF-8 split across frames', () => {
    const lines: string[] = [];
    const b = new LineBuffer((l) => lines.push(l));
    const bytes = Buffer.from('Grüße €\n', 'utf8');
    for (const byte of bytes) b.push(Buffer.from([byte]));
    expect(lines).toEqual(['Grüße €']);
  });

  it('splits overlong lines', () => {
    const lines: string[] = [];
    const b = new LineBuffer((l) => lines.push(l));
    b.push(Buffer.from(`${'x'.repeat(MAX_LINE_CHARS * 2 + 5)}\n`));
    expect(lines.map((l) => l.length)).toEqual([MAX_LINE_CHARS, MAX_LINE_CHARS, 5]);
    // also without a newline (the partial buffer never grows unbounded)
    b.push(Buffer.from('y'.repeat(MAX_LINE_CHARS + 1)));
    expect(lines.at(-1)).toHaveLength(MAX_LINE_CHARS);
  });
});

describe('chunker', () => {
  it('keeps chunks below MAX_CHUNK_CHARS and made of whole lines', () => {
    const chunks: [string, string][] = [];
    const c = new LogChunker((ch, s) => chunks.push([ch, s]), MAX_CHUNK_CHARS, -1);
    const line = 'z'.repeat(1000);
    for (let i = 0; i < 200; i += 1) c.add('stdout', line);
    c.flush();
    expect(chunks.length).toBeGreaterThan(1);
    for (const [, s] of chunks) {
      expect(s.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      expect(s.endsWith('\n')).toBe(true);
    }
    expect(
      chunks
        .map(([, s]) => s)
        .join('')
        .split('\n').length - 1,
    ).toBe(200);
  });

  it('flushes on a channel switch so the order stays', () => {
    const chunks: [string, string][] = [];
    const c = new LogChunker((ch, s) => chunks.push([ch, s]), MAX_CHUNK_CHARS, -1);
    c.add('stdout', 'a');
    c.add('stdout', 'b');
    c.add('stderr', 'c');
    c.add('stdout', 'd');
    c.flush();
    expect(chunks).toEqual([
      ['stdout', 'a\nb\n'],
      ['stderr', 'c\n'],
      ['stdout', 'd\n'],
    ]);
  });

  it('flushes after the batching delay', () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const c = new LogChunker((_, s) => chunks.push(s), MAX_CHUNK_CHARS, 50);
    c.add('stdout', 'one');
    expect(chunks).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(chunks).toEqual(['one\n']);
  });

  it('splitChunks never exceeds the limit and keeps surrogate pairs', () => {
    const text = `${'a'.repeat(9)}😀${'b'.repeat(5)}`;
    const parts = splitChunks(text, 10);
    expect(parts.join('')).toBe(text);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(10);
    expect(parts[0]).toBe('a'.repeat(9));
  });
});

describe('log stream', () => {
  function manager() {
    const sent: (StreamData | StreamEnd)[] = [];
    let buffered = 0;
    const mgr = new StreamManager({
      send: (m) => {
        sent.push(m);
        return true;
      },
      bufferedAmount: () => buffered,
    });
    return { mgr, sent, setBuffered: (n: number) => (buffered = n) };
  }

  it('queues output until the rpc.result went out', () => {
    const { mgr, sent } = manager();
    const sink = mgr.open('stream_0001');
    const p = createLogPipeline(sink, false, -1);
    p.push(frame(1, 'early\n'));
    p.finish();
    sink.end(0);
    expect(sent).toEqual([]);
    mgr.activate('stream_0001');
    expect(sent).toEqual([
      { type: 'stream.data', streamId: 'stream_0001', channel: 'stdout', chunk: 'early\n' },
      { type: 'stream.end', streamId: 'stream_0001', code: 0 },
    ]);
    expect(mgr.size).toBe(0);
  });

  it('streams, separates channels and ends with stream.end', async () => {
    const { mgr, sent } = manager();
    const sink = mgr.open('stream_0002');
    mgr.activate('stream_0002');
    const src = new PassThrough();
    pipeLogStream(src, sink, false, { flushMs: -1 });
    src.write(frame(1, 'line one\nline '));
    src.write(frame(2, 'oops\n'));
    src.write(frame(1, 'two\n'));
    src.end();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const data = sent.filter((m): m is StreamData => m.type === 'stream.data');
    for (const m of data) expect(streamDataSchema.safeParse(m).success).toBe(true);
    const text = data.map((m) => `${m.channel}:${m.chunk}`).join('');
    expect(text).toContain('stderr:oops\n');
    expect(
      data
        .filter((m) => m.channel === 'stdout')
        .map((m) => m.chunk)
        .join(''),
    ).toBe('line one\nline two\n');
    expect(sent.at(-1)).toEqual({ type: 'stream.end', streamId: 'stream_0002', code: 0 });
  });

  it('stops the docker stream on stream.cancel and sends nothing more', async () => {
    const { mgr, sent } = manager();
    const sink = mgr.open('stream_0003');
    mgr.activate('stream_0003');
    const src = new PassThrough();
    const destroy = vi.spyOn(src, 'destroy');
    pipeLogStream(src, sink, true, { flushMs: -1 });
    mgr.cancel('stream_0003');
    expect(destroy).toHaveBeenCalled();
    src.write('after cancel\n');
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([]);
    expect(mgr.size).toBe(0);
  });

  it('cancels every stream when the connection is lost', () => {
    const { mgr } = manager();
    const stop = vi.fn();
    mgr.open('stream_a0001').onCancel(stop);
    mgr.open('stream_a0002').onCancel(stop);
    mgr.cancelAll();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(mgr.size).toBe(0);
  });

  it('pauses docker while the socket is congested', () => {
    vi.useFakeTimers();
    const { mgr, setBuffered } = manager();
    const sink = mgr.open('stream_0004');
    mgr.activate('stream_0004');
    const src = new PassThrough();
    const pause = vi.spyOn(src, 'pause');
    const resume = vi.spyOn(src, 'resume');
    pipeLogStream(src, sink, true, { flushMs: -1, congestionPollMs: 100 });
    setBuffered(10 * 1024 * 1024);
    src.emit('data', Buffer.from('x\n'));
    expect(pause).toHaveBeenCalled();
    setBuffered(0);
    vi.advanceTimersByTime(100);
    expect(resume).toHaveBeenCalled();
  });

  it('limits parallel streams', () => {
    const mgr = new StreamManager({ send: () => true, bufferedAmount: () => 0 }, 2);
    mgr.open('stream_b0001');
    mgr.open('stream_b0002');
    expect(() => mgr.open('stream_b0003')).toThrow(/too many/);
    expect(() => mgr.open('stream_b0001')).toThrow();
  });
});

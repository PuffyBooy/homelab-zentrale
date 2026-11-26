import { StringDecoder } from 'node:string_decoder';
import { MAX_CHUNK_CHARS, type RpcParams } from '@hz/shared';
import type { StreamSink } from '../streams.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * container.logs as a stream (rpc id = stream id).
 *
 * Docker sends logs of non-TTY containers multiplexed: frames with an 8 byte
 * header [stream, 0, 0, 0, size (uint32 BE)] followed by `size` bytes. TTY
 * containers send raw bytes. We split stdout/stderr, decode UTF-8 safely across
 * frame borders, cut into lines (max 16 KiB per line, like LogLine.text) and send
 * chunks of whole lines ("line\n" ...), at most MAX_CHUNK_CHARS each.
 */

export type LogChannel = 'stdout' | 'stderr';
/** Max length of one log line; longer lines are split. */
export const MAX_LINE_CHARS = 16 * 1024;
/** Lines are batched for at most this long. */
export const FLUSH_MS = 50;

/** Splits the Docker multiplexed log stream into frames. */
export class DockerDemuxer {
  private buf: Buffer = Buffer.alloc(0);
  /** Set when the data turned out not to be multiplexed: pass through as stdout. */
  private raw = false;

  constructor(private readonly onFrame: (channel: LogChannel, payload: Buffer) => void) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.raw) {
      this.onFrame('stdout', chunk);
      return;
    }
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const type = this.buf[0] ?? 0;
      if (type > 3 || this.buf[1] !== 0 || this.buf[2] !== 0 || this.buf[3] !== 0) {
        // Not a frame header: treat everything from here on as raw output.
        this.raw = true;
        const rest = this.buf;
        this.buf = Buffer.alloc(0);
        this.onFrame('stdout', rest);
        return;
      }
      const size = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + size) break;
      const payload = this.buf.subarray(8, 8 + size);
      this.buf = this.buf.subarray(8 + size);
      if (payload.length > 0) this.onFrame(type === 2 ? 'stderr' : 'stdout', payload);
    }
  }

  /** Bytes of an incomplete frame at the end. */
  get pendingBytes(): number {
    return this.buf.length;
  }
}

/** Cuts a byte stream into lines (UTF-8 safe, \r\n and \n, long lines split). */
export class LineBuffer {
  private readonly decoder = new StringDecoder('utf8');
  private partial = '';

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLine = MAX_LINE_CHARS,
  ) {}

  push(bytes: Buffer): void {
    this.consume(this.partial + this.decoder.write(bytes));
  }

  private consume(text: string): void {
    const parts = text.split('\n');
    this.partial = parts.pop() ?? '';
    for (const p of parts) this.emit(p.endsWith('\r') ? p.slice(0, -1) : p);
    while (this.partial.length > this.maxLine) {
      this.onLine(this.partial.slice(0, this.maxLine));
      this.partial = this.partial.slice(this.maxLine);
    }
  }

  private emit(line: string): void {
    if (line.length <= this.maxLine) {
      this.onLine(line);
      return;
    }
    for (let i = 0; i < line.length; i += this.maxLine)
      this.onLine(line.slice(i, i + this.maxLine));
  }

  /** End of stream: emits the unterminated last line. */
  flush(): void {
    const rest = this.partial + this.decoder.end();
    this.partial = '';
    if (rest.length > 0) this.emit(rest.endsWith('\r') ? rest.slice(0, -1) : rest);
  }
}

/**
 * Batches lines into chunks of whole lines per channel. A channel switch flushes,
 * so the order of stdout and stderr lines is kept.
 */
export class LogChunker {
  private channel: LogChannel = 'stdout';
  private parts: string[] = [];
  private size = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly send: (channel: LogChannel, chunk: string) => void,
    private readonly maxChars = MAX_CHUNK_CHARS,
    private readonly flushMs = FLUSH_MS,
  ) {}

  add(channel: LogChannel, line: string): void {
    const piece = `${line}\n`;
    if (this.size > 0 && (channel !== this.channel || this.size + piece.length > this.maxChars)) {
      this.flush();
    }
    this.channel = channel;
    this.parts.push(piece);
    this.size += piece.length;
    if (this.size >= this.maxChars) this.flush();
    else if (!this.timer && this.flushMs >= 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.flushMs);
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.size === 0) return;
    const chunk = this.parts.join('');
    this.parts = [];
    this.size = 0;
    this.send(this.channel, chunk);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.parts = [];
    this.size = 0;
  }
}

/** Wires demuxer -> line buffers -> chunker -> sink. */
export function createLogPipeline(
  sink: Pick<StreamSink, 'data'>,
  tty: boolean,
  flushMs = FLUSH_MS,
) {
  const chunker = new LogChunker((ch, chunk) => sink.data(ch, chunk), MAX_CHUNK_CHARS, flushMs);
  const lines: Record<LogChannel, LineBuffer> = {
    stdout: new LineBuffer((l) => chunker.add('stdout', l)),
    stderr: new LineBuffer((l) => chunker.add('stderr', l)),
  };
  const demux = new DockerDemuxer((ch, payload) => lines[ch].push(payload));
  return {
    push(chunk: Buffer) {
      if (tty) lines.stdout.push(chunk);
      else demux.push(chunk);
    },
    finish() {
      lines.stdout.flush();
      lines.stderr.flush();
      chunker.flush();
    },
    dispose() {
      chunker.dispose();
    },
  };
}

interface LogStream {
  on(event: 'data', fn: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'close', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  destroy?: () => void;
}

/** Feeds a (follow) Docker log stream into the sink until end, error or cancel. */
export function pipeLogStream(
  stream: LogStream,
  sink: StreamSink,
  tty: boolean,
  opts: { flushMs?: number; congestionPollMs?: number } = {},
): void {
  const pipeline = createLogPipeline(sink, tty, opts.flushMs ?? FLUSH_MS);
  let finished = false;
  let poll: NodeJS.Timeout | null = null;
  const stopPoll = () => {
    if (poll) clearInterval(poll);
    poll = null;
  };
  const done = (code: number, error?: string) => {
    if (finished) return;
    finished = true;
    stopPoll();
    if (sink.closed) {
      pipeline.dispose();
      return;
    }
    pipeline.finish();
    sink.end(code, error);
  };
  sink.onCancel(() => {
    finished = true;
    stopPoll();
    pipeline.dispose();
    stream.destroy?.();
  });
  stream.on('data', (chunk: Buffer) => {
    if (finished) return;
    pipeline.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (!poll && sink.congested()) {
      // Backpressure: the WebSocket is not keeping up, pause Docker.
      stream.pause();
      poll = setInterval(() => {
        if (finished || !sink.congested()) {
          stopPoll();
          if (!finished) stream.resume();
        }
      }, opts.congestionPollMs ?? 200);
    }
  });
  stream.on('end', () => done(0));
  stream.on('close', () => done(0));
  stream.on('error', () => done(1, 'log stream failed'));
}

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode;
}

export async function containerLogs(
  params: RpcParams<'container.logs'>,
  ctx: ActionContext,
  rpcId: string,
): Promise<{ streamId: string; follow: boolean }> {
  const docker = ctx.host.docker;
  if (!docker) throw new ActionError('failed', 'docker not available');
  const c = docker.getContainer(params.id);
  let tty: boolean;
  try {
    const info = await c.inspect();
    tty = info.Config?.Tty === true;
  } catch (err) {
    if (statusOf(err) === 404) throw new ActionError('not_found', 'container not found');
    throw new ActionError('failed', 'container inspect failed');
  }
  const sink = ctx.streams.open(rpcId);
  const base = { stdout: true, stderr: true, tail: params.tail, timestamps: false };
  try {
    if (params.follow) {
      const stream = await c.logs({ ...base, follow: true });
      pipeLogStream(stream as unknown as LogStream, sink, tty);
    } else {
      const buf = await c.logs({ ...base, follow: false });
      const pipeline = createLogPipeline(sink, tty, -1);
      pipeline.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)));
      pipeline.finish();
      sink.end(0);
    }
  } catch (err) {
    if (statusOf(err) === 404) throw new ActionError('not_found', 'container not found');
    throw new ActionError('failed', 'reading logs failed');
  }
  return { streamId: rpcId, follow: params.follow };
}

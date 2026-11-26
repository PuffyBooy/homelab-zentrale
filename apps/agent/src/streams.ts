import {
  MAX_CHUNK_CHARS,
  type StreamData,
  type StreamEnd,
  type TransferAck,
  type TransferBegin,
  type TransferChunk,
  type TransferEnd,
} from '@hz/shared';
import { ActionError } from './actions/types.js';

/**
 * Output of streaming actions (container.logs, later game.backup, deploy.run, pty).
 *
 * Ordering: the core expects `rpc.result` first, then `stream.data` ..., `stream.end`.
 * A sink therefore queues everything until the connection has sent the rpc.result
 * and calls `activate()`. If the action fails, the dispatcher calls `discard()`.
 *
 * `stream.cancel` from the core and a lost connection run the cancel handlers
 * (e.g. destroy the Docker log stream); no stream.end is sent after a cancel.
 */

export type StreamChannel = StreamData['channel'];

/** Binary transfer frames the agent sends (game.export: begin/chunk/end, game.import: ack). */
export type TransferOut = TransferBegin | TransferChunk | TransferAck | TransferEnd;
/** Binary transfer frames the core sends to a stream (game.import: chunk/end, game.export: ack). */
export type TransferIn = TransferChunk | TransferAck | TransferEnd;
type OutMsg = StreamData | StreamEnd | TransferOut;

export interface StreamSink {
  readonly id: string;
  /** True after cancel, discard or end. Producers should stop. */
  readonly closed: boolean;
  /** Sends text; longer text is split into chunks of at most MAX_CHUNK_CHARS. */
  data(channel: StreamChannel, text: string): void;
  /** Ends the stream (stream.end). Idempotent. */
  end(code: number, error?: string): void;
  /** Called once when the core cancels the stream or the connection is lost. */
  onCancel(fn: () => void): void;
  /** True while the WebSocket send buffer is full; producers should pause. */
  congested(): boolean;
  /** Sends a transfer frame (queued like stream.data until the rpc.result went out). */
  transfer(msg: TransferOut): void;
  /** Receives the transfer frames the core sends for this stream (one handler). */
  onTransfer(fn: (msg: TransferIn) => void): void;
}

export interface StreamOutput {
  send(msg: StreamData | StreamEnd): boolean;
  /** Sends a transfer frame; without it transfer frames are dropped. */
  sendTransfer?(msg: TransferOut): boolean;
  /** Bytes queued in the WebSocket. */
  bufferedAmount(): number;
}

/** Max parallel streams per agent. */
export const MAX_STREAMS = 16;
/** Above this many queued bytes in the socket a sink reports congestion. */
export const CONGESTION_BYTES = 4 * 1024 * 1024;

/** Splits text into pieces of at most `max` chars without breaking surrogate pairs. */
export function splitChunks(text: string, max = MAX_CHUNK_CHARS): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff && end - 1 > i) end -= 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

class Sink implements StreamSink {
  closed = false;
  active = false;
  queue: OutMsg[] = [];
  cancelFns: (() => void)[] = [];
  transferFn: ((msg: TransferIn) => void) | null = null;

  constructor(
    readonly id: string,
    private readonly mgr: StreamManager,
  ) {}

  private emit(msg: OutMsg): void {
    if (this.active) this.mgr.write(msg);
    else this.queue.push(msg);
  }

  data(channel: StreamChannel, text: string): void {
    if (this.closed || text.length === 0) return;
    for (const chunk of splitChunks(text)) {
      this.emit({ type: 'stream.data', streamId: this.id, channel, chunk });
    }
  }

  end(code: number, error?: string): void {
    if (this.closed) return;
    this.closed = true;
    const msg: StreamEnd = { type: 'stream.end', streamId: this.id, code: Math.trunc(code) };
    if (error !== undefined) msg.error = error.slice(0, 500);
    this.emit(msg);
    if (this.active) this.mgr.forget(this.id);
  }

  onCancel(fn: () => void): void {
    if (this.closed) return;
    this.cancelFns.push(fn);
  }

  congested(): boolean {
    return this.mgr.out.bufferedAmount() > CONGESTION_BYTES;
  }

  transfer(msg: TransferOut): void {
    if (this.closed || msg.streamId !== this.id) return;
    this.emit(msg);
  }

  onTransfer(fn: (msg: TransferIn) => void): void {
    if (this.closed) return;
    this.transferFn = fn;
  }

  runCancel(): void {
    this.closed = true;
    this.queue = [];
    this.transferFn = null;
    const fns = this.cancelFns;
    this.cancelFns = [];
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // a producer that fails to stop must not break the others
      }
    }
  }
}

export class StreamManager {
  private readonly sinks = new Map<string, Sink>();

  constructor(
    readonly out: StreamOutput,
    private readonly max = MAX_STREAMS,
  ) {}

  get size(): number {
    return this.sinks.size;
  }

  has(id: string): boolean {
    return this.sinks.has(id);
  }

  /** Opens a sink for the rpc id. Throws `busy` when too many streams are open. */
  open(id: string): StreamSink {
    if (this.sinks.has(id)) throw new ActionError('invalid_params', 'stream id in use');
    if (this.sinks.size >= this.max) throw new ActionError('busy', 'too many open streams');
    const sink = new Sink(id, this);
    this.sinks.set(id, sink);
    return sink;
  }

  /** After rpc.result {ok:true} was sent: flush the queue and go live. */
  activate(id: string): void {
    const sink = this.sinks.get(id);
    if (!sink || sink.active) return;
    sink.active = true;
    const queued = sink.queue;
    sink.queue = [];
    for (const msg of queued) this.write(msg);
    if (sink.closed) this.forget(id);
  }

  /** @internal */
  write(msg: OutMsg): void {
    if (msg.type === 'stream.data' || msg.type === 'stream.end') this.out.send(msg);
    else this.out.sendTransfer?.(msg);
  }

  /**
   * A transfer frame from the core: hands it to the stream's handler. Returns false
   * when no open (and live) stream with that id takes transfer frames.
   */
  deliver(msg: TransferIn): boolean {
    const sink = this.sinks.get(msg.streamId);
    if (!sink || !sink.active || sink.closed || !sink.transferFn) return false;
    sink.transferFn(msg);
    return true;
  }

  /** The action failed or its result could not be sent: stop silently. */
  discard(id: string): void {
    const sink = this.sinks.get(id);
    if (!sink) return;
    this.sinks.delete(id);
    sink.runCancel();
  }

  /** stream.cancel from the core. */
  cancel(id: string): void {
    this.discard(id);
  }

  /** Connection lost: the core forgot every stream. */
  cancelAll(): void {
    for (const id of [...this.sinks.keys()]) this.discard(id);
  }

  /** @internal */
  forget(id: string): void {
    this.sinks.delete(id);
  }
}

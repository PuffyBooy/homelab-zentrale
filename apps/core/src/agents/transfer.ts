import { createHash, type Hash } from 'node:crypto';
import {
  MIGRATION_MAX_BYTES,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_IDLE_TIMEOUT_MS,
  TRANSFER_WINDOW,
  type TransferBegin,
  type TransferChunk,
} from '@hz/shared';
import type { OutgoingTransferFrame, TransferFrame } from './hub.js';

/** Why the core aborts a relayed transfer. */
export type RelayFailure = 'too_large' | 'checksum_mismatch' | 'sequence' | 'timeout';

export interface RelayOptions {
  /** Largest archive accepted (core side, besides the agent's own maxBytes). */
  maxBytes?: number;
  window?: number;
  idleMs?: number;
  /** Bytes the target acknowledged so far (in order). */
  onProgress?: (bytesDone: number) => void;
  onFail: (reason: RelayFailure) => void;
}

export interface RelayResult {
  bytes: number;
  chunks: number;
  sha256: string;
}

/**
 * Pipes one archive from the source agent (game.export) to the target agent
 * (game.import) through the core, with flow control:
 *
 * - The core forwards chunk `seq` of the source unchanged to the target and
 *   acknowledges it to the source only after the target acknowledged it. The
 *   source may therefore never have more than `window` chunks beyond the
 *   target's last ack; a source that sends more is aborted (`sequence`). So the
 *   core holds at most `window` chunks (before the target is attached, in its
 *   queue; afterwards, in the target's socket buffer). Nothing grows unbounded.
 * - Every chunk is checked: in order, exactly TRANSFER_CHUNK_BYTES except the
 *   last, never more than the announced bytes or `maxBytes` (`too_large`).
 * - The core recomputes sha256 itself and compares bytes, chunks and sha256 of
 *   transfer.begin, transfer.end and what it received (`checksum_mismatch`).
 *   Only then transfer.end goes to the target, with the core's own values.
 * - No frame from either side for `idleMs` after transfer.begin: `timeout`.
 *
 * The relay never touches files and never sees paths; it only moves bytes
 * between two stream ids that the core opened itself.
 */
export class TransferRelay {
  private readonly maxBytes: number;
  private readonly window: number;
  private readonly idleMs: number;
  private begin: TransferBegin | null = null;
  private hash: Hash = createHash('sha256');
  private nextSeq = 0;
  private received = 0;
  /** Highest seq the target acknowledged (in order). */
  private targetAcked = -1;
  /** Highest seq sent to the target. */
  private forwarded = -1;
  /** Bytes of chunks up to `targetAcked`. */
  private ackedBytes = 0;
  private readonly sizes: number[] = [];
  /** Chunks received before the target is attached (at most `window`). */
  private readonly queue: TransferChunk[] = [];
  private target: ((f: OutgoingTransferFrame) => boolean) | null = null;
  private targetStreamId = '';
  private source: ((f: OutgoingTransferFrame) => boolean) | null = null;
  private sourceStreamId = '';
  private endPending: RelayResult | null = null;
  private endSent = false;
  private timer: NodeJS.Timeout | null = null;
  private failed: RelayFailure | null = null;
  private finished = false;
  private acked = false;
  /** Largest number of chunks the core held or had in flight to the target at once. */
  maxInFlight = 0;

  private resolveBegin!: (b: TransferBegin) => void;
  private resolveSourceDone!: (r: RelayResult) => void;
  private resolveAllAcked!: () => void;
  /** transfer.begin of the source. */
  readonly begun: Promise<TransferBegin>;
  /** transfer.end of the source was verified (checksum ok). */
  readonly sourceDone: Promise<RelayResult>;
  /** The target acknowledged the last chunk. */
  readonly allAcked: Promise<void>;

  constructor(private readonly opts: RelayOptions) {
    this.maxBytes = Math.min(opts.maxBytes ?? MIGRATION_MAX_BYTES, MIGRATION_MAX_BYTES);
    this.window = opts.window ?? TRANSFER_WINDOW;
    this.idleMs = opts.idleMs ?? TRANSFER_IDLE_TIMEOUT_MS;
    this.begun = new Promise((r) => (this.resolveBegin = r));
    this.sourceDone = new Promise((r) => (this.resolveSourceDone = r));
    this.allAcked = new Promise((r) => (this.resolveAllAcked = r));
  }

  get failure(): RelayFailure | null {
    return this.failed;
  }

  /** transfer.end of the source arrived and matched (bytes, chunks, sha256). */
  get sourceComplete(): boolean {
    return this.endPending !== null;
  }

  /** Bytes the target acknowledged. */
  get bytesDone(): number {
    return this.ackedBytes;
  }

  /** Where acks for the source go (stream id of game.export). */
  attachSource(streamId: string, send: (f: OutgoingTransferFrame) => boolean): void {
    this.sourceStreamId = streamId;
    this.source = send;
  }

  /** The target accepted game.import: forward what is queued, then pipe. */
  attachTarget(streamId: string, send: (f: OutgoingTransferFrame) => boolean): void {
    if (this.failed || this.target) return;
    this.targetStreamId = streamId;
    this.target = send;
    for (const c of this.queue.splice(0)) this.forward(c);
    this.flushEnd();
  }

  /** Frames from the source agent (game.export stream). */
  fromSource(f: TransferFrame): void {
    if (this.failed || this.finished) return;
    switch (f.type) {
      case 'transfer.begin':
        if (this.begin) return this.fail('sequence');
        if (f.bytes > this.maxBytes) return this.fail('too_large');
        if (f.chunks !== Math.ceil(f.bytes / TRANSFER_CHUNK_BYTES)) return this.fail('sequence');
        this.begin = f;
        this.touch();
        this.resolveBegin(f);
        return;
      case 'transfer.chunk':
        return this.onChunk(f);
      case 'transfer.end':
        return this.onSourceEnd(f.chunks, f.bytes, f.sha256);
      case 'transfer.ack':
        // The source sends, it never acknowledges.
        return this.fail('sequence');
    }
  }

  /** Frames from the target agent (game.import stream): only acks. */
  fromTarget(f: TransferFrame): void {
    if (this.failed || this.finished) return;
    if (f.type !== 'transfer.ack') return this.fail('sequence');
    if (f.seq > this.forwarded) return this.fail('sequence');
    this.touch();
    if (f.seq <= this.targetAcked) return;
    for (let s = this.targetAcked + 1; s <= f.seq; s += 1) this.ackedBytes += this.sizes[s] ?? 0;
    this.targetAcked = f.seq;
    this.source?.({ type: 'transfer.ack', streamId: this.sourceStreamId, seq: f.seq });
    this.opts.onProgress?.(this.ackedBytes);
    if (this.begin && this.targetAcked === this.begin.chunks - 1) {
      this.acked = true;
      this.resolveAllAcked();
      // Both sides are done; extraction is covered by the import stream's timeout.
      if (this.endPending) this.stopTimer();
    }
  }

  /** Stops the timer; no further frames are accepted. */
  dispose(): void {
    this.stopTimer();
    this.finished = true;
    this.queue.length = 0;
  }

  private onChunk(c: TransferChunk): void {
    const b = this.begin;
    if (!b || this.endPending || c.seq !== this.nextSeq || c.seq >= b.chunks) {
      return this.fail('sequence');
    }
    // Flow control: at most `window` chunks beyond the target's last ack.
    const inFlight = c.seq - this.targetAcked;
    if (inFlight > this.window) return this.fail('sequence');
    const buf = Buffer.from(c.data, 'base64');
    const last = c.seq === b.chunks - 1;
    if (buf.length === 0 || buf.length > TRANSFER_CHUNK_BYTES) return this.fail('sequence');
    if (!last && buf.length !== TRANSFER_CHUNK_BYTES) return this.fail('sequence');
    if (this.received + buf.length > b.bytes || this.received + buf.length > this.maxBytes) {
      return this.fail('too_large');
    }
    this.touch();
    this.hash.update(buf);
    this.received += buf.length;
    this.sizes[c.seq] = buf.length;
    this.nextSeq += 1;
    this.maxInFlight = Math.max(this.maxInFlight, inFlight);
    if (this.target) this.forward(c);
    else this.queue.push(c);
  }

  private forward(c: TransferChunk): void {
    if (!this.target) return;
    // Same base64 string, new stream id: nothing is re-encoded or copied twice.
    const ok = this.target({
      type: 'transfer.chunk',
      streamId: this.targetStreamId,
      seq: c.seq,
      data: c.data,
    });
    if (!ok) return; // The import stream ended; its stream.end reports why.
    this.forwarded = c.seq;
  }

  private onSourceEnd(chunks: number, bytes: number, sha256: string): void {
    const b = this.begin;
    if (!b || this.endPending) return this.fail('sequence');
    if (this.nextSeq !== b.chunks || chunks !== b.chunks) return this.fail('checksum_mismatch');
    const digest = this.hash.digest('hex');
    if (
      bytes !== b.bytes ||
      this.received !== b.bytes ||
      sha256 !== b.sha256 ||
      digest !== sha256
    ) {
      return this.fail('checksum_mismatch');
    }
    if (this.acked) this.stopTimer();
    else this.touch();
    this.endPending = { bytes: this.received, chunks: this.nextSeq, sha256: digest };
    this.resolveSourceDone(this.endPending);
    this.flushEnd();
  }

  private flushEnd(): void {
    if (!this.target || !this.endPending || this.endSent) return;
    this.endSent = this.target({
      type: 'transfer.end',
      streamId: this.targetStreamId,
      ...this.endPending,
    });
  }

  private touch(): void {
    this.stopTimer();
    this.timer = setTimeout(() => this.fail('timeout'), this.idleMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private fail(reason: RelayFailure): void {
    if (this.failed || this.finished) return;
    this.failed = reason;
    this.dispose();
    this.opts.onFail(reason);
  }
}

import { PassThrough } from 'node:stream';
import { TRANSFER_CHUNK_BYTES, TRANSFER_WINDOW, type TransferBegin } from '@hz/shared';
import type { AgentHub, RpcStream } from '../agents/hub.js';
import { TransferRelay, type RelayFailure } from '../agents/transfer.js';

/** game.export builds the archive first; a large world takes a while. */
export const WORLD_BEGIN_TIMEOUT_MS = 15 * 60_000;
const RELAY_STREAM_ID = 'http';

export interface WorldStream {
  /** Archive size announced by the agent (transfer.begin), at most maxBytes. */
  bytes: number;
  /** The archive bytes, in order; destroyed on any transfer error. */
  stream: PassThrough;
}

export class WorldExportError extends Error {
  constructor(readonly reason: RelayFailure | 'offline' | 'export_failed' | 'cancelled') {
    super(reason);
    this.name = 'WorldExportError';
  }
}

/**
 * M12 world download: game.export of one game, piped straight into an HTTP
 * response. Reuses the M11 relay (agents/transfer.ts): order, chunk sizes,
 * maxBytes, sha256 and the idle timeout are checked by the relay; the "target"
 * is the response stream, which acknowledges a chunk once it was written (or
 * after `drain`), so at most TRANSFER_WINDOW chunks are ever buffered here.
 * Resolves after transfer.begin (the size is known, headers can be sent).
 */
export async function openWorldExport(
  hub: Pick<AgentHub, 'stream' | 'sendTransfer'>,
  serverId: string,
  gameFolder: string,
  maxBytes: number,
  /** Template worldPaths: only these sub paths of data/ (never configs with passwords). */
  paths: readonly string[],
  beginTimeoutMs = WORLD_BEGIN_TIMEOUT_MS,
): Promise<WorldStream> {
  if (paths.length === 0) throw new WorldExportError('export_failed');
  const out = new PassThrough({ highWaterMark: TRANSFER_WINDOW * TRANSFER_CHUNK_BYTES });
  // Errors end the response (fastify listens too); never an unhandled 'error' event.
  out.on('error', () => undefined);
  let failed: WorldExportError | null = null;
  let rejectBegin: (e: WorldExportError) => void = () => undefined;
  let exportStream: RpcStream | null = null;
  const fail = (e: WorldExportError): void => {
    if (failed) return;
    failed = e;
    rejectBegin(e);
    relay.dispose();
    exportStream?.cancel();
    if (!out.destroyed) out.destroy(e);
  };
  const relay = new TransferRelay({
    maxBytes,
    onFail: (reason) => fail(new WorldExportError(reason)),
  });
  try {
    exportStream = hub.stream(
      serverId,
      'game.export',
      { gameId: gameFolder, maxBytes, paths: [...paths] },
      { onTransfer: (f) => relay.fromSource(f) },
    );
  } catch {
    throw new WorldExportError('offline');
  }
  const ex = exportStream;
  relay.attachSource(ex.id, (f) => hub.sendTransfer(serverId, f));
  relay.attachTarget(RELAY_STREAM_ID, (f) => {
    if (failed || out.destroyed) return false;
    if (f.type === 'transfer.end') {
      out.end();
      return true;
    }
    if (f.type !== 'transfer.chunk') return true;
    const seq = f.seq;
    // After the relay recorded the chunk as forwarded (it does so when we return).
    const ack = (): void =>
      relay.fromTarget({ type: 'transfer.ack', streamId: RELAY_STREAM_ID, seq });
    if (out.write(Buffer.from(f.data, 'base64'))) setImmediate(ack);
    else out.once('drain', ack);
    return true;
  });
  void ex.done.then((info) => {
    if (info.code !== 0) fail(new WorldExportError('export_failed'));
    else if (!relay.sourceComplete) fail(new WorldExportError('export_failed'));
  });
  // The friend went away: stop the export, the agent deletes its temp file.
  out.on('close', () => {
    if (!out.writableFinished) fail(new WorldExportError('cancelled'));
  });

  let timer: NodeJS.Timeout | null = null;
  try {
    const begin = await Promise.race<TransferBegin>([
      relay.begun,
      new Promise<never>((_resolve, reject) => {
        rejectBegin = reject;
        if (failed) reject(failed);
        timer = setTimeout(() => reject(new WorldExportError('timeout')), beginTimeoutMs);
        timer.unref();
      }),
    ]);
    return { bytes: begin.bytes, stream: out };
  } catch (err) {
    const e = err instanceof WorldExportError ? err : new WorldExportError('export_failed');
    fail(e);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

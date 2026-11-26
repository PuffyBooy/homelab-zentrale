import type { FastifyBaseLogger } from 'fastify';
import type { LogLine } from '@hz/shared';
import { RpcError, type AgentHub, type RpcStream, type StreamChunk } from '../agents/hub.js';
import type { Clock } from '../clock.js';
import type { ContainerService } from './service.js';

/** Lines the agent sends first (`docker logs --tail`). */
export const LOG_TAIL = 500;
/** Lines the core keeps per topic (ring buffer). */
export const LOG_BUFFER_LINES = 2000;
/** Longer lines are cut (with a marker). */
export const LOG_LINE_MAX_CHARS = 4000;
/** A snapshot carries at most this many characters (the newest lines). */
export const LOG_SNAPSHOT_MAX_CHARS = 1_000_000;
/** An unterminated partial line is emitted once it gets this long. */
const PARTIAL_MAX_CHARS = LOG_LINE_MAX_CHARS;
/** Do not restart a stream more often than this. */
export const LOG_RESTART_MIN_MS = 5_000;

const TOPIC_RE = /^container-logs:([A-Za-z0-9_-]{1,64})$/;
const TRUNCATED = ' …[gekürzt]';

export const containerLogsTopic = (id: string): string => `container-logs:${id}`;

export interface LogSnapshot {
  lines: LogLine[];
  ended: boolean;
}

/** What the logs need from the live hub. */
export interface LogPublisher {
  /** New lines for subscribers of `topic` (throttled). */
  append(topic: string, items: LogLine[]): void;
  /** Sends a fresh snapshot to every subscriber (stream ended or restarted). */
  resnapshot(topic: string): void;
}

interface Topic {
  containerId: string;
  /** Docker id the current stream follows. */
  dockerId: string | null;
  lines: LogLine[];
  nextSeq: number;
  stream: RpcStream | null;
  ended: boolean;
  partial: Record<'stdout' | 'stderr', string>;
  startedAt: number;
}

function cut(text: string): string {
  return text.length > LOG_LINE_MAX_CHARS
    ? text.slice(0, LOG_LINE_MAX_CHARS - TRUNCATED.length) + TRUNCATED
    : text;
}

/**
 * Live topic `container-logs:<id>`: the first subscriber starts a
 * `container.logs` stream (tail 500, follow) on the agent; lines are kept in a
 * ring buffer of 2000 and pushed as updates with a sequence number. When the
 * last subscriber leaves, the stream is cancelled and the buffer dropped.
 * If the stream ends while someone watches and the container runs again (start
 * after stop, recreate after an update, agent reconnect), a new stream follows
 * the new container from now on.
 */
export class ContainerLogs {
  private readonly topics = new Map<string, Topic>();
  /** Topics with live subscribers (open/close from the live hub). */
  private readonly liveOpen = new Set<string>();
  /** Topics kept running for the share console: until (core clock). */
  private readonly leases = new Map<string, number>();
  private publisher: LogPublisher | null = null;
  private fallback: ((containerId: string) => string[] | null) | null = null;

  constructor(
    private readonly deps: {
      hub: Pick<AgentHub, 'stream' | 'isConnected'>;
      containers: ContainerService;
      now: Clock;
      log: FastifyBaseLogger;
    },
  ) {
    deps.containers.onChange((id, deleted) => this.onContainerChange(id, deleted));
  }

  setPublisher(p: LogPublisher): void {
    this.publisher = p;
  }

  /** HZ_DEMO=1 only: static lines for containers without an agent. */
  setDemoSource(fn: (containerId: string) => string[] | null): void {
    this.fallback = fn;
  }

  /** Whether `topic` is a log topic of an existing container. */
  has(topic: string): boolean {
    const id = TOPIC_RE.exec(topic)?.[1];
    return id !== undefined && this.deps.containers.row(id) !== undefined;
  }

  matches(topic: string): boolean {
    return TOPIC_RE.test(topic);
  }

  get activeTopics(): string[] {
    return [...this.topics.keys()];
  }

  /** First subscriber: start the stream. */
  open(topic: string): void {
    this.liveOpen.add(topic);
    this.ensure(topic);
  }

  /**
   * Keeps the stream of `topic` running for `ms` without a live subscriber
   * (share console polling). Renewed by every call; `expireLeases` ends it.
   */
  lease(topic: string, ms: number): void {
    if (!this.has(topic)) return;
    this.leases.set(topic, this.deps.now() + ms);
    this.ensure(topic);
  }

  /** Ends streams whose lease ran out and that no live subscriber watches. */
  expireLeases(): void {
    const now = this.deps.now();
    for (const [topic, until] of this.leases) {
      if (until > now) continue;
      this.leases.delete(topic);
      if (!this.liveOpen.has(topic)) this.stop(topic);
    }
  }

  private ensure(topic: string): void {
    if (this.topics.has(topic)) return;
    const id = TOPIC_RE.exec(topic)?.[1];
    if (!id) return;
    const t: Topic = {
      containerId: id,
      dockerId: null,
      lines: [],
      nextSeq: 0,
      stream: null,
      ended: true,
      partial: { stdout: '', stderr: '' },
      startedAt: 0,
    };
    this.topics.set(topic, t);
    this.start(topic, t, LOG_TAIL);
  }

  /** Last subscriber left: cancel the stream and forget the lines (unless leased). */
  close(topic: string): void {
    this.liveOpen.delete(topic);
    if (this.leases.has(topic)) return;
    this.stop(topic);
  }

  private stop(topic: string): void {
    const t = this.topics.get(topic);
    if (!t) return;
    this.topics.delete(topic);
    const s = t.stream;
    t.stream = null;
    if (s && !s.isEnded) s.cancel();
  }

  closeAll(): void {
    this.leases.clear();
    this.liveOpen.clear();
    for (const topic of [...this.topics.keys()]) this.stop(topic);
  }

  snapshot(topic: string): LogSnapshot | undefined {
    if (!this.has(topic)) return undefined;
    const t = this.topics.get(topic);
    if (!t) return { lines: [], ended: true };
    const lines: LogLine[] = [];
    let chars = 0;
    for (let i = t.lines.length - 1; i >= 0; i--) {
      const line = t.lines[i];
      if (!line) continue;
      chars += line.text.length;
      if (chars > LOG_SNAPSHOT_MAX_CHARS) break;
      lines.push(line);
    }
    return { lines: lines.reverse(), ended: t.ended };
  }

  private start(topic: string, t: Topic, tail: number): void {
    const row = this.deps.containers.row(t.containerId);
    if (!row || !this.deps.hub.isConnected(row.serverId)) {
      t.ended = true;
      const demo = row && t.lines.length === 0 ? this.fallback?.(row.id) : null;
      if (demo)
        this.push(
          topic,
          t,
          demo.map((text) => this.line(t, 'stdout', text)),
        );
      return;
    }
    let stream: RpcStream;
    try {
      stream = this.deps.hub.stream(row.serverId, 'container.logs', {
        id: row.dockerId,
        tail,
        follow: true,
      });
    } catch (err) {
      t.ended = true;
      if (!(err instanceof RpcError)) throw err;
      return;
    }
    t.stream = stream;
    t.dockerId = row.dockerId;
    t.ended = false;
    t.startedAt = this.deps.now();
    t.partial = { stdout: '', stderr: '' };
    stream.on('data', (c: StreamChunk) => {
      if (this.topics.get(topic) === t && t.stream === stream) this.ingest(topic, t, c);
    });
    stream.on('end', () => {
      if (this.topics.get(topic) !== t || t.stream !== stream) return;
      this.flushPartial(topic, t);
      t.stream = null;
      t.ended = true;
      this.publisher?.resnapshot(topic);
    });
  }

  private ingest(topic: string, t: Topic, c: StreamChunk): void {
    const channel = c.channel === 'stderr' ? 'stderr' : 'stdout';
    const text = t.partial[channel] + c.chunk;
    const parts = text.split('\n');
    let rest = parts.pop() ?? '';
    const out: LogLine[] = [];
    for (const p of parts) out.push(this.line(t, channel, p));
    if (rest.length >= PARTIAL_MAX_CHARS) {
      out.push(this.line(t, channel, rest));
      rest = '';
    }
    t.partial[channel] = rest;
    this.push(topic, t, out);
  }

  private flushPartial(topic: string, t: Topic): void {
    const out: LogLine[] = [];
    for (const channel of ['stdout', 'stderr'] as const) {
      if (t.partial[channel] !== '') out.push(this.line(t, channel, t.partial[channel]));
      t.partial[channel] = '';
    }
    this.push(topic, t, out);
  }

  private line(t: Topic, stream: 'stdout' | 'stderr', raw: string): LogLine {
    return { seq: t.nextSeq++, stream, text: cut(raw.endsWith('\r') ? raw.slice(0, -1) : raw) };
  }

  private push(topic: string, t: Topic, out: LogLine[]): void {
    if (out.length === 0) return;
    t.lines.push(...out);
    if (t.lines.length > LOG_BUFFER_LINES) t.lines.splice(0, t.lines.length - LOG_BUFFER_LINES);
    this.publisher?.append(topic, out.slice(-LOG_BUFFER_LINES));
  }

  private onContainerChange(id: string, deleted: boolean): void {
    const topic = containerLogsTopic(id);
    const t = this.topics.get(topic);
    if (!t || deleted) return;
    const row = this.deps.containers.row(id);
    if (!row || row.state !== 'running') return;
    const recreated = t.dockerId !== null && t.dockerId !== row.dockerId;
    if (t.stream && !recreated) return;
    if (this.deps.now() - t.startedAt < LOG_RESTART_MIN_MS) return;
    if (t.stream) {
      // The old container is gone; its stream ends on the agent anyway.
      const old = t.stream;
      t.stream = null;
      old.cancel();
    }
    // Follow from now on; the earlier lines are still in the buffer.
    this.start(topic, t, 0);
    if (t.stream) this.publisher?.resnapshot(topic);
  }
}

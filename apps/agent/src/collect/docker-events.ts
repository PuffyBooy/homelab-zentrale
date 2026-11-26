import { StringDecoder } from 'node:string_decoder';
import type Docker from 'dockerode';
import type { AgentEvent, ContainerHealth } from '@hz/shared';
import { backoffDelay } from '../backoff.js';
import type { Logger } from '../log.js';

/**
 * Subscribes to Docker container events (GET /events) and reconnects with backoff.
 *
 * - start/stop/die/restart/health_status/oom become an `event` for the core.
 * - every container change (also create/destroy/pause/rename ...) invalidates the
 *   inspect cache and requests a new inventory (debounced by the caller).
 * - exec_* events (health checks run one per interval) are ignored.
 */

type ContainerAction = Extract<AgentEvent['event'], { kind: 'container' }>['action'];

/** Actions that are reported to the core as an `event`. */
const REPORTED = new Set<string>(['start', 'stop', 'die', 'restart', 'health_status']);
/** Actions that change what the inventory shows. */
const CHANGES = new Set<string>([
  'start',
  'stop',
  'die',
  'restart',
  'kill',
  'pause',
  'unpause',
  'create',
  'destroy',
  'rename',
  'update',
  'health_status',
  'oom',
]);
const HEALTH = new Set(['healthy', 'unhealthy', 'starting', 'none']);
const ID = /^[0-9a-f]{12,64}$/;

export interface MappedEvent {
  /** Container whose inventory entry changed. */
  dockerId: string;
  /** Event for the core, if this action is reported. */
  event?: AgentEvent['event'];
}

/** Maps one Docker event JSON object. Returns null for events we ignore. */
export function mapDockerEvent(raw: unknown): MappedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as {
    Type?: unknown;
    Action?: unknown;
    Actor?: { ID?: unknown; Attributes?: Record<string, unknown> };
  };
  if (e.Type !== 'container' || typeof e.Action !== 'string') return null;
  const id = e.Actor?.ID;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  // "health_status: healthy" -> base "health_status", arg "healthy"
  const [base = '', arg = ''] = e.Action.split(':').map((s) => s.trim());
  if (!CHANGES.has(base)) return null;
  const attrs = e.Actor?.Attributes ?? {};
  const name = (typeof attrs.name === 'string' ? attrs.name : id.slice(0, 12)).slice(0, 128);
  const out: MappedEvent = { dockerId: id };
  if (base === 'oom') {
    out.event = { kind: 'oom', dockerId: id, name };
  } else if (REPORTED.has(base)) {
    const ev: Extract<AgentEvent['event'], { kind: 'container' }> = {
      kind: 'container',
      dockerId: id,
      name,
      action: base as ContainerAction,
    };
    if (
      base === 'die' &&
      typeof attrs.exitCode === 'string' &&
      /^-?\d{1,6}$/.test(attrs.exitCode)
    ) {
      ev.exitCode = Number(attrs.exitCode);
    }
    if (base === 'health_status' && HEALTH.has(arg)) ev.health = arg as ContainerHealth;
    out.event = ev;
  }
  return out;
}

/** Splits a byte stream of JSON lines (Docker sends one object per line). */
export class JsonLines {
  private readonly decoder = new StringDecoder('utf8');
  private partial = '';

  constructor(
    private readonly onObject: (v: unknown) => void,
    private readonly maxLine = 64 * 1024,
  ) {}

  push(chunk: Buffer | string): void {
    const text = this.partial + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    if (this.partial.length > this.maxLine) this.partial = '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        this.onObject(JSON.parse(t));
      } catch {
        // not JSON: skip
      }
    }
  }
}

export interface EventWatcherOptions {
  log: Logger;
  onEvent: (event: AgentEvent['event']) => void;
  /** A container changed (or null: events were missed, everything may have changed). */
  onChange: (dockerId: string | null) => void;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export class DockerEventWatcher {
  private stream: NodeJS.ReadableStream | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private connectedAt = 0;

  constructor(
    private readonly docker: Pick<Docker, 'getEvents'>,
    private readonly o: EventWatcherOptions,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const s = this.stream;
    this.stream = null;
    (s as unknown as { destroy?: () => void } | null)?.destroy?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.docker.getEvents({ filters: { type: ['container'] } });
    } catch (err) {
      this.o.log.warn('docker events: subscribe failed', { error: err });
      this.retry();
      return;
    }
    if (this.stopped) {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      return;
    }
    this.stream = stream;
    this.connectedAt = Date.now();
    // We may have missed events while disconnected.
    this.o.onChange(null);
    const lines = new JsonLines((obj) => {
      const m = mapDockerEvent(obj);
      if (!m) return;
      if (m.event) this.o.onEvent(m.event);
      this.o.onChange(m.dockerId);
    });
    let done = false;
    const finish = (why: string) => {
      if (done) return;
      done = true;
      if (this.stream === stream) this.stream = null;
      if (this.stopped) return;
      this.o.log.warn('docker events: stream ended, reconnecting', { reason: why });
      if (Date.now() - this.connectedAt > 30_000) this.attempt = 0;
      this.retry();
    };
    stream.on('data', (chunk: Buffer | string) => lines.push(chunk));
    stream.on('end', () => finish('end'));
    stream.on('close', () => finish('close'));
    stream.on('error', () => finish('error'));
  }

  private retry(): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt, {
      baseMs: this.o.backoffBaseMs ?? 1000,
      maxMs: this.o.backoffMaxMs ?? 60_000,
    });
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }
}

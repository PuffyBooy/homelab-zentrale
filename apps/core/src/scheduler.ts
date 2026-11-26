import type { Clock } from './clock.js';

/**
 * Small internal scheduler (no external cron). Jobs run when the injected clock
 * says they are due; `tick()` checks all jobs. In production `start()` calls
 * `tick()` once per second. Tests leave it stopped, move their fake clock and
 * call `tick()` themselves, so time-based rules are deterministic.
 *
 * Missed runs are not caught up: after a long pause a job runs once and is
 * rescheduled from the current time. A job never overlaps with itself.
 */
export type JobFn = () => void | Promise<void>;

export interface JobOptions {
  /** Run at multiples of the interval since epoch (UTC), e.g. :00, :05, ... */
  align?: boolean;
  /** Run on the first tick instead of waiting one interval. */
  immediate?: boolean;
}

interface Job {
  name: string;
  /** Next due time after `from` (interval or wall-clock rule). */
  nextAfter: (from: number) => number;
  next: number;
  fn: JobFn;
  running: boolean;
}

export interface SchedulerOptions {
  /** Real-time resolution of start(). Default 1000 ms. */
  resolutionMs?: number;
  onError?: (job: string, err: unknown) => void;
}

export class Scheduler {
  private readonly jobs = new Map<string, Job>();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;

  constructor(
    private readonly now: Clock,
    private readonly opts: SchedulerOptions = {},
  ) {}

  /** Registers a job. Returns a function that removes it. Names are unique. */
  every(name: string, intervalMs: number, fn: JobFn, opts: JobOptions = {}): () => void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('interval must be > 0');
    const align = opts.align ?? false;
    return this.add(name, (from) => this.nextRun(from, intervalMs, align), fn, opts.immediate);
  }

  /**
   * Registers a job that runs at times given by `nextAfter` (e.g. every day at
   * 04:00 Vienna time, see calendar.ts). `nextAfter(t)` must return a time > t.
   */
  at(name: string, nextAfter: (from: number) => number, fn: JobFn): () => void {
    return this.add(name, nextAfter, fn, false);
  }

  private add(
    name: string,
    nextAfter: (from: number) => number,
    fn: JobFn,
    immediate = false,
  ): () => void {
    if (this.jobs.has(name)) throw new Error(`job ${name} exists`);
    const job: Job = {
      name,
      nextAfter,
      next: immediate ? this.now() : nextAfter(this.now()),
      fn,
      running: false,
    };
    this.jobs.set(name, job);
    return () => {
      if (this.jobs.get(name) === job) this.jobs.delete(name);
    };
  }

  has(name: string): boolean {
    return this.jobs.has(name);
  }

  /** Next due time of a job (for tests and diagnostics). */
  nextRunOf(name: string): number | undefined {
    return this.jobs.get(name)?.next;
  }

  /** Runs every due job once, in registration order. */
  tick(): Promise<void> {
    // Concurrent ticks share one run, so a slow job cannot be started twice.
    this.ticking ??= this.runDue().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  start(): void {
    if (this.timer) return;
    const ms = this.opts.resolutionMs ?? 1000;
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private nextRun(from: number, intervalMs: number, align: boolean): number {
    if (!align) return from + intervalMs;
    return Math.floor(from / intervalMs) * intervalMs + intervalMs;
  }

  private async runDue(): Promise<void> {
    for (const job of [...this.jobs.values()]) {
      const now = this.now();
      if (job.running || job.next > now) continue;
      job.running = true;
      try {
        await job.fn();
      } catch (err) {
        this.opts.onError?.(job.name, err);
      } finally {
        job.running = false;
        job.next = job.nextAfter(this.now());
      }
    }
  }
}

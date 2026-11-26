import type Docker from 'dockerode';
import {
  LOG_MATCH_MAX_CHARS,
  LOG_SEARCH_TAIL,
  logMatchSchema,
  logsSearchDataSchema,
  type LogMatch,
  type LogsSearchData,
  type RpcParams,
} from '@hz/shared';
import { DockerDemuxer, LineBuffer, type LogChannel } from './logs.js';
import { ActionError, type ActionContext } from './types.js';

/**
 * logs.search: plain substring search in the recent logs of this host's containers.
 *
 * - The query is never turned into a RegExp (String.includes only, no ReDoS).
 * - Logs are read as a stream (follow=false, timestamps, since, tail) and processed
 *   line by line; per container at most `maxMatches` matches are kept, never the log.
 * - At most SEARCH_CONCURRENCY containers at a time, SEARCH_TIMEOUT_MS overall; on the
 *   timeout the matches found so far are returned with truncated=true.
 */

export const SEARCH_CONCURRENCY = 4;
export const SEARCH_TIMEOUT_MS = 25_000;

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}) /;

/** Splits the Docker timestamp (RFC3339Nano + space) off a line. ts is ISO with ms precision. */
export function splitTimestamp(line: string): { ts: string | null; text: string } {
  const m = TS_RE.exec(line);
  if (!m) return { ts: null, text: line };
  const frac = (m[2] ?? '').padEnd(3, '0').slice(0, 3);
  const ms = Date.parse(`${m[1]}.${frac}${m[3]}`);
  if (!Number.isFinite(ms)) return { ts: null, text: line };
  return { ts: new Date(ms).toISOString(), text: line.slice(m[0].length) };
}

/** Plain substring search; returns the index of the match or -1. */
export function findMatch(text: string, query: string, caseSensitive: boolean): number {
  if (caseSensitive) return text.indexOf(query);
  return text.toLowerCase().indexOf(query.toLowerCase());
}

/** Cuts a line to `max` characters around the match. */
export function cutAround(
  text: string,
  index: number,
  queryLength: number,
  max = LOG_MATCH_MAX_CHARS,
): string {
  if (text.length <= max) return text;
  const center = index + Math.floor(queryLength / 2);
  let start = Math.max(0, center - Math.floor(max / 2));
  if (start + max > text.length) start = text.length - max;
  return text.slice(start, start + max);
}

export interface SearchTarget {
  id: string;
  name: string;
}

/** Only the parts of a Docker log stream we use. */
export interface LogReadable {
  on(event: 'data', fn: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'close', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  destroy?: () => void;
}

/** Opens a non-follow log stream of one container (see dockerLogStream). */
export type OpenLogs = (
  target: SearchTarget,
  query: { since: number; tail: number },
  signal: AbortSignal,
) => Promise<LogReadable>;

interface ContainerResult {
  matches: LogMatch[];
  /** The container had at least LOG_SEARCH_TAIL lines, or more than maxMatches matched. */
  truncated: boolean;
  ok: boolean;
}

/** Searches one log stream line by line. Keeps only the newest `maxMatches` matches. */
export function searchStream(
  stream: LogReadable,
  target: SearchTarget,
  params: { query: string; caseSensitive: boolean; maxMatches: number },
  signal: AbortSignal,
): Promise<ContainerResult> {
  return new Promise((resolve) => {
    const matches: LogMatch[] = [];
    let lines = 0;
    let dropped = false;
    let done = false;
    const onLine = (channel: LogChannel) => (line: string) => {
      const { ts, text } = splitTimestamp(line);
      if (ts !== null) lines++;
      const idx = findMatch(text, params.query, params.caseSensitive);
      if (idx < 0) return;
      matches.push({
        containerId: target.id,
        containerName: target.name,
        ts,
        stream: channel,
        text: cutAround(text, idx, params.query.length),
      });
      // Oldest first in the stream: drop the oldest beyond the limit (amortized).
      if (matches.length > params.maxMatches * 2) {
        matches.splice(0, matches.length - params.maxMatches);
        dropped = true;
      }
    };
    const buffers: Record<LogChannel, LineBuffer> = {
      stdout: new LineBuffer(onLine('stdout')),
      stderr: new LineBuffer(onLine('stderr')),
    };
    const demux = new DockerDemuxer((ch, payload) => buffers[ch].push(payload));
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      buffers.stdout.flush();
      buffers.stderr.flush();
      if (matches.length > params.maxMatches) {
        matches.splice(0, matches.length - params.maxMatches);
        dropped = true;
      }
      resolve({ matches, truncated: dropped || lines >= LOG_SEARCH_TAIL || !ok, ok });
    };
    const onAbort = () => {
      stream.destroy?.();
      finish(false);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);
    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      demux.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => finish(true));
    stream.on('close', () => finish(true));
    stream.on('error', () => finish(false));
  });
}

/** Newest first; lines without timestamp after those with one. */
export function mergeNewestFirst(lists: readonly LogMatch[][]): LogMatch[] {
  const all = lists.flatMap((l, li) => l.map((m, i) => ({ m, li, i })));
  all.sort((a, b) => {
    const ta = a.m.ts ?? '';
    const tb = b.m.ts ?? '';
    if (ta !== tb) return ta < tb ? 1 : -1;
    // Same time: keep the stream order reversed (later line first).
    return a.li - b.li || b.i - a.i;
  });
  return all.map(({ m }) => m);
}

interface DialModem {
  dial(
    opts: {
      path: string;
      method: 'GET';
      isStream: true;
      abortSignal: AbortSignal;
      statusCodes: Record<number, true | string>;
      options: Record<string, string | number | boolean>;
    },
    cb: (err: unknown, data: unknown) => void,
  ): void;
}

/**
 * Non-follow log stream. dockerode's container.logs buffers the whole response when
 * follow=false, so the request goes through its modem with isStream=true instead.
 */
export function dockerLogStream(docker: Docker): OpenLogs {
  return (target, query, signal) =>
    new Promise((resolve, reject) => {
      const modem = docker.modem as DialModem;
      modem.dial(
        {
          path: `/containers/${encodeURIComponent(target.id)}/logs?`,
          method: 'GET',
          isStream: true,
          abortSignal: signal,
          statusCodes: { 200: true, 404: 'no such container', 500: 'server error' },
          options: {
            stdout: true,
            stderr: true,
            timestamps: true,
            follow: false,
            since: query.since,
            tail: query.tail,
          },
        },
        (err, data) => {
          if (err) reject(err instanceof Error ? err : new Error('log request failed'));
          else resolve(data as LogReadable);
        },
      );
    });
}

function nameOf(c: Docker.ContainerInfo): string {
  return (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '').slice(0, 128);
}

/** All containers, or the given ids (full or prefix of >= 12 chars) / names that exist. */
export function selectTargets(
  list: readonly Pick<Docker.ContainerInfo, 'Id' | 'Names'>[],
  refs: readonly string[] | undefined,
): SearchTarget[] {
  const all = list
    .filter(
      (c) => typeof c.Id === 'string' && logMatchSchema.shape.containerId.safeParse(c.Id).success,
    )
    .map((c) => ({ id: c.Id, name: nameOf(c as Docker.ContainerInfo) }));
  if (!refs || refs.length === 0) return all;
  const wanted = new Set(refs);
  return all.filter(
    (t) =>
      wanted.has(t.id) ||
      wanted.has(t.name) ||
      refs.some((r) => r.length >= 12 && /^[0-9a-f]+$/.test(r) && t.id.startsWith(r)),
  );
}

export interface SearchOptions {
  openLogs?: OpenLogs;
  timeoutMs?: number;
  concurrency?: number;
  now?: () => number;
}

export async function logsSearch(
  params: RpcParams<'logs.search'>,
  ctx: ActionContext,
  opts: SearchOptions = {},
): Promise<LogsSearchData> {
  const docker = ctx.host.docker;
  if (!docker) throw new ActionError('failed', 'docker not available');
  let list: Docker.ContainerInfo[];
  try {
    list = await docker.listContainers({ all: true });
  } catch {
    throw new ActionError('failed', 'listing containers failed');
  }
  const targets = selectTargets(list, params.containers);
  const openLogs = opts.openLogs ?? dockerLogStream(docker);
  const now = (opts.now ?? Date.now)();
  const since = Math.floor((now - params.sinceMinutes * 60_000) / 1000);
  const search = {
    query: params.query,
    caseSensitive: params.caseSensitive,
    maxMatches: params.maxMatches,
  };

  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, opts.timeoutMs ?? SEARCH_TIMEOUT_MS);

  const results: ContainerResult[] = [];
  let next = 0;
  const worker = async () => {
    while (!abort.signal.aborted) {
      const target = targets[next++];
      if (!target) return;
      let stream: LogReadable;
      try {
        stream = await openLogs(target, { since, tail: LOG_SEARCH_TAIL }, abort.signal);
      } catch {
        continue; // gone or not readable: skip
      }
      results.push(await searchStream(stream, target, search, abort.signal));
    }
  };
  try {
    const n = Math.max(1, Math.min(opts.concurrency ?? SEARCH_CONCURRENCY, targets.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
  } finally {
    clearTimeout(timer);
  }

  const merged = mergeNewestFirst(results.map((r) => r.matches));
  const valid = merged.filter((m) => logMatchSchema.safeParse(m).success);
  const data: LogsSearchData = {
    matches: valid.slice(0, params.maxMatches),
    scannedContainers: results.filter((r) => r.ok).length,
    truncated: timedOut || valid.length > params.maxMatches || results.some((r) => r.truncated),
  };
  return logsSearchDataSchema.parse(data);
}

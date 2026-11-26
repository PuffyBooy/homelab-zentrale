import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import {
  LOG_MATCH_MAX_CHARS,
  LOG_SEARCH_TAIL,
  logsSearchDataSchema,
  parseRpc,
  type RpcParams,
} from '@hz/shared';
import {
  cutAround,
  dockerLogStream,
  findMatch,
  logsSearch,
  mergeNewestFirst,
  selectTargets,
  splitTimestamp,
  type LogReadable,
  type OpenLogs,
} from '../src/actions/logs-search.js';
import { makeCtx } from './game-helpers.js';

function frame(type: number, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);

function fakeDocker(list: Partial<Docker.ContainerInfo>[]): Docker {
  return { listContainers: async () => list } as unknown as Docker;
}

function params(over: Partial<RpcParams<'logs.search'>> = {}): RpcParams<'logs.search'> {
  return { query: 'error', caseSensitive: false, sinceMinutes: 60, maxMatches: 200, ...over };
}

/** Opens a stream that emits the given chunks, then ends. */
function streamOf(chunks: Buffer[]): LogReadable {
  const s = new PassThrough();
  setImmediate(() => {
    for (const c of chunks) s.write(c);
    s.end();
  });
  return s;
}

describe('logs.search helpers', () => {
  it('parses and strips the RFC3339Nano timestamp (ms precision)', () => {
    expect(splitTimestamp('2026-11-26T10:11:12.123456789Z hello world')).toEqual({
      ts: '2026-11-26T10:11:12.123Z',
      text: 'hello world',
    });
    expect(splitTimestamp('2026-11-26T10:11:12Z x').ts).toBe('2026-11-26T10:11:12.000Z');
    expect(splitTimestamp('2026-11-26T10:11:12.5+01:00 x').ts).toBe('2026-11-26T09:11:12.500Z');
    expect(splitTimestamp('no timestamp here')).toEqual({ ts: null, text: 'no timestamp here' });
  });

  it('matches case-insensitively unless caseSensitive', () => {
    expect(findMatch('Some ERROR here', 'error', false)).toBe(5);
    expect(findMatch('Some ERROR here', 'error', true)).toBe(-1);
    expect(findMatch('Some error here', 'error', true)).toBe(5);
  });

  it('treats regex metacharacters literally', () => {
    expect(findMatch('foo bar', '.*(', false)).toBe(-1);
    expect(findMatch('call .*( here', '.*(', false)).toBe(5);
    expect(findMatch('aaaaaaaaaaaaaaaaaaaaaaaaaaaa!', '(a+)+$', false)).toBe(-1);
    expect(findMatch('x[y]', '[y]', true)).toBe(1);
  });

  it('cuts long lines around the match', () => {
    const line = `${'a'.repeat(5000)}NEEDLE${'b'.repeat(5000)}`;
    const cut = cutAround(line, 5000, 6);
    expect(cut.length).toBe(LOG_MATCH_MAX_CHARS);
    expect(cut).toContain('NEEDLE');
    expect(cutAround('short', 0, 1)).toBe('short');
    // match at the very end stays inside the window
    const end = `${'a'.repeat(3000)}END`;
    expect(cutAround(end, 3000, 3).endsWith('END')).toBe(true);
    expect(cutAround(`START${'a'.repeat(3000)}`, 0, 5).startsWith('START')).toBe(true);
  });

  it('merges newest first', () => {
    const m = (ts: string | null, text: string) => ({
      containerId: ID_A,
      containerName: 'a',
      ts,
      stream: 'stdout' as const,
      text,
    });
    const out = mergeNewestFirst([
      [m('2026-01-01T00:00:01.000Z', 'a1'), m('2026-01-01T00:00:03.000Z', 'a3')],
      [m('2026-01-01T00:00:02.000Z', 'b2'), m(null, 'bn')],
    ]);
    expect(out.map((x) => x.text)).toEqual(['a3', 'b2', 'a1', 'bn']);
  });

  it('selects all containers or only existing ids/names', () => {
    const list = [
      { Id: ID_A, Names: ['/web'] },
      { Id: ID_B, Names: ['/db'] },
      { Id: 'not valid!', Names: ['/bad'] },
    ];
    expect(selectTargets(list, undefined).map((t) => t.name)).toEqual(['web', 'db']);
    expect(selectTargets(list, []).map((t) => t.name)).toEqual(['web', 'db']);
    expect(selectTargets(list, ['db', 'missing']).map((t) => t.id)).toEqual([ID_B]);
    expect(selectTargets(list, [ID_A.slice(0, 12)]).map((t) => t.name)).toEqual(['web']);
    // short prefixes do not match
    expect(selectTargets(list, ['aaa'])).toEqual([]);
  });
});

describe('logs.search action', () => {
  it('searches multiplexed and TTY logs, newest first, with ts and stream', async () => {
    const { ctx } = makeCtx('/nonexistent');
    ctx.host.docker = fakeDocker([
      { Id: ID_A, Names: ['/web'] },
      { Id: ID_B, Names: ['/tty'] },
    ]);
    const queries: { since: number; tail: number }[] = [];
    const openLogs: OpenLogs = async (t, q) => {
      queries.push(q);
      if (t.id === ID_A) {
        return streamOf([
          frame(1, '2026-11-26T10:00:01.000000001Z info ok\n'),
          frame(2, '2026-11-26T10:00:02.000000000Z ERROR: disk full\n'),
          frame(1, '2026-11-26T10:00:04.000000000Z another error\n'),
        ]);
      }
      return streamOf([Buffer.from('2026-11-26T10:00:03.000Z tty Error line\r\n')]);
    };
    const now = Date.parse('2026-11-26T11:00:00Z');
    const data = await logsSearch(params(), ctx, { openLogs, now: () => now });
    expect(logsSearchDataSchema.safeParse(data).success).toBe(true);
    expect(data.scannedContainers).toBe(2);
    expect(data.truncated).toBe(false);
    expect(data.matches.map((m) => [m.containerName, m.stream, m.ts, m.text])).toEqual([
      ['web', 'stdout', '2026-11-26T10:00:04.000Z', 'another error'],
      ['tty', 'stdout', '2026-11-26T10:00:03.000Z', 'tty Error line'],
      ['web', 'stderr', '2026-11-26T10:00:02.000Z', 'ERROR: disk full'],
    ]);
    expect(queries[0]).toEqual({ since: Math.floor(now / 1000) - 3600, tail: LOG_SEARCH_TAIL });
  });

  it('case sensitive search', async () => {
    const { ctx } = makeCtx('/nonexistent');
    ctx.host.docker = fakeDocker([{ Id: ID_A, Names: ['/web'] }]);
    const openLogs: OpenLogs = async () =>
      streamOf([frame(1, '2026-11-26T10:00:01Z ERROR\n2026-11-26T10:00:02Z error\n')]);
    const data = await logsSearch(params({ caseSensitive: true }), ctx, { openLogs });
    expect(data.matches.map((m) => m.text)).toEqual(['error']);
  });

  it('a query with regex metacharacters is matched literally', async () => {
    const { ctx } = makeCtx('/nonexistent');
    ctx.host.docker = fakeDocker([{ Id: ID_A, Names: ['/web'] }]);
    const openLogs: OpenLogs = async () =>
      streamOf([frame(1, '2026-11-26T10:00:01Z anything\n2026-11-26T10:00:02Z lit .*( x\n')]);
    const data = await logsSearch(params({ query: '.*(' }), ctx, { openLogs });
    expect(data.matches.map((m) => m.text)).toEqual(['lit .*( x']);
  });

  it('stops at maxMatches with the newest and sets truncated', async () => {
    const { ctx } = makeCtx('/nonexistent');
    ctx.host.docker = fakeDocker([{ Id: ID_A, Names: ['/web'] }]);
    const lines = Array.from(
      { length: 50 },
      (_, i) => `2026-11-26T10:00:${String(i).padStart(2, '0')}Z error ${i}\n`,
    ).join('');
    const openLogs: OpenLogs = async () => streamOf([frame(1, lines)]);
    const data = await logsSearch(params({ maxMatches: 3 }), ctx, { openLogs });
    expect(data.truncated).toBe(true);
    expect(data.matches.map((m) => m.text)).toEqual(['error 49', 'error 48', 'error 47']);
  });

  it('returns what it has on the overall timeout (truncated)', async () => {
    const { ctx } = makeCtx('/nonexistent');
    ctx.host.docker = fakeDocker([{ Id: ID_A, Names: ['/web'] }]);
    let destroyed = false;
    const openLogs: OpenLogs = async () => {
      const s = new PassThrough();
      s.write(frame(1, '2026-11-26T10:00:01Z early error\n'));
      const orig = s.destroy.bind(s);
      s.destroy = (e?: Error) => {
        destroyed = true;
        return orig(e);
      };
      return s; // never ends
    };
    const data = await logsSearch(params(), ctx, { openLogs, timeoutMs: 50 });
    expect(data.truncated).toBe(true);
    expect(destroyed).toBe(true);
    expect(data.matches.map((m) => m.text)).toEqual(['early error']);
  });

  it('skips containers that cannot be read and limits concurrency', async () => {
    const { ctx } = makeCtx('/nonexistent');
    const list = Array.from({ length: 10 }, (_, i) => ({
      Id: String(i).repeat(64).slice(0, 64),
      Names: [`/c${i}`],
    }));
    ctx.host.docker = fakeDocker(list);
    let open = 0;
    let peak = 0;
    const openLogs: OpenLogs = async (t) => {
      if (t.name === 'c3') throw new Error('gone');
      open++;
      peak = Math.max(peak, open);
      const s = new PassThrough();
      setTimeout(() => {
        open--;
        s.end(frame(1, `2026-11-26T10:00:01Z error in ${t.name}\n`));
      }, 5);
      return s;
    };
    const data = await logsSearch(params(), ctx, { openLogs });
    expect(peak).toBeLessThanOrEqual(4);
    expect(data.scannedContainers).toBe(9);
    expect(data.matches).toHaveLength(9);
  });

  it('opens a streamed, non-follow log request with timestamps', async () => {
    let seen: unknown;
    const docker = {
      modem: {
        dial: (opts: unknown, cb: (err: unknown, data: unknown) => void) => {
          seen = opts;
          cb(null, new PassThrough());
        },
      },
    } as unknown as Docker;
    const ac = new AbortController();
    await dockerLogStream(docker)({ id: ID_A, name: 'web' }, { since: 100, tail: 5 }, ac.signal);
    expect(seen).toMatchObject({
      path: `/containers/${ID_A}/logs?`,
      method: 'GET',
      isStream: true,
      abortSignal: ac.signal,
      options: { stdout: true, stderr: true, timestamps: true, follow: false, since: 100, tail: 5 },
    });
  });

  it('the protocol rejects multi-line queries and unknown fields', () => {
    const env = (p: unknown) => ({
      type: 'rpc' as const,
      id: 'r1',
      action: 'logs.search',
      params: p,
    });
    expect(parseRpc(env({ query: 'ab\ncd' })).ok).toBe(false);
    expect(parseRpc(env({ query: 'a' })).ok).toBe(false);
    expect(parseRpc(env({ query: 'abc', regex: true })).ok).toBe(false);
    expect(parseRpc(env({ query: 'abc', containers: ['-h'] })).ok).toBe(false);
    expect(parseRpc(env({ query: '.*(' })).ok).toBe(true);
  });
});

import type { LogLine } from '@hz/shared';
import { describe, expect, it } from 'vitest';
import { appendLogLines, findMatches, stepMatch, toTerminalLines } from './logs.js';

const line = (
  seq: number,
  text = `line ${seq}`,
  stream: LogLine['stream'] = 'stdout',
): LogLine => ({
  seq,
  stream,
  text,
});
const range = (from: number, to: number): LogLine[] =>
  Array.from({ length: to - from + 1 }, (_, i) => line(from + i));

describe('appendLogLines', () => {
  it('appends in order and keeps the last max lines', () => {
    const a = appendLogLines([], range(0, 4), 3);
    expect(a.map((l) => l.seq)).toEqual([2, 3, 4]);
    const b = appendLogLines(a, range(5, 6), 3);
    expect(b.map((l) => l.seq)).toEqual([4, 5, 6]);
    expect(a.map((l) => l.seq)).toEqual([2, 3, 4]);
  });

  it('upserts repeated and late lines by seq', () => {
    const prev = [line(1), line(2), line(4)];
    const out = appendLogLines(prev, [line(2, 'again'), line(3), line(5)]);
    expect(out.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(out[1]?.text).toBe('again');
  });

  it('caps at 2000 by default', () => {
    expect(appendLogLines([], range(0, 2499))).toHaveLength(2000);
    expect(appendLogLines([], range(0, 2499))[0]?.seq).toBe(500);
  });
});

describe('toTerminalLines', () => {
  it('marks stderr as err', () => {
    expect(toTerminalLines([line(1, 'ok'), line(2, 'boom', 'stderr')])).toEqual([
      { text: 'ok' },
      { text: 'boom', kind: 'err' },
    ]);
  });
});

describe('findMatches', () => {
  const lines = [{ text: 'GET /api 200' }, { text: 'error: Api down, api retry' }, { text: '' }];

  it('finds every match case-insensitively', () => {
    expect(findMatches(lines, 'api')).toEqual([
      { line: 0, start: 5, end: 8 },
      { line: 1, start: 7, end: 10 },
      { line: 1, start: 17, end: 20 },
    ]);
    expect(findMatches(lines, '')).toEqual([]);
    expect(findMatches(lines, 'nope')).toEqual([]);
  });

  it('treats the query as plain text, not a regex', () => {
    expect(findMatches([{ text: 'a.b axb (x)' }], '.')).toEqual([{ line: 0, start: 1, end: 2 }]);
    expect(findMatches([{ text: 'a.b axb (x)' }], '(x)')).toEqual([{ line: 0, start: 8, end: 11 }]);
  });

  it('stops at the limit', () => {
    expect(findMatches([{ text: 'aaaa' }], 'a', 2)).toHaveLength(2);
  });
});

describe('stepMatch', () => {
  it('wraps around', () => {
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});

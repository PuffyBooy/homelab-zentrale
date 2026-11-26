import type { LogLine } from '@hz/shared';
import type { TerminalLine } from '@hz/ui';

/** Lines kept per stream, in the cache and in the DOM. */
export const MAX_LOG_LINES = 2000;

export const containerLogsKey = (id: string) => ['container-logs', id] as const;

export interface LogBuffer {
  lines: LogLine[];
  ended: boolean;
}

export const emptyLogBuffer: LogBuffer = { lines: [], ended: false };

/**
 * Appends lines in seq order and keeps the last `max`. Lines are upserted by seq, so a
 * repeated or late line never shows twice. Returns a new array.
 */
export function appendLogLines(
  prev: readonly LogLine[],
  incoming: readonly LogLine[],
  max: number = MAX_LOG_LINES,
): LogLine[] {
  if (!incoming.length) return prev.length > max ? prev.slice(-max) : [...prev];
  const last = prev.length ? (prev[prev.length - 1]?.seq ?? -1) : -1;
  let ordered = true;
  let s = last;
  for (const l of incoming) {
    if (l.seq <= s) {
      ordered = false;
      break;
    }
    s = l.seq;
  }
  let out: LogLine[];
  if (ordered) {
    out = [...prev, ...incoming];
  } else {
    const bySeq = new Map<number, LogLine>();
    for (const l of prev) bySeq.set(l.seq, l);
    for (const l of incoming) bySeq.set(l.seq, l);
    out = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
  return out.length > max ? out.slice(-max) : out;
}

/** stderr becomes an `err` line of the Terminal. */
export function toTerminalLines(lines: readonly LogLine[]): TerminalLine[] {
  return lines.map((l) =>
    l.stream === 'stderr' ? { text: l.text, kind: 'err' } : { text: l.text },
  );
}

export interface LogMatch {
  /** Index in the shown lines. */
  line: number;
  start: number;
  end: number;
}

/** Upper bound for highlighted matches, so a one-letter search stays fast. */
export const MAX_MATCHES = 5000;

/** Case-insensitive plain-text search (no regex). */
export function findMatches(
  lines: readonly { text: string }[],
  query: string,
  limit: number = MAX_MATCHES,
): LogMatch[] {
  if (!query) return [];
  // Escaped, so the query is plain text; offsets refer to the original string.
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const out: LogMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]?.text ?? '';
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      out.push({ line: i, start: m.index, end: m.index + m[0].length });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Next/previous match index with wrap-around. */
export function stepMatch(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

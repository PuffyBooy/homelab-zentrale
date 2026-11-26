/**
 * Minimal JSON-lines logger on stderr. Secrets never reach the output:
 * - fields named like a secret (token, pin, password, authorization ...) are replaced,
 * - every registered secret value is masked wherever it appears in a string,
 * - anything shaped like a share token (43 base64url chars) is masked as well.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|pin/i;
const TOKEN_SHAPE = /[A-Za-z0-9_-]{43,}/g;
const REDACTED = '[redacted]';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Registers a secret value that must be masked in every later line. */
  addSecret(value: string | undefined): void;
}

export function createLogger(
  level: LogLevel = 'info',
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const secrets = new Set<string>();

  const mask = (s: string): string => {
    let out = s;
    for (const secret of secrets) out = out.split(secret).join(REDACTED);
    return out.replace(TOKEN_SHAPE, REDACTED);
  };

  const clean = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return mask(value);
    if (value instanceof Error) return mask(`${value.name}: ${value.message}`);
    if (depth > 4 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : clean(v, depth + 1);
    }
    return out;
  };

  const log = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: mask(msg),
      ...(fields ? (clean(fields, 0) as Record<string, unknown>) : {}),
    };
    write(JSON.stringify(line));
  };

  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    addSecret: (v) => {
      if (v && v.length >= 8) secrets.add(v);
    },
  };
}

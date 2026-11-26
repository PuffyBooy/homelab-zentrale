import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ListeningPort } from '@hz/shared';
import { isMissingProgram, runFile } from '../exec.js';
import { hostPath, type HostContext } from '../host.js';

/**
 * Security part of `inventory` (SPEC 5.1 "Sicherheit").
 *
 * How the host is read from inside the container:
 * - updates: `apt list --upgradable` on the host via nsenter (the host's apt and
 *   package lists). Security updates are lines whose suites contain "-security".
 *   No apt on the host (or nsenter not permitted) -> null.
 * - reboot required: /run/reboot-required (Debian/Ubuntu) through the host root.
 * - SSH failures 24 h: `journalctl _COMM=sshd _COMM=sshd-session --since -24h`
 *   on the host via nsenter (JSON, grouped per sshd PID); fallback
 *   /var/log/auth.log through the host root. Neither readable -> null.
 * - fail2ban: `fail2ban-client status` (+ per jail) on the host; missing -> null.
 * - ports: `ss -H -l -n -t -u -p` from the container (host network namespace,
 *   pid: host gives process names); fallback parsing /proc/net/{tcp,udp}{,6}
 *   without process names.
 * Every step fails soft: an error yields null (or []), never a crash.
 */

// ---------------------------------------------------------------------------
// apt

export function parseAptUpgradable(text: string): { total: number; security: number } {
  let total = 0;
  let security = 0;
  for (const line of text.split('\n')) {
    // openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]
    const m = /^[a-z0-9][a-z0-9+.-]*\/(\S+)\s+\S+\s+\S+\s+\[upgradable from:/.exec(line.trim());
    if (!m?.[1]) continue;
    total += 1;
    if (m[1].split(',').some((suite) => suite.includes('-security'))) security += 1;
  }
  return { total, security };
}

export async function collectUpdates(
  ctx: Pick<HostContext, 'exec'>,
): Promise<{ total: number; security: number } | null> {
  const r = await ctx.exec('apt', ['list', '--upgradable'], { timeoutMs: 60_000 });
  if (r.code !== 0) return null;
  return parseAptUpgradable(r.stdout);
}

// ---------------------------------------------------------------------------
// reboot-required

export async function rebootRequired(ctx: Pick<HostContext, 'hostRoot'>): Promise<boolean> {
  for (const p of ['/run/reboot-required', '/var/run/reboot-required']) {
    try {
      await stat(hostPath(ctx, p));
      return true;
    } catch {
      // not there
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// SSH failures

const FAILED_RE = /^Failed \S+ for /;
const INVALID_RE = /^Invalid user /;

/**
 * Counts failed SSH attempts. sshd logs one "Failed <method> for" line per
 * attempt and one "Invalid user" line per connection with an unknown user (which
 * may or may not be followed by "Failed" lines). Per sshd PID we count
 * max(failed lines, invalid user ? 1 : 0), so nothing is counted twice.
 */
export function countSshFailures(entries: Iterable<{ pid: string; message: string }>): number {
  const perPid = new Map<string, { failed: number; invalid: boolean }>();
  for (const { pid, message } of entries) {
    const msg = message.trim();
    const failed = FAILED_RE.test(msg);
    const invalid = INVALID_RE.test(msg);
    if (!failed && !invalid) continue;
    const e = perPid.get(pid) ?? { failed: 0, invalid: false };
    if (failed) e.failed += 1;
    if (invalid) e.invalid = true;
    perPid.set(pid, e);
  }
  let n = 0;
  for (const e of perPid.values()) n += Math.max(e.failed, e.invalid ? 1 : 0);
  return n;
}

export function parseJournalJson(text: string): { pid: string; message: string }[] {
  const out: { pid: string; message: string }[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const j = JSON.parse(line) as { MESSAGE?: unknown; _PID?: unknown };
      if (typeof j.MESSAGE === 'string') {
        out.push({ pid: typeof j._PID === 'string' ? j._PID : '?', message: j.MESSAGE });
      }
    } catch {
      // skip
    }
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parses auth.log lines (RFC 3339 or classic syslog timestamps) since `sinceMs`. */
export function parseAuthLog(
  text: string,
  sinceMs: number,
  nowMs: number,
): { pid: string; message: string }[] {
  const out: { pid: string; message: string }[] = [];
  const year = new Date(nowMs).getFullYear();
  for (const line of text.split('\n')) {
    let ts: number;
    let rest: string;
    const iso = /^(\d{4}-\d{2}-\d{2}T\S+)\s+\S+\s+(.*)$/.exec(line);
    const classic = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+\S+\s+(.*)$/.exec(
      line,
    );
    if (iso?.[1] && iso[2] !== undefined) {
      ts = Date.parse(iso[1]);
      rest = iso[2];
    } else if (classic?.[1] && classic[6] !== undefined) {
      const month = MONTHS.indexOf(classic[1]);
      if (month < 0) continue;
      ts = new Date(
        year,
        month,
        Number(classic[2]),
        Number(classic[3]),
        Number(classic[4]),
        Number(classic[5]),
      ).getTime();
      // Classic logs have no year: a date in the future belongs to last year.
      if (ts > nowMs + 86_400_000) ts = new Date(year - 1, month, Number(classic[2])).getTime();
      rest = classic[6];
    } else continue;
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    const m = /^sshd(?:-session)?\[(\d+)\]:\s(.*)$/.exec(rest);
    if (m?.[1] && m[2] !== undefined) out.push({ pid: m[1], message: m[2] });
  }
  return out;
}

export async function collectSshFailures(
  ctx: Pick<HostContext, 'exec' | 'hostRoot'>,
  nowMs: number = Date.now(),
): Promise<number | null> {
  const r = await ctx.exec(
    'journalctl',
    [
      '--no-pager',
      '--quiet',
      '--since',
      '-24h',
      '--output',
      'json',
      '--output-fields',
      'MESSAGE,_PID',
      '_COMM=sshd',
      '_COMM=sshd-session',
    ],
    { timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.code === 0) {
    const entries = parseJournalJson(r.stdout);
    if (entries.length > 0) return countSshFailures(entries);
    // No sshd entries in the journal: maybe sshd logs to syslog only, check auth.log.
  }
  try {
    const text = await readFile(hostPath(ctx, '/var/log/auth.log'), 'utf8');
    return countSshFailures(parseAuthLog(text, nowMs - 86_400_000, nowMs));
  } catch {
    // No auth.log: if journalctl ran fine, the honest answer is 0.
    return r.code === 0 ? 0 : null;
  }
}

// ---------------------------------------------------------------------------
// fail2ban

const JAIL_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function parseFail2banJails(text: string): string[] {
  const m = /Jail list:\s*(.*)$/m.exec(text);
  if (!m?.[1]) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => JAIL_RE.test(s))
    .slice(0, 50);
}

export function parseFail2banBanned(text: string): number {
  const m = /Currently banned:\s*(\d+)/.exec(text);
  return m?.[1] ? Number(m[1]) : 0;
}

export async function collectFail2ban(ctx: Pick<HostContext, 'exec'>): Promise<number | null> {
  const status = await ctx.exec('fail2ban-client', ['status'], { timeoutMs: 10_000 });
  if (isMissingProgram(status) || status.code !== 0) return null;
  let banned = 0;
  for (const jail of parseFail2banJails(status.stdout)) {
    const r = await ctx.exec('fail2ban-client', ['status', jail], { timeoutMs: 10_000 });
    if (r.code === 0) banned += parseFail2banBanned(r.stdout);
  }
  return banned;
}

// ---------------------------------------------------------------------------
// listening ports

/** Parses `ss -H -l -n -t -u -p` output. */
export function parseSs(text: string): ListeningPort[] {
  const out: ListeningPort[] = [];
  for (const line of text.split('\n')) {
    // tcp   LISTEN 0  4096   127.0.0.1:8080   0.0.0.0:*   users:(("node",pid=1,fd=20))
    const cols = line.trim().split(/\s+/);
    const proto = cols[0];
    if (proto !== 'tcp' && proto !== 'udp') continue;
    const local = cols[4];
    if (!local) continue;
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    const port = Number(local.slice(idx + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const address = local
      .slice(0, idx)
      .replace(/^\[|\]$/g, '')
      .replace(/%\S+$/, '');
    const entry: ListeningPort = { proto, address: address.slice(0, 64), port };
    const proc = /users:\(\("([^"]{1,64})"/.exec(line);
    if (proc?.[1]) entry.process = proc[1];
    out.push(entry);
  }
  return dedupePorts(out);
}

function hexToIPv4(hex: string): string {
  const b = Buffer.from(hex, 'hex');
  return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`;
}

function hexToIPv6(hex: string): string {
  const b = Buffer.from(hex, 'hex');
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 4) {
    // Each 32-bit word is stored in host byte order (little endian).
    groups.push(
      (((b[i + 3] ?? 0) << 8) | (b[i + 2] ?? 0)).toString(16),
      (((b[i + 1] ?? 0) << 8) | (b[i] ?? 0)).toString(16),
    );
  }
  const full = groups.join(':');
  if (full === '0:0:0:0:0:0:0:0') return '::';
  if (full === '0:0:0:0:0:0:0:1') return '::1';
  return full;
}

/** Parses /proc/net/{tcp,tcp6,udp,udp6}. TCP: state 0A (LISTEN); UDP: state 07 with no peer. */
export function parseProcNet(text: string, proto: 'tcp' | 'udp', v6: boolean): ListeningPort[] {
  const out: ListeningPort[] = [];
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    const local = cols[1];
    const remote = cols[2];
    const state = cols[3];
    if (!local || !remote || !state) continue;
    if (proto === 'tcp' && state !== '0A') continue;
    if (proto === 'udp' && (state !== '07' || !/:0000$/.test(remote))) continue;
    const [addrHex, portHex] = local.split(':');
    if (!addrHex || !portHex) continue;
    const port = parseInt(portHex, 16);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const address = v6 ? hexToIPv6(addrHex) : hexToIPv4(addrHex);
    out.push({ proto, address, port });
  }
  return out;
}

function dedupePorts(list: ListeningPort[]): ListeningPort[] {
  const seen = new Set<string>();
  return list
    .filter((p) => {
      const k = `${p.proto}|${p.address}|${p.port}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))
    .slice(0, 1000);
}

export async function collectPorts(ctx: Pick<HostContext, 'hostProc'>): Promise<ListeningPort[]> {
  const ss = await runFile('ss', ['-H', '-l', '-n', '-t', '-u', '-p'], { timeoutMs: 10_000 });
  if (ss.code === 0) return parseSs(ss.stdout);
  const out: ListeningPort[] = [];
  for (const [file, proto, v6] of [
    ['tcp', 'tcp', false],
    ['tcp6', 'tcp', true],
    ['udp', 'udp', false],
    ['udp6', 'udp', true],
  ] as const) {
    try {
      const text = await readFile(path.join(ctx.hostProc, 'net', file), 'utf8');
      out.push(...parseProcNet(text, proto, v6));
    } catch {
      // not available
    }
  }
  return dedupePorts(out);
}

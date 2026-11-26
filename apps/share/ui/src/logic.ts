import type { SharePerm, ShareStatus } from '@hz/shared';

/**
 * Pure logic of the share page (no DOM): token from the path, answers of the share API
 * mapped to screens and German texts, and which controls the link's rights allow.
 * The core checks every right again on every request; this only decides what to show.
 */

export type { ShareStatus };
export type GameStatus = ShareStatus['game']['status'];
export type ConsoleLine = { id: string; text: string; kind: 'out' | 'cmd' | 'err'; ts: string };

export type ShareErrorCode =
  | 'not_found'
  | 'revoked'
  | 'expired'
  | 'pin_required'
  | 'pin_wrong'
  | 'locked'
  | 'forbidden'
  | 'rate_limited'
  | 'invalid_input'
  | 'busy'
  | 'unavailable'
  /** M10: the game does not fit into free RAM minus the reserve (no numbers for links). */
  | 'insufficient_ram';

/** A failed request: share API error codes plus two client-side ones. */
export interface Failure {
  status: number;
  error: ShareErrorCode | 'network' | 'bad_response';
  retryAfter?: number | undefined;
  triesLeft?: number | undefined;
}

const TOKEN_PATH = /^\/s\/([A-Za-z0-9_-]{43})\/?$/;

/** `/s/<43 chars base64url>`; anything else is not a link and nothing is sent. */
export function tokenFromPath(pathname: string): string | null {
  return TOKEN_PATH.exec(pathname)?.[1] ?? null;
}

// ---- screens ---------------------------------------------------------------------

export type Screen =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'revoked' }
  | { kind: 'pin'; wrong: boolean; triesLeft: number | null }
  | { kind: 'locked'; until: Date }
  | { kind: 'ready'; status: ShareStatus };

const LOCK_SECONDS = 15 * 60;

/** Answers that replace the whole page. Others (busy, forbidden …) are an inline line. */
export function screenFor(f: Failure, now: Date = new Date()): Screen | null {
  switch (f.error) {
    case 'not_found':
      return { kind: 'invalid' };
    case 'revoked':
      return { kind: 'revoked' };
    case 'expired':
      return { kind: 'expired' };
    case 'pin_required':
      return { kind: 'pin', wrong: false, triesLeft: f.triesLeft ?? null };
    case 'pin_wrong':
      return { kind: 'pin', wrong: true, triesLeft: f.triesLeft ?? null };
    case 'locked':
      return {
        kind: 'locked',
        until: new Date(now.getTime() + (f.retryAfter ?? LOCK_SECONDS) * 1000),
      };
    default:
      return null;
  }
}

/** Screens after which nothing is polled any more. */
export function isFinal(s: Screen): boolean {
  return s.kind === 'invalid' || s.kind === 'expired' || s.kind === 'revoked';
}

export interface Message {
  tone: 'crit' | 'warn' | 'info';
  title: string;
  text: string;
}

export function messageFor(s: Screen): Message | null {
  switch (s.kind) {
    case 'invalid':
      return {
        tone: 'crit',
        title: 'Link ungültig.',
        text: 'Prüf, ob der Link vollständig kopiert ist, oder frag nach einem neuen.',
      };
    case 'expired':
      return {
        tone: 'warn',
        title: 'Link abgelaufen.',
        text: 'Frag nach einem neuen Link, wenn du weiter spielen willst.',
      };
    case 'revoked':
      return { tone: 'warn', title: 'Link widerrufen.', text: 'Dieser Link gilt nicht mehr.' };
    case 'locked':
      return {
        tone: 'warn',
        title: `PIN gesperrt bis ${formatTime(s.until)}.`,
        text: 'Nach 5 falschen Versuchen ist der Link 15 Min gesperrt. Danach geht es wieder.',
      };
    default:
      return null;
  }
}

/** "PIN falsch. Noch 3 Versuche." */
export function pinText(s: Extract<Screen, { kind: 'pin' }>): string | null {
  if (!s.wrong) return null;
  if (s.triesLeft === null) return 'PIN falsch.';
  return `PIN falsch. Noch ${s.triesLeft} ${s.triesLeft === 1 ? 'Versuch' : 'Versuche'}.`;
}

/** Inline line for failures that do not replace the page. */
export function errorLine(f: Failure): string {
  switch (f.error) {
    case 'forbidden':
      return 'Dafür hat dieser Link keine Berechtigung.';
    case 'busy':
      return 'Gerade läuft schon eine Aktion. Kurz warten.';
    case 'insufficient_ram':
      return 'Zu wenig Arbeitsspeicher auf dem Server. Später erneut versuchen.';
    case 'rate_limited':
      return `Zu viele Anfragen. Wieder möglich in ${retryMinutes(f.retryAfter)} Min.`;
    case 'invalid_input':
      return 'Eingabe ungültig.';
    case 'unavailable':
      return 'Server gerade nicht erreichbar. Später erneut versuchen.';
    case 'network':
      return 'Keine Verbindung. Die Seite versucht es weiter.';
    default:
      return 'Unerwartete Antwort. Seite neu laden.';
  }
}

export function retryMinutes(seconds: number | undefined): number {
  return Math.max(1, Math.ceil((seconds ?? 60) / 60));
}

// ---- rights -> controls ------------------------------------------------------------

export type PowerAction = 'start' | 'stop' | 'restart';

export interface Controls {
  /** Start when stopped, otherwise Stop (like the GameServer tile); null without the right. */
  power: 'start' | 'stop' | null;
  restart: boolean;
  /** busy: setup, backup or another action is running. */
  disabled: boolean;
  console: boolean;
  command: boolean;
  whitelist: boolean;
  /** M12: ask the admin to be put on the whitelist (Minecraft, links without `whitelist`). */
  whitelistRequest: boolean;
  /** M12: download the world as tar.zst. */
  worldDownload: boolean;
}

export function controlsFor(s: Pick<ShareStatus, 'perms' | 'game'>): Controls {
  const p = new Set<SharePerm>(s.perms);
  return {
    power: p.has('power') ? (s.game.status === 'off' ? 'start' : 'stop') : null,
    restart: p.has('restart'),
    disabled: s.game.status === 'busy',
    console: p.has('console_read') || p.has('console_write'),
    command: p.has('console_write'),
    whitelist: p.has('whitelist') && s.game.whitelist,
    whitelistRequest: p.has('whitelist_request') && !p.has('whitelist') && s.game.whitelist,
    worldDownload: p.has('world_download'),
  };
}

export const ACTION_TEXT: Record<PowerAction, { verb: string; done: string }> = {
  start: { verb: 'Starten', done: 'startet' },
  stop: { verb: 'Stoppen', done: 'wird gestoppt' },
  restart: { verb: 'Neu starten', done: 'startet neu' },
};

// ---- texts and numbers -----------------------------------------------------------

/** Same tags as StatusDot (packages/ui). */
export const STATUS_TAG: Record<GameStatus, string> = {
  ok: 'UP',
  warn: 'WARN',
  crit: 'DOWN',
  off: 'OFF',
  busy: 'BOOT',
};

const timeFmt = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' });

export function formatTime(d: Date): string {
  return timeFmt.format(d);
}

/** "23:04" for today, "03.12. 23:04" for other days. */
export function formatWhen(d: Date, now: Date = new Date()): string {
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return formatTime(d);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}. ${formatTime(d)}`;
}

/** M12: asleep (sleep mode); a start, or connecting if wake-on-connect is on, wakes it. */
export function isSleeping(g: Pick<ShareStatus['game'], 'status' | 'sleeping'>): boolean {
  return g.status === 'off' && g.sleeping;
}

/** "Läuft · 2 von 20 Spielern online", "Schläft – Starten weckt den Server" */
export function statusLine(g: ShareStatus['game']): string {
  if (isSleeping(g)) return 'Schläft – Starten weckt den Server';
  if (!g.players || g.status === 'off') return g.statusText;
  const { online, max } = g.players;
  return `${g.statusText} · ${online} von ${max} ${max === 1 ? 'Spieler' : 'Spielern'} online`;
}

export function expiresText(expiresAt: string | null, now: Date = new Date()): string {
  return expiresAt ? `gilt bis ${formatWhen(new Date(expiresAt), now)}` : 'läuft nicht ab';
}

// ---- M12: world download and whitelist requests ------------------------------------------

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const numFmt = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 1, useGrouping: false });

/** "7,8 GB", "512 MB", "0 B" (binary steps, like the admin app). */
export function formatBytes(bytes: number): string {
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const r = v >= 100 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${numFmt.format(r)} ${UNITS[i] ?? 'B'}`;
}

/** "1,2 GB von 3,4 GB" or "1,2 GB" without a known total. */
export function progressText(loaded: number, total: number | null): string {
  return total ? `${formatBytes(loaded)} von ${formatBytes(total)}` : formatBytes(loaded);
}

const SAFE_FILE = /^[A-Za-z0-9._-]{1,120}$/;

/**
 * File name from Content-Disposition (`attachment; filename="survival-welt.tar.zst"`),
 * only plain characters; otherwise "<game>-welt.tar.zst".
 */
export function downloadName(header: string | null, game: string): string {
  const m = header ? /filename="?([^";]+)"?/i.exec(header) : null;
  const name = m?.[1]?.trim() ?? '';
  if (SAFE_FILE.test(name) && !name.startsWith('.')) return name;
  const base = game.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'welt';
  return `${base}-welt.tar.zst`;
}

export const REQUEST_STATE_TEXT: Record<
  ShareStatus['whitelistRequests'][number]['state'],
  { status: GameStatus; text: string }
> = {
  pending: { status: 'warn', text: 'wartet auf Bestätigung' },
  approved: { status: 'ok', text: 'bestätigt' },
  rejected: { status: 'off', text: 'abgelehnt' },
};

/** Inline text for a failed world download. */
export function downloadErrorLine(f: Failure): string {
  if (f.error === 'rate_limited') {
    return `Die Welt geht nur 1× pro Stunde. Wieder möglich in ${retryMinutes(f.retryAfter)} Min.`;
  }
  if (f.error === 'unavailable') {
    return 'Download gerade nicht möglich (Server offline oder Welt zu groß). Später erneut versuchen.';
  }
  return errorLine(f);
}

const PLAYER = /^[A-Za-z0-9_]{3,16}$/;

/** Minecraft player name, same rule as sharePlayerNameSchema. */
export function playerError(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Spielernamen eingeben.';
  return PLAYER.test(n) ? null : '3 bis 16 Zeichen: Buchstaben, Ziffern und _.';
}

export function commandError(command: string): string | null {
  const c = command.trim();
  if (!c) return 'Befehl eingeben.';
  if (c.length > 200) return 'Höchstens 200 Zeichen.';
  return null;
}

export const MAX_LINES = 500;

/** Appends new console lines (deduplicated by id) and keeps the last MAX_LINES. */
export function mergeLines(
  old: readonly ConsoleLine[],
  incoming: readonly ConsoleLine[],
): ConsoleLine[] {
  const seen = new Set(old.map((l) => l.id));
  const out = [...old];
  for (const l of incoming) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    out.push(l);
  }
  return out.length > MAX_LINES ? out.slice(out.length - MAX_LINES) : out;
}

// ---- response guards (the page has no zod; same-origin answers are still checked) -----

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isStr = (x: unknown): x is string => typeof x === 'string';
const STATUSES = new Set<string>(['ok', 'warn', 'crit', 'off', 'busy']);
const PERMS = new Set<string>([
  'power',
  'restart',
  'console_read',
  'console_write',
  'whitelist',
  'whitelist_request',
  'world_download',
]);
const REQUEST_STATES = new Set<string>(['pending', 'approved', 'rejected']);

export function isShareStatus(x: unknown): x is ShareStatus {
  if (!isObj(x) || !isStr(x.person) || !Array.isArray(x.perms) || !isObj(x.game)) return false;
  if (!x.perms.every((p) => isStr(p) && PERMS.has(p))) return false;
  if (x.expiresAt !== null && !isStr(x.expiresAt)) return false;
  const g = x.game;
  if (!isStr(g.name) || !isStr(g.game) || !isStr(g.statusText)) return false;
  if (!isStr(g.status) || !STATUSES.has(g.status)) return false;
  if (g.version !== null && !isStr(g.version)) return false;
  if (g.address !== null && !isStr(g.address)) return false;
  if (typeof g.whitelist !== 'boolean' || typeof g.sleeping !== 'boolean') return false;
  if (!Array.isArray(x.whitelistRequests)) return false;
  const reqOk = x.whitelistRequests.every(
    (r) =>
      isObj(r) &&
      isStr(r.player) &&
      isStr(r.createdAt) &&
      isStr(r.state) &&
      REQUEST_STATES.has(r.state),
  );
  if (!reqOk) return false;
  if (g.players !== null) {
    const p = g.players;
    if (!isObj(p) || typeof p.online !== 'number' || typeof p.max !== 'number') return false;
    if (!Array.isArray(p.names) || !p.names.every(isStr)) return false;
  }
  return true;
}

export function isConsoleResponse(x: unknown): x is { lines: ConsoleLine[] } {
  if (!isObj(x) || !Array.isArray(x.lines)) return false;
  return x.lines.every(
    (l) =>
      isObj(l) &&
      isStr(l.id) &&
      isStr(l.text) &&
      isStr(l.ts) &&
      (l.kind === 'out' || l.kind === 'cmd' || l.kind === 'err'),
  );
}

export function isOutputResponse(x: unknown): x is { output: string } {
  return isObj(x) && isStr(x.output);
}

const CODES = new Set<string>([
  'not_found',
  'revoked',
  'expired',
  'pin_required',
  'pin_wrong',
  'locked',
  'forbidden',
  'rate_limited',
  'invalid_input',
  'busy',
  'unavailable',
  'insufficient_ram',
]);

function fallbackCode(status: number): Failure['error'] {
  if (status === 404) return 'not_found';
  if (status === 401) return 'pin_required';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'busy';
  if (status === 423) return 'locked';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'invalid_input';
  if (status === 503 || status === 502 || status === 504) return 'unavailable';
  return 'bad_response';
}

/** Error body `{ ok: false, error, retryAfter?, triesLeft? }`, or a guess from the status. */
export function failureOf(status: number, body: unknown, retryAfterHeader: string | null): Failure {
  const header = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const headerRetry = Number.isFinite(header) && header >= 0 ? Math.ceil(header) : undefined;
  if (isObj(body) && isStr(body.error) && CODES.has(body.error)) {
    return {
      status,
      error: body.error as ShareErrorCode,
      retryAfter: typeof body.retryAfter === 'number' ? body.retryAfter : headerRetry,
      triesLeft: typeof body.triesLeft === 'number' ? body.triesLeft : undefined,
    };
  }
  // 410 without a known body: gone either way; "widerrufen" is the safer word.
  if (status === 410) return { status, error: 'revoked' };
  return { status, error: fallbackCode(status), retryAfter: headerRetry };
}

import {
  CONSOLE_IDLE_MINUTES,
  CONSOLE_MAX_MINUTES,
  CONSOLE_MAX_PER_SERVER,
  consoleServerMessageSchema,
  consoleSessionListResponseSchema,
  type ConsoleClientMessage,
  type ConsoleServerMessage,
  type ContainerSummary,
  type ServerSummary,
} from '@hz/shared';
import { api } from './api.js';
import { plural } from './format.js';

/**
 * Web console (SPEC 11): wss://<host>/console?serverId=<id>[&container=<core container id>],
 * see packages/shared console-wall.ts and api/docker.ts (M23 container shell).
 */

export type ConsoleSession = ReturnType<
  typeof consoleSessionListResponseSchema.parse
>['sessions'][number];
export type ConsoleCloseReason = Extract<ConsoleServerMessage, { type: 'closed' }>['reason'];

export const consoleSessionsKey = ['console', 'sessions'] as const;

export async function fetchConsoleSessions(signal?: AbortSignal): Promise<ConsoleSession[]> {
  const res = await api('/api/console/sessions?limit=20', {
    schema: consoleSessionListResponseSchema,
    signal,
  });
  return res.sessions;
}

export function consoleUrl(
  serverId: string,
  loc: Pick<Location, 'protocol' | 'host'> = window.location,
  container?: string | null,
): string {
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  const ctr = container ? `&container=${encodeURIComponent(container)}` : '';
  return `${proto}://${loc.host}/console?serverId=${encodeURIComponent(serverId)}${ctr}`;
}

/**
 * Containers of one server a shell can open in (M23): running, not protected (hz.role
 * and the agent close with not_allowed anyway). By name.
 */
export function containerTargets(
  containers: readonly ContainerSummary[],
  serverId: string | null,
): ContainerSummary[] {
  if (!serverId) return [];
  return containers
    .filter((c) => c.serverId === serverId && c.state === 'running' && !c.protected)
    .sort((a, b) => a.name.localeCompare(b.name, 'de-AT'));
}

export interface ConsoleTarget {
  server: ServerSummary;
  usable: boolean;
  /** Why the server cannot be picked (German, shown next to the disabled entry). */
  reason: string | null;
}

/** Usable servers first (by name), then the rest with the reason. */
export function consoleTargets(servers: readonly ServerSummary[]): ConsoleTarget[] {
  const list = servers.map((server): ConsoleTarget => {
    if (!server.allowTerminal) {
      return { server, usable: false, reason: 'Konsole nicht erlaubt (Einstellungen → Server)' };
    }
    if (!server.connected) return { server, usable: false, reason: 'Agent offline' };
    return { server, usable: true, reason: null };
  });
  return list.sort(
    (a, b) => Number(b.usable) - Number(a.usable) || a.server.name.localeCompare(b.server.name),
  );
}

/** "Sitzung beendet: …" texts. Status first, then what helps. */
export function closeReasonText(reason: ConsoleCloseReason, exitCode: number | null): string {
  switch (reason) {
    case 'exit':
      return exitCode === null || exitCode === 0
        ? 'Shell beendet.'
        : `Shell beendet mit Code ${exitCode}.`;
    case 'closed':
      return 'Sitzung geschlossen.';
    case 'idle_timeout':
      return `Nach ${CONSOLE_IDLE_MINUTES} Min ohne Eingabe getrennt.`;
    case 'max_duration':
      return `Nach ${CONSOLE_MAX_MINUTES} Min getrennt. Neu verbinden startet eine neue Sitzung.`;
    case 'busy':
      return `Auf diesem Server sind schon ${CONSOLE_MAX_PER_SERVER} Konsolen offen. Eine davon schließen.`;
    case 'rate_limited':
      return 'Zu viel Eingabe auf einmal. Kurz warten und neu verbinden.';
    case 'agent_offline':
      return 'Agent offline. Verbindung zum Server verloren.';
    case 'terminal_disabled':
      return 'Konsole auf dem Agent aus. HZ_AGENT_ALLOW_TERMINAL=1 setzen und Agent neu starten.';
    case 'step_up_required':
      return 'Bestätigung mit Code nötig.';
    case 'not_allowed':
      return 'Konsole für diesen Server nicht erlaubt (Einstellungen → Server).';
    default:
      return 'Fehler in der Verbindung. Erneut verbinden.';
  }
}

/** Close text for a shell inside a container: not_allowed means a protected container there. */
export function containerCloseText(
  reason: ConsoleCloseReason,
  exitCode: number | null,
  name: string,
): string {
  if (reason === 'not_allowed') {
    return `Shell in ${name} nicht erlaubt. Zentrale, Agent und Updater sind geschützt, sonst Konsole des Servers freigeben (Einstellungen → Server).`;
  }
  if (reason === 'exit') {
    return exitCode === null || exitCode === 0
      ? `Shell in ${name} beendet.`
      : `Shell in ${name} beendet mit Code ${exitCode}.`;
  }
  return closeReasonText(reason, exitCode);
}

/** "12 Min", "1 Std 4 Min", "40 s". */
export function formatSessionDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} Min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} Std ${rest} Min` : `${h} Std`;
}

export function sessionSummary(n: number): string {
  return plural(n, 'Sitzung', 'Sitzungen');
}

export type ConsoleEvent =
  | { type: 'ready'; sessionId: string }
  | { type: 'output'; data: string }
  | { type: 'closed'; reason: ConsoleCloseReason; exitCode: number | null };

export interface ConsoleSocketOptions {
  url: string;
  cols: number;
  rows: number;
  onEvent: (e: ConsoleEvent) => void;
  /** Injected for tests. */
  createSocket?: (url: string) => WebSocket;
}

const PING_MS = 25_000;
/** Max input per message (consoleClientMessageSchema). */
export const INPUT_CHUNK = 16 * 1024;

/** Splits pasted text so every message fits the 16 KiB limit (by UTF-16 units, safe). */
export function chunkInput(data: string, size = INPUT_CHUNK / 4): string[] {
  const out: string[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.slice(i, i + size));
  return out;
}

/**
 * One console session. Sends `open` with the terminal size once the socket is open,
 * reports exactly one `closed` event (from the core, or `error` when the socket drops).
 */
export class ConsoleSocket {
  private readonly ws: WebSocket;
  private done = false;
  private ping: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: ConsoleSocketOptions) {
    this.ws = o.createSocket ? o.createSocket(o.url) : new WebSocket(o.url);
    this.ws.onopen = () => {
      this.send({ type: 'open', cols: o.cols, rows: o.rows });
      this.ping = setInterval(() => this.send({ type: 'ping' }), PING_MS);
    };
    this.ws.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);
    this.ws.onclose = () => this.finish('error', null);
    this.ws.onerror = () => undefined;
  }

  input(data: string): void {
    for (const part of chunkInput(data)) this.send({ type: 'input', data: part });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'resize', cols: clamp(cols, 10, 500), rows: clamp(rows, 5, 200) });
  }

  /** Closes on purpose; reports `closed` right away. */
  close(): void {
    if (this.done) return;
    this.send({ type: 'close' });
    this.finish('closed', null);
    this.ws.close(1000);
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: ConsoleServerMessage;
    try {
      msg = consoleServerMessageSchema.parse(JSON.parse(raw));
    } catch {
      return;
    }
    if (this.done) return;
    if (msg.type === 'ready') this.o.onEvent({ type: 'ready', sessionId: msg.sessionId });
    else if (msg.type === 'output') this.o.onEvent({ type: 'output', data: msg.data });
    else if (msg.type === 'closed') {
      this.finish(msg.reason, msg.exitCode);
      this.ws.close(1000);
    }
  }

  private finish(reason: ConsoleCloseReason, exitCode: number | null): void {
    if (this.done) return;
    this.done = true;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.o.onEvent({ type: 'closed', reason, exitCode });
  }

  private send(msg: ConsoleClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** Token names in design/tokens.css the xterm theme is built from. */
export const TERMINAL_TOKENS = {
  background: '--terminal-bg',
  foreground: '--terminal-ink',
  cursor: '--accent',
  cursorAccent: '--terminal-bg',
  selectionBackground: '--bg-300',
  red: '--crit',
  green: '--ok',
  yellow: '--warn',
  blue: '--info',
  cyan: '--info',
  magenta: '--accent-ink',
  white: '--terminal-ink',
  black: '--terminal-bg',
  brightBlack: '--off',
  brightRed: '--crit',
  brightGreen: '--ok',
  brightYellow: '--warn',
  brightBlue: '--info',
  brightCyan: '--info',
  brightMagenta: '--accent-ink',
  brightWhite: '--ink',
} as const;

export type TerminalTheme = Record<keyof typeof TERMINAL_TOKENS, string>;

/** Reads the current theme's token values (no colours in code). */
export function terminalTheme(read: (token: string) => string): TerminalTheme {
  const out = {} as TerminalTheme;
  for (const [key, token] of Object.entries(TERMINAL_TOKENS) as [keyof TerminalTheme, string][]) {
    out[key] = read(token).trim();
  }
  return out;
}

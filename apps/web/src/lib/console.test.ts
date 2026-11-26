import { describe, expect, it, vi } from 'vitest';
import { server } from '../test-fixtures.js';
import {
  chunkInput,
  closeReasonText,
  consoleTargets,
  consoleUrl,
  ConsoleSocket,
  formatSessionDuration,
  terminalTheme,
  TERMINAL_TOKENS,
  type ConsoleEvent,
} from './console.js';

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(s: string): void {
    this.sent.push(JSON.parse(s));
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  msg(m: unknown): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

function setup(): { ws: FakeSocket; events: ConsoleEvent[]; socket: ConsoleSocket } {
  vi.stubGlobal('WebSocket', { OPEN: 1 });
  const ws = new FakeSocket();
  const events: ConsoleEvent[] = [];
  const socket = new ConsoleSocket({
    url: 'ws://x/console?serverId=a',
    cols: 120,
    rows: 30,
    onEvent: (e) => events.push(e),
    createSocket: () => ws as unknown as WebSocket,
  });
  return { ws, events, socket };
}

describe('console', () => {
  it('builds the socket url from the page origin', () => {
    expect(consoleUrl('srv-1', { protocol: 'https:', host: 'zentrale.ts.net' })).toBe(
      'wss://zentrale.ts.net/console?serverId=srv-1',
    );
    expect(consoleUrl('a b', { protocol: 'http:', host: '127.0.0.1:8099' })).toBe(
      'ws://127.0.0.1:8099/console?serverId=a%20b',
    );
  });

  it('lists usable servers first and says why the others are disabled', () => {
    const list = consoleTargets([
      server({ name: 'pi', allowTerminal: false }),
      server({ name: 'oracle-a1', allowTerminal: true, connected: false }),
      server({ name: 'heimserver', allowTerminal: true, connected: true }),
    ]);
    expect(list.map((t) => [t.server.name, t.usable, t.reason])).toEqual([
      ['heimserver', true, null],
      ['oracle-a1', false, 'Agent offline'],
      ['pi', false, 'Konsole nicht erlaubt (Einstellungen → Server)'],
    ]);
  });

  it('has a German text for every close reason', () => {
    expect(closeReasonText('exit', 0)).toBe('Shell beendet.');
    expect(closeReasonText('exit', 130)).toBe('Shell beendet mit Code 130.');
    expect(closeReasonText('idle_timeout', null)).toBe('Nach 15 Min ohne Eingabe getrennt.');
    expect(closeReasonText('terminal_disabled', null)).toContain('HZ_AGENT_ALLOW_TERMINAL=1');
    expect(closeReasonText('agent_offline', null)).toMatch(/^Agent offline/);
    expect(closeReasonText('busy', null)).toBe(
      'Auf diesem Server sind schon 2 Konsolen offen. Eine davon schließen.',
    );
    expect(closeReasonText('rate_limited', null)).toMatch(/^Zu viel Eingabe/);
  });

  it('formats durations', () => {
    expect(formatSessionDuration(40)).toBe('40 s');
    expect(formatSessionDuration(12 * 60 + 5)).toBe('12 Min');
    expect(formatSessionDuration(64 * 60)).toBe('1 Std 4 Min');
    expect(formatSessionDuration(120 * 60)).toBe('2 Std');
  });

  it('splits long pastes', () => {
    const parts = chunkInput('x'.repeat(10_000), 4096);
    expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808]);
  });

  it('opens with the size, relays output and reports one close', () => {
    const { ws, events, socket } = setup();
    ws.open();
    expect(ws.sent[0]).toEqual({ type: 'open', cols: 120, rows: 30 });
    ws.msg({ type: 'ready', sessionId: 'sess_12345678' });
    ws.msg({ type: 'output', data: 'heimserver:~$ ' });
    socket.input('ls\r');
    socket.resize(3, 1000);
    expect(ws.sent.slice(1)).toEqual([
      { type: 'input', data: 'ls\r' },
      { type: 'resize', cols: 10, rows: 200 },
    ]);
    ws.msg({ type: 'closed', reason: 'idle_timeout', exitCode: null });
    ws.onclose?.();
    expect(events).toEqual([
      { type: 'ready', sessionId: 'sess_12345678' },
      { type: 'output', data: 'heimserver:~$ ' },
      { type: 'closed', reason: 'idle_timeout', exitCode: null },
    ]);
    expect(ws.closed).toBe(true);
  });

  it('ignores invalid messages and reports a dropped socket as error', () => {
    const { ws, events } = setup();
    ws.open();
    ws.msg({ type: 'output', data: 1 });
    ws.onmessage?.({ data: 'not json' });
    ws.onclose?.();
    expect(events).toEqual([{ type: 'closed', reason: 'error', exitCode: null }]);
  });

  it('closing on purpose sends close and reports closed', () => {
    const { ws, events, socket } = setup();
    ws.open();
    socket.close();
    expect(ws.sent.at(-1)).toEqual({ type: 'close' });
    expect(events).toEqual([{ type: 'closed', reason: 'closed', exitCode: null }]);
  });

  it('builds the xterm theme only from design tokens', () => {
    const read = (t: string): string => ` value-of(${t}) `;
    const theme = terminalTheme(read);
    expect(theme.background).toBe('value-of(--terminal-bg)');
    expect(theme.cursor).toBe('value-of(--accent)');
    for (const token of Object.values(TERMINAL_TOKENS)) expect(token).toMatch(/^--[a-z0-9-]+$/);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_IDLE_MINUTES,
  CONSOLE_INPUT_MAX_MESSAGES,
  CONSOLE_MAX_MINUTES,
  LIVE_CLOSE_SESSION_ENDED,
  consoleServerMessageSchema,
} from '@hz/shared';
import {
  WsClient,
  enrollAgent,
  helloMsg,
  listen,
  stepUp,
  until,
  type Received,
} from './agent-helpers.js';
import { HOST, authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.app.close();
  t = undefined;
});

const MIN = 60_000;
const SECRET_INPUT = 'echo geheim-tastendruck-4711';
const SECRET_OUTPUT = 'ausgabe-nur-im-terminal-0815';

interface Env {
  t: TestApp;
  url: string;
  cookie: string;
  secret: string;
  serverId: string;
  agent: WsClient;
}

async function track(c: Promise<WsClient>): Promise<WsClient> {
  const ws = await c;
  clients.push(ws);
  return ws;
}

/**
 * Admin + a connected agent with the terminal capability. By default with a
 * step-up and allowTerminal on.
 */
async function setup(
  opts: { terminal?: boolean; allow?: boolean; stepUp?: boolean } = {},
): Promise<Env> {
  const app = await makeApp({ captureLogs: true });
  t = app;
  const url = await listen(app);
  const { cookie, secret } = await completeSetup(app);
  const first = await enrollAgent(app, url, cookie);
  first.agent.close();
  await until(() => !app.app.hzCore.hub.isConnected(first.serverId));
  const agent = await track(WsClient.connect(`${url}/agent`));
  agent.send(
    helloMsg(first.agentToken, {
      capabilities: { terminal: opts.terminal ?? true, docker: true },
    }),
  );
  await agent.nextOfType('welcome');
  if (opts.allow ?? true) {
    await stepUp(t, secret, cookie);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/servers/${first.serverId}`,
      headers: authHeaders(cookie),
      payload: { allowTerminal: true },
    });
    expect(res.statusCode).toBe(200);
  }
  if (opts.stepUp ?? true) await stepUp(t, secret, cookie);
  else {
    // Let any earlier step-up run out.
    t.clock.advance(16 * MIN);
  }
  return { t, url, cookie, secret, serverId: first.serverId, agent };
}

function consoleUrl(e: Env, serverId = e.serverId): string {
  return `${e.url}/console?serverId=${serverId}`;
}

async function openBrowser(e: Env, serverId = e.serverId): Promise<WsClient> {
  return track(WsClient.connect(consoleUrl(e, serverId), authHeaders(e.cookie)));
}

/** Browser sends open, fake agent confirms; returns the pty.open rpc. */
async function openConsole(e: Env, browser: WsClient): Promise<{ rpc: Received; ready: Received }> {
  browser.send({ type: 'open', cols: 120, rows: 40 });
  const rpc = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.open');
  e.agent.send({ type: 'rpc.result', id: rpc.id, ok: true, data: { streamId: rpc.id } });
  const ready = await browser.nextOfType('ready');
  return { rpc, ready };
}

async function closedOf(browser: WsClient): Promise<Received> {
  const m = await browser.nextOfType('closed');
  expect(consoleServerMessageSchema.safeParse(m).success).toBe(true);
  return m;
}

function sessionsRows(e: Env): Record<string, unknown>[] {
  return e.t.db.sqlite.prepare('SELECT * FROM console_sessions').all() as Record<string, unknown>[];
}

function dumpDb(e: Env): string {
  const tables = e.t.db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  return tables
    .map(({ name }) => JSON.stringify(e.t.db.sqlite.prepare(`SELECT * FROM "${name}"`).all()))
    .join('\n');
}

describe('console: upgrade gate', () => {
  it('needs a session, the same Origin and a valid query before the handshake', async () => {
    const e = await setup();
    expect(await WsClient.status(consoleUrl(e))).toBe(401);
    expect(
      await WsClient.status(consoleUrl(e), {
        host: HOST,
        origin: 'https://evil.example',
        cookie: `hz_session=${e.cookie}`,
      }),
    ).toBe(403);
    expect(
      await WsClient.status(consoleUrl(e), { cookie: `hz_session=${e.cookie}`, host: HOST }),
    ).toBe(403);
    expect(await WsClient.status(`${e.url}/console`, authHeaders(e.cookie))).toBe(400);
    expect(
      await WsClient.status(`${e.url}/console?serverId=${'x'.repeat(65)}`, authHeaders(e.cookie)),
    ).toBe(400);
    expect(await WsClient.status(consoleUrl(e), authHeaders(e.cookie))).toBe(101);
  });

  it('a plain GET /console is the web page, not the socket', async () => {
    const e = await setup();
    const res = await e.t.app.inject({ method: 'GET', url: `/console?serverId=${e.serverId}` });
    // No web build in tests: the SPA fallback answers 404, but never 401 or an upgrade.
    expect(res.statusCode).toBe(404);
  });
});

describe('console: refusals', () => {
  it('without step-up: closed step_up_required, nothing reaches the agent', async () => {
    const e = await setup({ stepUp: false });
    const b = await openBrowser(e);
    const m = await closedOf(b);
    expect(m).toMatchObject({ reason: 'step_up_required', exitCode: null });
    await b.closed;
    expect(e.agent.received.some((x) => x.type === 'rpc')).toBe(false);
    expect(sessionsRows(e)).toEqual([]);
  });

  it('without allowTerminal: closed not_allowed', async () => {
    const e = await setup({ allow: false });
    const b = await openBrowser(e);
    expect(await closedOf(b)).toMatchObject({ reason: 'not_allowed' });
  });

  it('unknown server: closed not_allowed', async () => {
    const e = await setup();
    const b = await openBrowser(e, 'AAAAAAAAAAAAAAAAAAAAAA');
    expect(await closedOf(b)).toMatchObject({ reason: 'not_allowed' });
  });

  it('agent offline: closed agent_offline', async () => {
    const e = await setup();
    e.agent.close();
    await until(() => !e.t.app.hzCore.hub.isConnected(e.serverId));
    const b = await openBrowser(e);
    expect(await closedOf(b)).toMatchObject({ reason: 'agent_offline' });
  });

  it('agent without HZ_AGENT_ALLOW_TERMINAL: closed terminal_disabled', async () => {
    const e = await setup({ terminal: false });
    const b = await openBrowser(e);
    expect(await closedOf(b)).toMatchObject({ reason: 'terminal_disabled' });
  });

  it('the step-up is checked again at open', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    e.t.clock.advance(16 * MIN);
    b.send({ type: 'open', cols: 80, rows: 24 });
    expect(await closedOf(b)).toMatchObject({ reason: 'step_up_required' });
  });
});

describe('console: session', () => {
  it('bridges open/output/input/resize/exit and logs no content', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    const { rpc, ready } = await openConsole(e, b);
    expect(rpc.params).toEqual({ cols: 120, rows: 40 });
    expect(ready.sessionId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);

    e.agent.send({
      type: 'stream.data',
      streamId: rpc.id,
      channel: 'stdout',
      chunk: SECRET_OUTPUT,
    });
    expect(await b.nextOfType('output')).toEqual({ type: 'output', data: SECRET_OUTPUT });

    b.send({ type: 'input', data: SECRET_INPUT });
    const input = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.input');
    expect(input.params).toEqual({ streamId: rpc.id, data: SECRET_INPUT });
    e.agent.send({ type: 'rpc.result', id: input.id, ok: true, data: null });

    b.send({ type: 'resize', cols: 100, rows: 30 });
    const resize = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.resize');
    expect(resize.params).toEqual({ streamId: rpc.id, cols: 100, rows: 30 });

    b.send({ type: 'ping' });
    await b.nextOfType('pong');

    e.t.clock.advance(5_000);
    e.agent.send({ type: 'stream.end', streamId: rpc.id, code: 0 });
    expect(await closedOf(b)).toEqual({ type: 'closed', reason: 'exit', exitCode: 0 });
    await b.closed;

    const rows = sessionsRows(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: ready.sessionId,
      server_id: e.serverId,
      reason: 'exit',
      bytes_in: Buffer.byteLength(SECRET_INPUT),
      bytes_out: Buffer.byteLength(SECRET_OUTPUT),
    });
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      ['bytes_in', 'bytes_out', 'ended_at', 'id', 'ip', 'reason', 'server_id', 'started_at'].sort(),
    );
    const actions = (
      e.t.db.sqlite.prepare("SELECT action FROM audit_log WHERE action LIKE 'console.%'").all() as {
        action: string;
      }[]
    ).map((r) => r.action);
    expect(actions).toEqual(['console.open', 'console.close']);

    // Neither keystrokes nor output in the database or the log.
    const db = dumpDb(e);
    const logs = e.t.logs.join('');
    for (const s of [SECRET_INPUT, 'geheim-tastendruck', SECRET_OUTPUT]) {
      expect(db).not.toContain(s);
      expect(logs).not.toContain(s);
    }

    const list = await e.t.app.inject({
      method: 'GET',
      url: '/api/console/sessions',
      headers: authHeaders(e.cookie),
    });
    expect(list.statusCode).toBe(200);
    const s = list.json<{ sessions: Record<string, unknown>[] }>().sessions;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      id: ready.sessionId,
      serverName: 'heimserver',
      reason: 'exit',
      durationSec: 5,
    });
  });

  it('the browser closing hangs up the pty (pty.close)', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    const { rpc } = await openConsole(e, b);
    b.send({ type: 'close' });
    expect(await closedOf(b)).toMatchObject({ reason: 'closed' });
    const close = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.close');
    expect(close.params).toEqual({ streamId: rpc.id });
    expect(sessionsRows(e)[0]).toMatchObject({ reason: 'closed' });
  });

  it('maps the agent limits and a lost agent to close reasons', async () => {
    const e = await setup();
    const b1 = await openBrowser(e);
    const one = await openConsole(e, b1);
    e.agent.send({ type: 'stream.end', streamId: one.rpc.id, code: -1, error: 'idle_timeout' });
    expect(await closedOf(b1)).toMatchObject({ reason: 'idle_timeout', exitCode: null });

    const b2 = await openBrowser(e);
    const two = await openConsole(e, b2);
    e.agent.send({ type: 'stream.end', streamId: two.rpc.id, code: -1, error: 'max_duration' });
    expect(await closedOf(b2)).toMatchObject({ reason: 'max_duration' });

    const b3 = await openBrowser(e);
    await openConsole(e, b3);
    e.agent.close();
    expect(await closedOf(b3)).toMatchObject({ reason: 'agent_offline' });
  });

  it('an agent error on pty.open closes with the reason', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    b.send({ type: 'open', cols: 80, rows: 24 });
    const rpc = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.open');
    e.agent.send({
      type: 'rpc.result',
      id: rpc.id,
      ok: false,
      error: { code: 'terminal_disabled', message: 'off' },
    });
    expect(await closedOf(b)).toMatchObject({ reason: 'terminal_disabled' });
  });

  it('closes when the admin logs out (session revoked)', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    const res = await e.t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: authHeaders(e.cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(await closedOf(b)).toMatchObject({ reason: 'closed' });
    expect((await b.closed).code).toBe(LIVE_CLOSE_SESSION_ENDED);
    await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.close');
  });

  it('closes when allowTerminal is switched off', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    const res = await e.t.app.inject({
      method: 'PATCH',
      url: `/api/servers/${e.serverId}`,
      headers: authHeaders(e.cookie),
      payload: { allowTerminal: false },
    });
    expect(res.statusCode).toBe(200);
    e.t.app.hzCore.consoles.check();
    expect(await closedOf(b)).toMatchObject({ reason: 'not_allowed' });
  });
});

describe('console: limits', () => {
  it('one open per socket', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    b.send({ type: 'open', cols: 80, rows: 24 });
    b.send({ type: 'ping' });
    await b.nextOfType('pong');
    expect(
      e.agent.received.filter((m) => m.type === 'rpc' && m.action === 'pty.open'),
    ).toHaveLength(1);
  });

  it('at most 2 consoles per server', async () => {
    const e = await setup();
    await openConsole(e, await openBrowser(e));
    await openConsole(e, await openBrowser(e));
    const third = await openBrowser(e);
    expect(await closedOf(third)).toMatchObject({ reason: 'busy' });
    expect(e.t.app.hzCore.consoles.activeCount(e.serverId)).toBe(2);
  });

  it('drops input over 16 KiB and invalid messages; too many invalid close the socket', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    b.send({ type: 'input', data: 'x'.repeat(16 * 1024 + 1) });
    b.send({ type: 'input', data: '' });
    b.send({ type: 'nope' });
    b.sendRaw('{not json');
    b.send({ type: 'ping' });
    await b.nextOfType('pong');
    expect(e.agent.received.some((m) => m.type === 'rpc' && m.action === 'pty.input')).toBe(false);
    for (let i = 0; i < 20; i++) b.send({ type: 'nope' });
    expect(await closedOf(b)).toMatchObject({ reason: 'error' });
  });

  it('accepts a full 16 KiB paste of control characters (JSON escaped)', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    b.send({ type: 'input', data: '\u0001'.repeat(16 * 1024) });
    const input = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.input');
    expect((input.params as { data: string }).data).toHaveLength(16 * 1024);
  });

  it('an input flood closes with rate_limited', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    for (let i = 0; i <= CONSOLE_INPUT_MAX_MESSAGES; i++) b.send({ type: 'input', data: 'a' });
    expect(await closedOf(b)).toMatchObject({ reason: 'rate_limited' });
  });

  it(`closes after ${CONSOLE_IDLE_MINUTES} min without input`, async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    e.t.clock.advance(CONSOLE_IDLE_MINUTES * MIN - 1000);
    e.t.app.hzCore.consoles.check();
    b.send({ type: 'ping' });
    await b.nextOfType('pong');
    e.t.clock.advance(1000);
    e.t.app.hzCore.consoles.check();
    expect(await closedOf(b)).toMatchObject({ reason: 'idle_timeout' });
    await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.close');
  });

  it(`closes after ${CONSOLE_MAX_MINUTES} min in total, even with input`, async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    for (let i = 0; i < CONSOLE_MAX_MINUTES / 10; i++) {
      e.t.clock.advance(10 * MIN);
      b.send({ type: 'input', data: 'l' });
      const input = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.input');
      e.agent.send({ type: 'rpc.result', id: input.id, ok: true, data: null });
      e.t.app.hzCore.consoles.check();
    }
    expect(await closedOf(b)).toMatchObject({ reason: 'max_duration' });
  });

  it('a socket that never sends open is closed', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    e.t.clock.advance(31_000);
    e.t.app.hzCore.consoles.check();
    expect(await closedOf(b)).toMatchObject({ reason: 'idle_timeout' });
  });

  it('terminal output has its own agent budget (no flood close)', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    const { rpc } = await openConsole(e, b);
    for (let i = 0; i < 700; i++) {
      e.agent.send({ type: 'stream.data', streamId: rpc.id, channel: 'stdout', chunk: 'x' });
    }
    await until(() => b.received.filter((m) => m.type === 'output').length === 700, 5000);
    expect(e.t.app.hzCore.hub.isConnected(e.serverId)).toBe(true);
  });

  it('results of 700 inputs count against the terminal budget, not the general one', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    for (let i = 0; i < 700; i++) {
      b.send({ type: 'input', data: 'j' });
      const input = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.input');
      e.agent.send({ type: 'rpc.result', id: input.id, ok: true, data: null });
      // Stay below the per-console input limit of the core.
      if (i % 300 === 299) e.t.clock.advance(11_000);
    }
    b.send({ type: 'ping' });
    await b.nextOfType('pong');
    expect(e.t.app.hzCore.hub.isConnected(e.serverId)).toBe(true);
    expect(b.received.some((m) => m.type === 'closed')).toBe(false);
  });

  it('keys typed while an input call runs are joined in order; resize is coalesced', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    b.send({ type: 'input', data: 'a' });
    const first = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.input');
    b.send({ type: 'input', data: 'b' });
    b.send({ type: 'input', data: 'c' });
    b.send({ type: 'resize', cols: 90, rows: 20 });
    b.send({ type: 'resize', cols: 120, rows: 40 });
    b.send({ type: 'ping' });
    await b.nextOfType('pong');
    e.agent.send({ type: 'rpc.result', id: first.id, ok: true, data: null });
    const second = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.input');
    expect(second.params).toMatchObject({ data: 'bc' });
    e.agent.send({ type: 'rpc.result', id: second.id, ok: true, data: null });
    const resize = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.resize');
    expect(resize.params).toMatchObject({ cols: 120, rows: 40 });
  });

  it('input the agent refuses with busy is retried, never dropped', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    b.send({ type: 'input', data: 'ls\r' });
    const first = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.input');
    e.agent.send({
      type: 'rpc.result',
      id: first.id,
      ok: false,
      error: { code: 'busy', message: 'busy' },
    });
    const again = await e.agent.next(
      (m) => m.type === 'rpc' && m.action === 'pty.input' && m.id !== first.id,
    );
    expect(again.params).toMatchObject({ data: 'ls\r' });
  });

  it('input that fails otherwise ends the console with error', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    b.send({ type: 'input', data: 'x' });
    const input = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.input');
    e.agent.send({
      type: 'rpc.result',
      id: input.id,
      ok: false,
      error: { code: 'not_found', message: 'gone' },
    });
    expect(await closedOf(b)).toMatchObject({ reason: 'error' });
  });

  it('sessions left open by a crash are closed on start', async () => {
    const e = await setup();
    const b = await openBrowser(e);
    await openConsole(e, b);
    expect(e.t.app.hzCore.consoles.recover()).toBe(1);
    expect(sessionsRows(e)[0]).toMatchObject({ reason: 'error' });
  });
});

describe('GET /api/console/sessions', () => {
  it('needs a session and a valid query', async () => {
    const e = await setup();
    expect((await e.t.app.inject({ method: 'GET', url: '/api/console/sessions' })).statusCode).toBe(
      401,
    );
    for (const q of ['limit=0', 'limit=201', 'foo=1']) {
      const res = await e.t.app.inject({
        method: 'GET',
        url: `/api/console/sessions?${q}`,
        headers: authHeaders(e.cookie),
      });
      expect(res.statusCode, q).toBe(400);
    }
    const ok = await e.t.app.inject({
      method: 'GET',
      url: `/api/console/sessions?serverId=${e.serverId}&limit=5`,
      headers: authHeaders(e.cookie),
    });
    expect(ok.json()).toEqual({ sessions: [] });
  });
});

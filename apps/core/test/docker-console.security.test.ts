import { afterEach, describe, expect, it } from 'vitest';
import { consoleServerMessageSchema } from '@hz/shared';
import {
  WsClient,
  enrollAgent,
  helloMsg,
  inventoryMsg,
  listen,
  stepUp,
  until,
  type Received,
} from './agent-helpers.js';
import { containerByName, info, insertServer, inventory } from './container-helpers.js';
import { authHeaders, completeSetup, makeApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.app.close();
  t = undefined;
});

interface Env {
  t: TestApp;
  url: string;
  cookie: string;
  serverId: string;
  agent: WsClient;
}

async function track(c: Promise<WsClient>): Promise<WsClient> {
  const ws = await c;
  clients.push(ws);
  return ws;
}

/** Admin with step-up, an agent with the terminal capability, allowTerminal on, containers. */
async function setup(opts: { stepUp?: boolean } = {}): Promise<Env> {
  const app = await makeApp({ captureLogs: true });
  t = app;
  const url = await listen(app);
  const { cookie, secret } = await completeSetup(app);
  const first = await enrollAgent(app, url, cookie);
  first.agent.close();
  await until(() => !app.app.hzCore.hub.isConnected(first.serverId));
  const agent = await track(WsClient.connect(`${url}/agent`));
  agent.send(helloMsg(first.agentToken, { capabilities: { terminal: true, docker: true } }));
  await agent.nextOfType('welcome');
  agent.send(
    inventoryMsg({
      containers: [info('nextcloud'), info('hz-agent', { role: 'agent' })],
    }),
  );
  await until(() => app.app.hzCore.containers.list(first.serverId).length === 2);
  await stepUp(app, secret, cookie);
  const res = await app.app.inject({
    method: 'PATCH',
    url: `/api/servers/${first.serverId}`,
    headers: authHeaders(cookie),
    payload: { allowTerminal: true },
  });
  expect(res.statusCode).toBe(200);
  if (opts.stepUp === false) app.clock.advance(16 * 60_000);
  return { t: app, url, cookie, serverId: first.serverId, agent };
}

const browser = (e: Env, container: string, serverId = e.serverId) =>
  track(
    WsClient.connect(
      `${e.url}/console?serverId=${serverId}&container=${container}`,
      authHeaders(e.cookie),
    ),
  );

async function closedOf(b: WsClient): Promise<Received> {
  const m = await b.nextOfType('closed');
  expect(consoleServerMessageSchema.safeParse(m).success).toBe(true);
  return m;
}

const ptyOpens = (e: Env) =>
  e.agent.received.filter((m) => m.type === 'rpc' && m.action === 'pty.open');

function idOf(e: Env, name: string, serverId?: string): string {
  const c = containerByName(e.t, name, serverId);
  if (!c) throw new Error(`missing ${name}`);
  return c.id;
}

describe('console into a container', () => {
  it('pty.open gets the docker id; the audit entry names the container', async () => {
    const e = await setup();
    const b = await browser(e, idOf(e, 'nextcloud'));
    b.send({ type: 'open', cols: 100, rows: 30 });
    const rpc = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.open');
    expect(rpc.params).toEqual({ cols: 100, rows: 30, container: info('nextcloud').dockerId });
    e.agent.send({ type: 'rpc.result', id: rpc.id, ok: true, data: { streamId: rpc.id } });
    await b.nextOfType('ready');
    const audit = e.t.db.sqlite
      .prepare("SELECT target, details_json AS d FROM audit_log WHERE action = 'console.open'")
      .all() as { target: string; d: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]?.target).toBe(e.serverId);
    expect(JSON.parse(audit[0]?.d ?? '{}')).toMatchObject({
      container: 'nextcloud',
      containerId: idOf(e, 'nextcloud'),
    });
    // The session row is logged like a host console.
    expect(e.t.db.sqlite.prepare('SELECT server_id AS s FROM console_sessions').all()).toEqual([
      { s: e.serverId },
    ]);
  });

  it('without a container: pty.open has no container field (host console)', async () => {
    const e = await setup();
    const b = await track(
      WsClient.connect(`${e.url}/console?serverId=${e.serverId}`, authHeaders(e.cookie)),
    );
    b.send({ type: 'open', cols: 100, rows: 30 });
    const rpc = await e.agent.next((m) => m.type === 'rpc' && m.action === 'pty.open');
    expect(rpc.params).toEqual({ cols: 100, rows: 30 });
  });

  it('a protected container (hz.role) closes with not_allowed', async () => {
    const e = await setup();
    const b = await browser(e, idOf(e, 'hz-agent'));
    const closed = await closedOf(b);
    expect(closed.reason).toBe('not_allowed');
    b.send({ type: 'open', cols: 100, rows: 30 });
    await new Promise((r) => setTimeout(r, 40));
    expect(ptyOpens(e)).toEqual([]);
  });

  it('a container of another server closes with not_allowed', async () => {
    const e = await setup();
    const other = insertServer(e.t, 'pi');
    inventory(e.t, other, [info('fremd')]);
    const b = await browser(e, idOf(e, 'fremd', other));
    expect((await closedOf(b)).reason).toBe('not_allowed');
    await new Promise((r) => setTimeout(r, 40));
    expect(ptyOpens(e)).toEqual([]);
  });

  it('an unknown container closes with not_allowed', async () => {
    const e = await setup();
    const b = await browser(e, 'A'.repeat(22));
    expect((await closedOf(b)).reason).toBe('not_allowed');
  });

  it('a malformed container id is refused before the handshake (400)', async () => {
    const e = await setup();
    expect(
      await WsClient.status(
        `${e.url}/console?serverId=${e.serverId}&container=..%2Fx`,
        authHeaders(e.cookie),
      ),
    ).toBe(400);
  });

  it('step-up is still required', async () => {
    const e = await setup({ stepUp: false });
    const b = await browser(e, idOf(e, 'nextcloud'));
    expect((await closedOf(b)).reason).toBe('step_up_required');
    expect(ptyOpens(e)).toEqual([]);
  });
});

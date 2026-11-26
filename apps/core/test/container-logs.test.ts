import { afterEach, describe, expect, it } from 'vitest';
import { logLineSchema, logSnapshotSchema, type LogLine } from '@hz/shared';
import {
  LOG_BUFFER_LINES,
  LOG_LINE_MAX_CHARS,
  LOG_RESTART_MIN_MS,
  LOG_TAIL,
} from '../src/containers/logs.js';
import { inventoryMsg, until, WsClient, type Received } from './agent-helpers.js';
import { containerByName, info, withAgent, type AgentSetup } from './container-helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp | undefined;
const clients: WsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await t?.app.close();
  t = undefined;
});

async function setup(): Promise<AgentSetup & { id: string; dockerId: string; topic: string }> {
  const s = await withAgent(clients);
  t = s.t;
  const ha = containerByName(s.t, 'homeassistant');
  if (!ha) throw new Error('missing');
  return { ...s, id: ha.id, dockerId: ha.dockerId, topic: `container-logs:${ha.id}` };
}

async function browser(s: AgentSetup): Promise<WsClient> {
  const c = await WsClient.connect(`${s.url}/live`, {
    cookie: `hz_session=${s.cookie}`,
    origin: s.url.replace('ws://', 'http://'),
  });
  clients.push(c);
  return c;
}

const logRpcs = (s: AgentSetup): Received[] => s.rpcs.filter((r) => r.action === 'container.logs');
const cancels = (s: AgentSetup): Received[] =>
  s.agent.received.filter((m) => m.type === 'stream.cancel');

/** Collects all upserted lines of the topic until `n` lines arrived. */
async function linesFrom(c: WsClient, topic: string, n: number): Promise<LogLine[]> {
  const out: LogLine[] = [];
  while (out.length < n) {
    const m = await c.next((x) => x.type === 'update' && x.topic === topic);
    for (const l of m.upsert as unknown[]) out.push(logLineSchema.parse(l));
  }
  return out;
}

describe('live topic container-logs:<id>', () => {
  it('first subscriber starts the stream, lines get a seq, last one leaving cancels it', async () => {
    const s = await setup();
    const a = await browser(s);
    a.send({ type: 'subscribe', topics: [s.topic] });
    const snap = await a.nextOfType('snapshot');
    expect(logSnapshotSchema.parse(snap.data)).toEqual({ lines: [], ended: false });
    await until(() => logRpcs(s).length === 1);
    const rpc = logRpcs(s)[0];
    expect(rpc?.params).toEqual({ id: s.dockerId, tail: LOG_TAIL, follow: true });
    const streamId = rpc?.id as string;

    s.agent.send({ type: 'stream.data', streamId, channel: 'stdout', chunk: 'one\ntwo\r\nthr' });
    s.agent.send({ type: 'stream.data', streamId, channel: 'stderr', chunk: 'err\n' });
    s.agent.send({ type: 'stream.data', streamId, channel: 'stdout', chunk: 'ee\n' });
    expect(await linesFrom(a, s.topic, 4)).toEqual([
      { seq: 0, stream: 'stdout', text: 'one' },
      { seq: 1, stream: 'stdout', text: 'two' },
      { seq: 2, stream: 'stderr', text: 'err' },
      { seq: 3, stream: 'stdout', text: 'three' },
    ]);

    // A second subscriber gets the lines so far; no second stream.
    const b = await browser(s);
    b.send({ type: 'subscribe', topics: [s.topic] });
    const snapB = logSnapshotSchema.parse((await b.nextOfType('snapshot')).data);
    expect(snapB.lines.map((l) => l.text)).toEqual(['one', 'two', 'err', 'three']);
    expect(logRpcs(s)).toHaveLength(1);

    a.send({ type: 'unsubscribe', topics: [s.topic] });
    await new Promise((r) => setTimeout(r, 30));
    expect(cancels(s)).toEqual([]);
    b.close();
    const cancel = await s.agent.nextOfType('stream.cancel');
    expect(cancel).toEqual({ type: 'stream.cancel', streamId });
    expect(s.t.app.hzCore.logs.activeTopics).toEqual([]);

    // A new subscriber starts a fresh stream with tail 500 again.
    a.send({ type: 'subscribe', topics: [s.topic] });
    expect(logSnapshotSchema.parse((await a.nextOfType('snapshot')).data).lines).toEqual([]);
    await until(() => logRpcs(s).length === 2);
  });

  it('keeps a ring buffer of 2000 lines and cuts long lines', async () => {
    const s = await setup();
    const a = await browser(s);
    a.send({ type: 'subscribe', topics: [s.topic] });
    await a.nextOfType('snapshot');
    await until(() => logRpcs(s).length === 1);
    const streamId = logRpcs(s)[0]?.id as string;
    const total = LOG_BUFFER_LINES + 100;
    const chunk = Array.from({ length: total }, (_, i) => `line ${i}`).join('\n') + '\n';
    s.agent.send({ type: 'stream.data', streamId, channel: 'stdout', chunk });
    s.agent.send({
      type: 'stream.data',
      streamId,
      channel: 'stdout',
      chunk: 'x'.repeat(20_000) + '\n',
    });
    // One batch carries at most the buffer size, so wait for the last seq.
    for (;;) {
      const m = await a.next((x) => x.type === 'update' && x.topic === s.topic);
      if ((m.upsert as LogLine[]).some((l) => l.seq === total)) break;
    }

    const b = await browser(s);
    b.send({ type: 'subscribe', topics: [s.topic] });
    const snap = logSnapshotSchema.parse((await b.nextOfType('snapshot')).data);
    expect(snap.lines).toHaveLength(LOG_BUFFER_LINES);
    expect(snap.lines[0]).toEqual({ seq: 101, stream: 'stdout', text: 'line 101' });
    const last = snap.lines.at(-1);
    expect(last?.seq).toBe(total);
    expect(last?.text.length).toBe(LOG_LINE_MAX_CHARS);
    expect(last?.text.endsWith('[gekürzt]')).toBe(true);
  });

  it('stream end sends a snapshot with ended; a recreated container is followed again', async () => {
    const s = await setup();
    const a = await browser(s);
    a.send({ type: 'subscribe', topics: [s.topic] });
    await a.nextOfType('snapshot');
    await until(() => logRpcs(s).length === 1);
    const streamId = logRpcs(s)[0]?.id as string;
    s.agent.send({ type: 'stream.data', streamId, channel: 'stdout', chunk: 'bye' });
    s.agent.send({ type: 'stream.end', streamId, code: 0 });
    const ended = logSnapshotSchema.parse((await a.nextOfType('snapshot')).data);
    expect(ended).toEqual({ lines: [{ seq: 0, stream: 'stdout', text: 'bye' }], ended: true });

    s.t.clock.advance(LOG_RESTART_MIN_MS);
    const newId = 'cd'.repeat(32);
    s.agent.send(inventoryMsg({ containers: [info('homeassistant', { dockerId: newId })] }));
    await until(() => logRpcs(s).length === 2);
    expect(logRpcs(s)[1]?.params).toEqual({ id: newId, tail: 0, follow: true });
    const resumed = logSnapshotSchema.parse((await a.nextOfType('snapshot')).data);
    expect(resumed.ended).toBe(false);
    expect(resumed.lines.map((l) => l.text)).toEqual(['bye']);
  });

  it('offline agent: snapshot ended, no stream; unknown container: unknown_topic', async () => {
    const s = await setup();
    s.agent.close();
    await until(() => !s.t.app.hzCore.hub.isConnected(s.serverId));
    const a = await browser(s);
    a.send({ type: 'subscribe', topics: [s.topic] });
    expect(logSnapshotSchema.parse((await a.nextOfType('snapshot')).data)).toEqual({
      lines: [],
      ended: true,
    });
    a.send({ type: 'subscribe', topics: ['container-logs:BBBBBBBBBBBBBBBBBBBBBB'] });
    expect(await a.nextOfType('error')).toEqual({ type: 'error', code: 'unknown_topic' });
    expect(logRpcs(s)).toEqual([]);
  });

  it('agent disconnect ends the stream for subscribers', async () => {
    const s = await setup();
    const a = await browser(s);
    a.send({ type: 'subscribe', topics: [s.topic] });
    await a.nextOfType('snapshot');
    await until(() => logRpcs(s).length === 1);
    s.agent.close();
    const snap = logSnapshotSchema.parse((await a.nextOfType('snapshot')).data);
    expect(snap.ended).toBe(true);
  });
});

import type {
  Alert,
  CheckSummary,
  ContainerSummary,
  GameSummary,
  RepoSummary,
  ServerDetail,
  ServerSummary,
} from '@hz/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alert,
  check,
  container,
  deploy,
  detail,
  game,
  repo,
  server,
  target,
} from '../test-fixtures.js';
import { backupsKey, gameEventsKey, gamesKey, type GameEventBuffer } from './games.js';
import { deployLogKey, reposKey, type DeployLogBuffer } from './github.js';
import { checksKey } from './checks.js';
import { alertsKey } from './alerts.js';
import { containersKey } from './containers.js';
import { containerLogsKey, type LogBuffer } from './logs.js';
import {
  applyLiveMessage,
  backoffMs,
  LiveClient,
  liveUrl,
  mergeById,
  parseLiveFrame,
} from './live.js';
import { serverKey, serversKey } from './servers.js';

describe('mergeById', () => {
  it('upserts by id, keeps order, removes', () => {
    const list = [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
    ];
    expect(
      mergeById(
        list,
        [
          { id: 'b', v: 2 },
          { id: 'c', v: 1 },
        ],
        ['a'],
      ),
    ).toEqual([
      { id: 'b', v: 2 },
      { id: 'c', v: 1 },
    ]);
    expect(mergeById(undefined, [{ id: 'x' }])).toEqual([{ id: 'x' }]);
    expect(list).toHaveLength(2);
  });
});

describe('parseLiveFrame', () => {
  it('accepts valid frames only', () => {
    expect(parseLiveFrame('{"type":"pong"}')).toEqual({ type: 'pong' });
    expect(parseLiveFrame('not json')).toBeNull();
    expect(parseLiveFrame('{"type":"evil"}')).toBeNull();
    expect(parseLiveFrame({})).toBeNull();
  });
});

describe('applyLiveMessage', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient();
  });

  it('writes the servers snapshot and merges updates', () => {
    const a = server({ name: 'a' });
    const b = server({ name: 'b' });
    applyLiveMessage(qc, { type: 'snapshot', topic: 'servers', data: [a, b] });
    expect(qc.getQueryData<ServerSummary[]>(serversKey)?.map((s) => s.name)).toEqual(['a', 'b']);

    const b2 = { ...b, status: 'crit' as const, connected: false };
    const c = server({ name: 'c' });
    applyLiveMessage(qc, { type: 'update', topic: 'servers', upsert: [b2, c], remove: [a.id] });
    const list = qc.getQueryData<ServerSummary[]>(serversKey) ?? [];
    expect(list.map((s) => [s.name, s.status])).toEqual([
      ['b', 'crit'],
      ['c', 'ok'],
    ]);
  });

  it('accepts a snapshot wrapped as { servers }', () => {
    applyLiveMessage(qc, { type: 'snapshot', topic: 'servers', data: { servers: [server()] } });
    expect(qc.getQueryData<ServerSummary[]>(serversKey)).toHaveLength(1);
  });

  it('drops invalid items and refetches instead', () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const ok = server();
    applyLiveMessage(qc, {
      type: 'update',
      topic: 'servers',
      upsert: [ok, { id: 'x', name: 'Bad Name' }],
    });
    expect(qc.getQueryData<ServerSummary[]>(serversKey)).toEqual([ok]);
    expect(spy).toHaveBeenCalledWith({ queryKey: serversKey, exact: true });
  });

  it('keeps the summary inside a cached detail in step', () => {
    const s = server();
    qc.setQueryData(serverKey(s.id), detail(s));
    applyLiveMessage(qc, {
      type: 'update',
      topic: 'servers',
      upsert: [{ ...s, cpu: 99 }],
    });
    expect(qc.getQueryData<ServerDetail>(serverKey(s.id))?.server.cpu).toBe(99);
  });

  it('writes server:<id> snapshots and summary updates', () => {
    const s = server();
    applyLiveMessage(qc, { type: 'snapshot', topic: `server:${s.id}`, data: detail(s) });
    expect(qc.getQueryData<ServerDetail>(serverKey(s.id))?.server.name).toBe(s.name);
    applyLiveMessage(qc, {
      type: 'update',
      topic: `server:${s.id}`,
      upsert: [{ ...detail(s), sshFailed24h: 12 }],
    });
    expect(qc.getQueryData<ServerDetail>(serverKey(s.id))?.sshFailed24h).toBe(12);
    applyLiveMessage(qc, {
      type: 'update',
      topic: `server:${s.id}`,
      upsert: [{ ...s, temp: 61 }],
    });
    expect(qc.getQueryData<ServerDetail>(serverKey(s.id))?.server.temp).toBe(61);
  });

  it('keeps only active alerts and reports new ones', () => {
    const open = alert();
    applyLiveMessage(qc, { type: 'snapshot', topic: 'alerts', data: [open] });
    const fresh = alert({ level: 'ok', title: 'web-vps ist wieder da' });
    const res = applyLiveMessage(qc, {
      type: 'update',
      topic: 'alerts',
      upsert: [{ ...open, state: 'resolved' }, fresh],
    });
    expect(qc.getQueryData<Alert[]>(alertsKey)?.map((a) => a.id)).toEqual([fresh.id]);
    expect(res.newAlerts.map((a) => a.id)).toEqual([fresh.id]);
  });

  it('writes the containers snapshot and merges updates', () => {
    const a = container({ name: 'homeassistant' });
    const b = container({ name: 'lernplattform' });
    applyLiveMessage(qc, { type: 'update', topic: 'containers', upsert: [a] });
    // No list yet: an update alone never pretends to be the full list.
    expect(qc.getQueryData(containersKey)).toBeUndefined();
    applyLiveMessage(qc, { type: 'snapshot', topic: 'containers', data: { containers: [a, b] } });
    const stopped = { ...b, state: 'exited', status: 'off', exitCode: 0 } as const;
    applyLiveMessage(qc, {
      type: 'update',
      topic: 'containers',
      upsert: [stopped, { id: 'bad' }],
      remove: [a.id],
    });
    const list = qc.getQueryData<ContainerSummary[]>(containersKey);
    expect(list?.map((c) => [c.name, c.status])).toEqual([['lernplattform', 'off']]);
    expect(qc.getQueryState(containersKey)?.isInvalidated).toBe(true);
  });

  it('writes the checks snapshot and merges updates', () => {
    const a = check();
    const b = check();
    applyLiveMessage(qc, { type: 'update', topic: 'checks', upsert: [a] });
    expect(qc.getQueryData(checksKey)).toBeUndefined();
    applyLiveMessage(qc, { type: 'snapshot', topic: 'checks', data: { checks: [a, b] } });
    expect(qc.getQueryData<CheckSummary[]>(checksKey)?.length).toBe(2);
    const down = { ...b, status: 'crit', reason: 'HTTP 503', consecutiveFailures: 2 };
    applyLiveMessage(qc, {
      type: 'update',
      topic: 'checks',
      upsert: [down, { id: 'bad' }],
      remove: [a.id],
    });
    const list = qc.getQueryData<CheckSummary[]>(checksKey);
    expect(list?.map((c) => [c.id, c.status])).toEqual([[b.id, 'crit']]);
    expect(qc.getQueryState(checksKey)?.isInvalidated).toBe(true);
  });

  it('buffers container-logs:<id> lines', () => {
    const id = 'ctr-000042';
    const key = containerLogsKey(id);
    const topic = `container-logs:${id}`;
    applyLiveMessage(qc, {
      type: 'snapshot',
      topic,
      data: {
        lines: [
          { seq: 0, stream: 'stdout', text: 'boot' },
          { seq: 1, stream: 'stderr', text: 'warn' },
        ],
        ended: false,
      },
    });
    applyLiveMessage(qc, {
      type: 'update',
      topic,
      upsert: [{ seq: 2, stream: 'stdout', text: 'ready' }, { seq: 'x' }],
    });
    expect(qc.getQueryData<LogBuffer>(key)?.lines.map((l) => l.text)).toEqual([
      'boot',
      'warn',
      'ready',
    ]);
    // History from the first snapshot has no arrival time, live lines do.
    const at = qc.getQueryData<LogBuffer>(key)?.at ?? {};
    expect(Object.keys(at)).toEqual(['2']);
    expect(at[2]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    applyLiveMessage(qc, {
      type: 'update',
      topic,
      upsert: [{ lines: [{ seq: 3, stream: 'stdout', text: 'bye' }], ended: true }],
    });
    expect(qc.getQueryData<LogBuffer>(key)?.ended).toBe(true);
    expect(qc.getQueryData<LogBuffer>(key)?.lines).toHaveLength(4);
    // A broken snapshot leaves the buffer alone.
    applyLiveMessage(qc, { type: 'snapshot', topic, data: { lines: 'nope' } });
    expect(qc.getQueryData<LogBuffer>(key)?.lines).toHaveLength(4);
  });

  it('ignores unknown topics', () => {
    applyLiveMessage(qc, { type: 'snapshot', topic: 'ha', data: [] });
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });

  it('writes the github snapshot, merges updates and drops invalid repos', () => {
    const a = repo({ fullName: 'PuffyBooy/my-app' });
    const b = repo({ fullName: 'PuffyBooy/lernplattform' });
    applyLiveMessage(qc, { type: 'snapshot', topic: 'github', data: { repos: [a, b, { id: 1 }] } });
    expect(qc.getQueryData<RepoSummary[]>(reposKey)?.map((r) => r.fullName)).toEqual([
      'PuffyBooy/my-app',
      'PuffyBooy/lernplattform',
    ]);
    const a2 = { ...a, targets: [target({ repoId: a.id, behind: 1 })] };
    applyLiveMessage(qc, { type: 'update', topic: 'github', upsert: [a2], remove: [b.id] });
    const list = qc.getQueryData<RepoSummary[]>(reposKey);
    expect(list).toHaveLength(1);
    expect(list?.[0]?.targets[0]?.behind).toBe(1);
  });

  it('writes the games snapshot, merges updates and refreshes backups after a backup', () => {
    const a = game({ name: 'survival' });
    const b = game({ name: 'valheim' });
    applyLiveMessage(qc, { type: 'snapshot', topic: 'games', data: [a, b, { id: 'x' }] });
    expect(qc.getQueryData<GameSummary[]>(gamesKey)?.map((g) => g.name)).toEqual([
      'survival',
      'valheim',
    ]);
    qc.setQueryData(backupsKey(a.id), []);
    const a2 = { ...a, lastBackupAt: '2026-11-26T22:00:00.000Z' };
    applyLiveMessage(qc, { type: 'update', topic: 'games', upsert: [a2], remove: [b.id] });
    expect(qc.getQueryData<GameSummary[]>(gamesKey)).toEqual([a2]);
    expect(qc.getQueryState(backupsKey(a.id))?.isInvalidated).toBe(true);
  });

  it('buffers game:<id> events from snapshot and updates', () => {
    const e = (id: string, kind: string) => ({
      id,
      kind,
      text: id,
      ts: '2026-11-26T22:00:00.000Z',
    });
    applyLiveMessage(qc, {
      type: 'snapshot',
      topic: 'game:game-000001',
      data: [e('1', 'progress')],
    });
    applyLiveMessage(qc, {
      type: 'update',
      topic: 'game:game-000001',
      upsert: [e('1', 'progress'), e('2', 'ready'), { nope: true }],
    });
    const buf = qc.getQueryData<GameEventBuffer>(gameEventsKey('game-000001'));
    expect(buf?.events.map((x) => x.kind)).toEqual(['progress', 'ready']);
  });

  it('appends deploy log chunks and refreshes the deploy on a status item', () => {
    const topic = 'deploy:dep-000001';
    const key = deployLogKey('dep-000001');
    applyLiveMessage(qc, {
      type: 'snapshot',
      topic,
      data: [{ id: 'c1', channel: 'stdout', text: 'git fetch\ngit checkout a3f9c21' }],
    });
    expect(qc.getQueryData<DeployLogBuffer>(key)?.lines).toHaveLength(2);
    applyLiveMessage(qc, {
      type: 'update',
      topic,
      upsert: [
        { id: 'c1', channel: 'stdout', text: 'git fetch' },
        { id: 'c2', channel: 'stderr', text: 'compose up failed' },
        deploy({ id: 'dep-000001', status: 'failed' }),
      ],
    });
    const lines = qc.getQueryData<DeployLogBuffer>(key)?.lines;
    expect(lines).toHaveLength(3);
    expect(lines?.[2]).toEqual({ text: 'compose up failed', kind: 'err' });
  });
});

describe('backoff and url', () => {
  it('doubles up to 30 s', () => {
    const r = (): number => 0;
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, r))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    expect(backoffMs(0, () => 1)).toBe(1200);
  });

  it('uses wss on https', () => {
    expect(liveUrl({ protocol: 'https:', host: 'zentrale.tail.ts.net' })).toBe(
      'wss://zentrale.tail.ts.net/live',
    );
    expect(liveUrl({ protocol: 'http:', host: '127.0.0.1:5173' })).toBe('ws://127.0.0.1:5173/live');
  });
});

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(s: string): void {
    this.sent.push(JSON.parse(s));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

describe('LiveClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(onUnauthorized = vi.fn()) {
    const qc = new QueryClient();
    const client = new LiveClient(qc, {
      url: 'ws://test/live',
      createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
      onUnauthorized,
    });
    return { qc, client, onUnauthorized };
  }

  it('subscribes after open, resubscribes after reconnect', () => {
    const { client } = make();
    const off = client.subscribe('servers');
    client.subscribe('servers');
    client.start();
    const s1 = FakeSocket.last;
    s1?.open();
    expect(client.getState()).toBe('open');
    expect(s1?.sent).toEqual([{ type: 'subscribe', topics: ['servers'] }]);

    client.subscribe('alerts');
    expect(s1?.sent.at(-1)).toEqual({ type: 'subscribe', topics: ['alerts'] });

    s1?.drop();
    expect(client.getState()).toBe('closed');
    vi.advanceTimersByTime(1300);
    const s2 = FakeSocket.last;
    expect(s2).not.toBe(s1);
    s2?.open();
    expect(s2?.sent).toEqual([{ type: 'subscribe', topics: ['servers', 'alerts'] }]);

    // Reference counted: the first unsubscribe keeps the topic.
    off();
    off();
    expect(s2?.sent).toHaveLength(1);
    client.stop();
  });

  it('unsubscribes when the last user leaves and rejects bad topics', () => {
    const { client } = make();
    client.start();
    FakeSocket.last?.open();
    const off = client.subscribe('server:abc12345');
    off();
    expect(FakeSocket.last?.sent).toEqual([
      { type: 'subscribe', topics: ['server:abc12345'] },
      { type: 'unsubscribe', topics: ['server:abc12345'] },
    ]);
    client.subscribe('server:../../x')();
    expect(FakeSocket.last?.sent).toHaveLength(2);
    client.stop();
  });

  it('feeds the cache and toasts only new alerts', () => {
    const { qc, client } = make();
    const seen: string[] = [];
    client.onAlert((a) => seen.push(a.id));
    client.start();
    const s = FakeSocket.last;
    s?.open();
    const old = alert();
    s?.receive({ type: 'snapshot', topic: 'alerts', data: [old] });
    expect(seen).toEqual([]);
    const fresh = alert();
    s?.receive({ type: 'update', topic: 'alerts', upsert: [fresh] });
    s?.receive({ type: 'update', topic: 'alerts', upsert: [{ ...fresh, state: 'resolved' }] });
    s?.receive({ type: 'update', topic: 'alerts', upsert: [{ ...fresh, state: 'open' }] });
    expect(seen).toEqual([fresh.id]);
    expect(qc.getQueryData<Alert[]>(alertsKey)?.map((a) => a.id)).toEqual([old.id, fresh.id]);
    client.stop();
  });

  it('reports a closed session', () => {
    const { client, onUnauthorized } = make();
    client.start();
    FakeSocket.last?.open();
    FakeSocket.last?.drop(4001);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1300);
    // Upgrade refused (no session): no open, the session is checked again.
    FakeSocket.last?.drop(1006);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
    client.stop();
  });

  it('stops reconnecting after stop()', () => {
    const { client } = make();
    client.start();
    const s = FakeSocket.last;
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.last).toBe(s);
  });
});

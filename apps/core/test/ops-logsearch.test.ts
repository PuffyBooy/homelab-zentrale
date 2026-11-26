import { afterEach, describe, expect, it } from 'vitest';
import { logSearchResponseSchema, type LogMatch } from '@hz/shared';
import { until, type Received, type WsClient } from './agent-helpers.js';
import { dockerIdOf, info } from './container-helpers.js';
import { authHeaders, SAME_ORIGIN, type TestApp } from './helpers.js';
import { fail, ok, opsSetup } from './ops-helpers.js';

const clients: WsClient[] = [];
let t: TestApp | undefined;
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.app.close();
  t = undefined;
});

function match(name: string, ts: string | null, text = `line of ${name}`): LogMatch {
  return { containerId: dockerIdOf(name), containerName: name, ts, stream: 'stdout', text };
}

const searchData = (matches: LogMatch[], truncated = false) => ({
  matches,
  scannedContainers: 2,
  truncated,
});

const isSearch = (m: Received): boolean => m.action === 'logs.search';

describe('POST /api/logsearch', () => {
  it('fans out to all connected servers and merges hits newest first, null ts last', async () => {
    const s = await opsSetup(clients, {
      servers: [
        {
          name: 'heimserver',
          containers: [info('nginx'), info('db')],
          reply: (rpc) =>
            isSearch(rpc)
              ? ok(
                  rpc,
                  searchData([
                    match('nginx', '2026-11-25T11:00:00.000Z'),
                    match('db', null),
                    match('nginx', '2026-11-25T09:00:00.000Z'),
                  ]),
                )
              : null,
        },
        {
          name: 'cloud',
          containers: [info('proxy')],
          reply: (rpc) =>
            isSearch(rpc)
              ? ok(rpc, searchData([match('proxy', '2026-11-25T10:00:00.000Z')]))
              : null,
        },
      ],
    });
    t = s.t;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/logsearch',
      headers: authHeaders(s.cookie),
      payload: { query: 'error 500' },
    });
    expect(res.statusCode).toBe(200);
    const body = logSearchResponseSchema.parse(res.json());
    expect(body.hits.map((h) => [h.serverName, h.containerName, h.ts])).toEqual([
      ['heimserver', 'nginx', '2026-11-25T11:00:00.000Z'],
      ['cloud', 'proxy', '2026-11-25T10:00:00.000Z'],
      ['heimserver', 'nginx', '2026-11-25T09:00:00.000Z'],
      ['heimserver', 'db', null],
    ]);
    expect(body.servers.map((x) => [x.name, x.state])).toEqual([
      ['cloud', 'ok'],
      ['heimserver', 'ok'],
    ]);
    // Defaults reach the agent; without a name filter no container list is sent.
    const rpc = s.agents[0]?.rpcs.find(isSearch);
    expect(rpc?.params).toEqual({
      query: 'error 500',
      caseSensitive: false,
      sinceMinutes: 60,
      maxMatches: 200,
    });
    const audit = t.db.sqlite
      .prepare("SELECT details_json AS d FROM audit_log WHERE action = 'logsearch.query'")
      .all() as { d: string }[];
    expect(audit.map((a) => JSON.parse(a.d) as unknown)).toEqual([
      { servers: 2, sinceMinutes: 60, queryLength: 9 },
    ]);
  });

  it('caps at maxMatches and marks the servers that lost hits as truncated', async () => {
    const s = await opsSetup(clients, {
      servers: [
        {
          name: 'heimserver',
          containers: [info('nginx')],
          reply: (rpc) =>
            isSearch(rpc)
              ? ok(
                  rpc,
                  searchData([
                    match('nginx', '2026-11-25T11:00:00.000Z'),
                    match('nginx', '2026-11-25T08:00:00.000Z'),
                  ]),
                )
              : null,
        },
        {
          name: 'cloud',
          containers: [info('proxy')],
          reply: (rpc) =>
            isSearch(rpc)
              ? ok(rpc, searchData([match('proxy', '2026-11-25T10:00:00.000Z')]))
              : null,
        },
      ],
    });
    t = s.t;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/logsearch',
      headers: authHeaders(s.cookie),
      payload: { query: 'timeout', maxMatches: 2, caseSensitive: true, sinceMinutes: 1440 },
    });
    const body = logSearchResponseSchema.parse(res.json());
    expect(body.hits.map((h) => h.ts)).toEqual([
      '2026-11-25T11:00:00.000Z',
      '2026-11-25T10:00:00.000Z',
    ]);
    const byName = Object.fromEntries(body.servers.map((x) => [x.name, x.truncated]));
    expect(byName).toEqual({ heimserver: true, cloud: false });
    expect(s.agents[0]?.rpcs.find(isSearch)?.params).toMatchObject({
      caseSensitive: true,
      sinceMinutes: 1440,
      maxMatches: 2,
    });
  });

  it('container filter: only matching ids are sent; no match -> no_containers without an rpc', async () => {
    const s = await opsSetup(clients, {
      servers: [
        {
          name: 'heimserver',
          containers: [info('nginx-proxy'), info('postgres')],
          reply: (rpc) => (isSearch(rpc) ? ok(rpc, searchData([])) : null),
        },
        { name: 'cloud', containers: [info('redis')] },
      ],
    });
    t = s.t;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/logsearch',
      headers: authHeaders(s.cookie),
      payload: { query: 'denied', container: 'NGINX' },
    });
    const body = logSearchResponseSchema.parse(res.json());
    expect(Object.fromEntries(body.servers.map((x) => [x.name, x.state]))).toEqual({
      heimserver: 'ok',
      cloud: 'no_containers',
    });
    expect(s.agents[0]?.rpcs.find(isSearch)?.params).toMatchObject({
      containers: [dockerIdOf('nginx-proxy')],
    });
    expect(s.agents[1]?.rpcs.some(isSearch)).toBe(false);
  });

  it('old agent -> unsupported, bad data -> failed, disconnected selected server -> offline', async () => {
    const s = await opsSetup(clients, {
      servers: [
        { name: 'alt', reply: (rpc) => (isSearch(rpc) ? fail(rpc, 'not_allowed') : null) },
        {
          name: 'kaputt',
          reply: (rpc) => (isSearch(rpc) ? ok(rpc, { matches: 'nope' }) : null),
        },
        { name: 'weg' },
      ],
    });
    t = s.t;
    const gone = s.agents[2];
    if (!gone) throw new Error('no agent');
    gone.agent.close();
    await until(() => !s.t.app.hzCore.hub.isConnected(gone.serverId));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/logsearch',
      headers: authHeaders(s.cookie),
      payload: { query: 'oops', serverIds: s.agents.map((a) => a.serverId) },
    });
    expect(res.statusCode).toBe(200);
    const body = logSearchResponseSchema.parse(res.json());
    expect(Object.fromEntries(body.servers.map((x) => [x.name, x.state]))).toEqual({
      alt: 'unsupported',
      kaputt: 'failed',
      weg: 'offline',
    });
    expect(body.hits).toEqual([]);
    // Without serverIds only connected servers are searched.
    const all = await t.app.inject({
      method: 'POST',
      url: '/api/logsearch',
      headers: authHeaders(s.cookie),
      payload: { query: 'oops' },
    });
    expect(logSearchResponseSchema.parse(all.json()).servers.map((x) => x.name)).toEqual([
      'alt',
      'kaputt',
    ]);
  });

  it('unknown server -> 404; invalid input -> 400 without an rpc', async () => {
    const s = await opsSetup(clients);
    t = s.t;
    const headers = authHeaders(s.cookie);
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/logsearch',
      headers,
      payload: { query: 'oops', serverIds: ['AAAAAAAAAAAAAAAAAAAAAA'] },
    });
    expect(unknown.statusCode).toBe(404);
    for (const payload of [
      {},
      { query: 'x' },
      { query: 'a'.repeat(201) },
      { query: 'line\nbreak' },
      { query: 'ok?', sinceMinutes: 1 },
      { query: 'ok?', maxMatches: 501 },
      { query: 'ok?', container: '../etc' },
      { query: 'ok?', regex: true },
    ]) {
      const res = await t.app.inject({ method: 'POST', url: '/api/logsearch', headers, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ ok: false, error: 'invalid_input' });
    }
    expect(s.agents[0]?.rpcs.some(isSearch)).toBe(false);
  });

  it('rate limit: 10 searches per minute per session -> 429', async () => {
    const s = await opsSetup(clients, {
      servers: [
        { name: 'heimserver', reply: (rpc) => (isSearch(rpc) ? ok(rpc, searchData([])) : null) },
      ],
    });
    t = s.t;
    const send = () =>
      s.t.app.inject({
        method: 'POST',
        url: '/api/logsearch',
        headers: authHeaders(s.cookie),
        payload: { query: 'abc' },
      });
    for (let i = 0; i < 10; i++) expect((await send()).statusCode).toBe(200);
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    t.clock.advance(60_000);
    expect((await send()).statusCode).toBe(200);
  });

  it('module off -> 404 module_disabled; anonymous -> 401', async () => {
    const s = await opsSetup(clients, { modules: { logsearch: false } });
    t = s.t;
    const off = await t.app.inject({
      method: 'POST',
      url: '/api/logsearch',
      headers: authHeaders(s.cookie),
      payload: { query: 'abc' },
    });
    expect(off.statusCode).toBe(404);
    expect(off.json()).toEqual({ ok: false, error: 'module_disabled' });
    const anon = await t.app.inject({
      method: 'POST',
      url: '/api/logsearch',
      headers: SAME_ORIGIN,
      payload: { query: 'abc' },
    });
    expect(anon.statusCode).toBe(401);
    expect(s.agents[0]?.rpcs.some(isSearch)).toBe(false);
  });
});

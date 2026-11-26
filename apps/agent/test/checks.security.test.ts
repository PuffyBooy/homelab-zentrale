import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, RpcEnvelope } from '@hz/shared';
import type { ActionContext as Ctx } from '../src/actions/types.js';

/** Every execFile call made by the code under test (real runFile, mocked process). */
const execCalls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    opts: Record<string, unknown>,
    cb: (err: null, stdout: string, stderr: string) => void,
  ) => {
    execCalls.push({ file, args, opts });
    cb(null, 'rtt min/avg/max/mdev = 1.000/2.000/3.000/0.100 ms\n', '');
  },
}));

const { runFile } = await import('../src/exec.js');
const { createLogger } = await import('../src/log.js');
const { StreamManager } = await import('../src/streams.js');
const { Dispatcher } = await import('../src/actions/index.js');
const { ActionError } = await import('../src/actions/types.js');
const { checkHttp, checkPing, checkTcp, normalizeHost, pingKillAfterMs, redactUrl, MAX_BODY } =
  await import('../src/actions/checks.js');

const INJECTIONS = [
  '-f',
  '--flood',
  '-c1000',
  '-I eth0',
  '-',
  ';rm',
  ';rm -rf /',
  'a;rm',
  '$(id)',
  '$(reboot).example.com',
  '`id`',
  'example.com|id',
  'example.com&&id',
  'example.com id',
  'example.com\nid',
  'example.com\0',
  '../etc/passwd',
  'host/../x',
  '%2d%66',
  '',
  ' ',
  '[-f]',
  '[::1',
  '1234',
  '999.1.1.1',
  '0x7f.1',
  'a'.repeat(254),
  'exa_mple.com',
  '-example.com',
  'example-.com',
  'example..com',
];

describe('host validation', () => {
  it.each(INJECTIONS)('rejects %j', (h) => {
    expect(normalizeHost(h)).toBeNull();
  });

  it.each([
    ['example.com', 'example.com'],
    ['example.com.', 'example.com'],
    ['oracle-a1', 'oracle-a1'],
    ['pi.tail1234.ts.net', 'pi.tail1234.ts.net'],
    ['1.1.1.1', '1.1.1.1'],
    ['100.64.0.1', '100.64.0.1'],
    ['::1', '::1'],
    ['[::1]', '::1'],
    ['fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::1'],
    ['xn--wien-6qa.at', 'xn--wien-6qa.at'],
  ])('accepts %j', (h, out) => {
    expect(normalizeHost(h)).toBe(out);
  });

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 1, {}, ['example.com']]) expect(normalizeHost(v)).toBeNull();
  });
});

describe('check.ping security', () => {
  it.each(INJECTIONS)('rejects host %j before anything is executed', async (host) => {
    const run = vi.fn();
    await expect(checkPing({ host, count: 1, timeoutMs: 1000 }, { run })).rejects.toMatchObject({
      code: 'invalid_params',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs ping via execFile without a shell, fixed args, host last after --', async () => {
    execCalls.length = 0;
    const r = await checkPing({ host: 'example.com', count: 3, timeoutMs: 4000 }, { run: runFile });
    expect(r).toEqual({ ok: true, ms: 2 });
    expect(execCalls).toHaveLength(1);
    const c = execCalls[0];
    if (!c) throw new Error('no call');
    expect(c.file).toBe('ping');
    expect(c.opts.shell).toBe(false);
    expect(c.args).toEqual([
      '-n',
      '-q',
      '-c',
      '3',
      '-i',
      '0.2',
      '-W',
      '3',
      '-w',
      '3',
      '--',
      'example.com',
    ]);
    expect(c.opts.timeout).toBe(pingKillAfterMs(4000));
    const env = c.opts.env as Record<string, string>;
    expect(Object.keys(env)).not.toContain('HZ_AGENT_TOKEN');
  });

  it('strips IPv6 brackets so ping gets a plain address', async () => {
    execCalls.length = 0;
    await checkPing({ host: '[fd7a::1]', count: 1, timeoutMs: 1000 }, { run: runFile });
    expect(execCalls[0]?.args.slice(-2)).toEqual(['--', 'fd7a::1']);
  });

  it('honors the timeout: ping deadline and hard kill stay close to timeoutMs', async () => {
    for (const t of [100, 1000, 2500, 10_000, 60_000]) {
      const run = vi.fn(async () => ({
        code: null,
        stdout: '',
        stderr: '',
        error: 'timeout' as const,
      }));
      const r = await checkPing({ host: '10.0.0.1', count: 5, timeoutMs: t }, { run });
      expect(r).toEqual({ ok: false, ms: null, error: 'timeout' });
      const [, args, opts] = run.mock.calls[0] as unknown as [
        string,
        string[],
        { timeoutMs: number },
      ];
      const w = Number(args[args.indexOf('-w') + 1]);
      expect(w * 1000).toBeLessThanOrEqual(Math.max(1000, t));
      expect(opts.timeoutMs).toBeGreaterThanOrEqual(t);
      expect(opts.timeoutMs).toBeLessThanOrEqual(Math.max(t, 1500));
    }
  });

  it('never returns ping output in the error text', async () => {
    const run = async () => ({ code: 2, stdout: '', stderr: 'ping: secret-output-xyz: weird' });
    const r = await checkPing({ host: 'example.com', count: 1, timeoutMs: 1000 }, { run });
    expect(JSON.stringify(r)).not.toContain('secret-output-xyz');
  });
});

describe('dispatcher with check actions', () => {
  function setup() {
    const events: AgentEvent[] = [];
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const ctx = {
      name: 'pi',
      allowTerminal: false,
      homelabRoot: '/opt/homelab/',
      host: { hostProc: '/proc', hostRoot: '/nonexistent', docker: null, exec: run },
      log: createLogger('error', () => undefined),
      later: vi.fn(),
      streams: new StreamManager({ send: () => true, bufferedAmount: () => 0 }),
      run,
      dockerSocket: '/var/run/docker.sock',
    } as unknown as Ctx;
    return { d: new Dispatcher(ctx, (e) => events.push(e)), run, events };
  }
  const rpc = (action: string, params: unknown): RpcEnvelope => ({
    type: 'rpc',
    id: 'rpc_12345678',
    action,
    params,
  });

  it.each(['-f', '--flood', ';rm', '$(id)', 'a b', '-c1000'])(
    'denies check.ping host %j without exec',
    async (host) => {
      const { d, run, events } = setup();
      const r = await d.handle(rpc('check.ping', { host }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_params');
      expect(run).not.toHaveBeenCalled();
      expect(events.some((e) => e.event.kind === 'denied')).toBe(true);
    },
  );

  it.each(['-f', ';rm', '$(id)'])('denies check.tcp host %j', async (host) => {
    const { d } = setup();
    const r = await d.handle(rpc('check.tcp', { host, port: 22 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_params');
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/', 'gopher://x/'])(
    'denies check.http url %j',
    async (url) => {
      const { d } = setup();
      const r = await d.handle(rpc('check.http', { url }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_params');
    },
  );
});

describe('check.tcp security', () => {
  it.each(['-f', ';rm', '$(id)', '-example.com'])('rejects host %j before connecting', (host) => {
    expect(() => checkTcp({ host, port: 22, timeoutMs: 1000 })).toThrow(ActionError);
  });
});

// HTTP ------------------------------------------------------------------------

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const servers: http.Server[] = [];
async function serve(handler: Handler): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

const http0 = { method: 'GET' as const, expectStatusMin: 200, expectStatusMax: 399 };

describe('check.http security', () => {
  let base = '';
  let other = '';
  const seenAuth: (string | undefined)[] = [];
  const otherAuth: (string | undefined)[] = [];

  beforeAll(async () => {
    other = await serve((req, res) => {
      otherAuth.push(req.headers.authorization);
      res.end('other');
    });
    base = await serve((req, res) => {
      seenAuth.push(req.headers.authorization);
      const u = new URL(req.url ?? '/', 'http://x');
      switch (u.pathname) {
        case '/hang':
          return; // never answers
        case '/trickle':
          res.writeHead(200);
          res.write('start ');
          return; // body never ends
        case '/endless': {
          res.writeHead(200);
          const chunk = Buffer.alloc(64 * 1024, 'a');
          const pump = () => {
            while (res.write(chunk));
          };
          res.on('drain', pump);
          pump();
          return;
        }
        case '/redir':
          res.writeHead(302, { location: u.searchParams.get('to') ?? '/' });
          return res.end();
        case '/loop':
          res.writeHead(301, { location: '/loop' });
          return res.end();
        case '/cross':
          res.writeHead(302, { location: `${other}/x` });
          return res.end();
        case '/same':
          res.writeHead(302, { location: '/plain' });
          return res.end();
        default:
          res.end('top-secret-body-content');
      }
    });
  });

  it('rejects non-http(s) urls in the handler itself', async () => {
    await expect(
      checkHttp({ ...http0, url: 'file:///etc/passwd', timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('honors the timeout when the server never answers', async () => {
    const t0 = performance.now();
    const r = await checkHttp({ ...http0, url: `${base}/hang`, timeoutMs: 300 });
    expect(r).toEqual({ ok: false, ms: null, error: 'timeout' });
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('honors the timeout while reading the body for contains', async () => {
    const t0 = performance.now();
    const r = await checkHttp({
      ...http0,
      url: `${base}/trickle`,
      contains: 'never',
      timeoutMs: 300,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(200);
    expect(r.error).toBe('timeout');
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('does not download an endless body without contains', async () => {
    const t0 = performance.now();
    const r = await checkHttp({ ...http0, url: `${base}/endless`, timeoutMs: 5000 });
    expect(r).toMatchObject({ ok: true, code: 200 });
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('reads at most 1 MiB for contains and stops the download', async () => {
    const t0 = performance.now();
    const r = await checkHttp({ ...http0, url: `${base}/endless`, contains: 'b', timeoutMs: 5000 });
    expect(r).toMatchObject({ ok: false, code: 200, error: 'text not found' });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(MAX_BODY).toBe(1024 * 1024);
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'ftp://127.0.0.1/', 'data:text/plain,x'])(
    'does not follow a redirect to %j',
    async (to) => {
      const r = await checkHttp({
        ...http0,
        url: `${base}/redir?to=${encodeURIComponent(to)}`,
        timeoutMs: 2000,
      });
      expect(r).toMatchObject({ ok: false, code: 302, error: 'redirect to unsupported scheme' });
    },
  );

  it('stops redirect loops', async () => {
    const r = await checkHttp({ ...http0, url: `${base}/loop`, timeoutMs: 2000 });
    expect(r).toMatchObject({ ok: false, code: 301, error: 'too many redirects' });
  });

  it('drops URL credentials when a redirect leaves the origin', async () => {
    otherAuth.length = 0;
    seenAuth.length = 0;
    const r = await checkHttp({
      ...http0,
      url: base.replace('http://', 'http://alex:hunter2pw@') + '/cross',
      timeoutMs: 2000,
    });
    expect(r).toMatchObject({ ok: true, code: 200 });
    expect(seenAuth[0]).toMatch(/^Basic /);
    expect(otherAuth).toEqual([undefined]);
  });

  it('keeps credentials on a same-origin redirect', async () => {
    seenAuth.length = 0;
    await checkHttp({
      ...http0,
      url: base.replace('http://', 'http://alex:hunter2pw@') + '/same',
      timeoutMs: 2000,
    });
    expect(seenAuth).toHaveLength(2);
    expect(seenAuth.every((a) => a?.startsWith('Basic '))).toBe(true);
  });

  it('never returns or logs the body, credentials or query', async () => {
    const lines: string[] = [];
    const log = createLogger('debug', (l) => lines.push(l));
    const url = base.replace('http://', 'http://alex:hunter2pw@') + '/x?token=qsecret123#frag';
    const hit = await checkHttp(
      { ...http0, url, contains: 'top-secret', timeoutMs: 2000 },
      { log },
    );
    const miss = await checkHttp({ ...http0, url, contains: 'nope', timeoutMs: 2000 }, { log });
    expect(hit.ok).toBe(true);
    expect(miss).toMatchObject({ ok: false, error: 'text not found' });
    const all = JSON.stringify([hit, miss]) + lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const bad of ['top-secret-body', 'hunter2pw', 'alex:', 'qsecret123', 'frag']) {
      expect(all).not.toContain(bad);
    }
  });

  it('redactUrl removes credentials, query and fragment', () => {
    expect(redactUrl('https://u:p@example.com:8443/a/b?token=x#y')).toBe(
      'https://example.com:8443/a/b',
    );
    expect(redactUrl('not a url')).toBe('[invalid url]');
  });

  it('error texts are fixed strings or error codes', async () => {
    const r = await checkHttp({ ...http0, url: 'http://127.0.0.1:1/', timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^[A-Z0-9_]+$|^[a-z ]+$/);
  });
});

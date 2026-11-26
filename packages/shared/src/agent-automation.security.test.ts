import { describe, expect, it } from 'vitest';
import {
  appIdSchema,
  automationRpcParams,
  certNameSchema,
  fqdnSchema,
  speedtestDataSchema,
  SPEEDTEST_MAX_BYTES,
  SPEEDTEST_MAX_SECONDS,
  taskCommandSchema,
  taskExecDataSchema,
  TASK_MAX_TIMEOUT_SEC,
  TASK_OUTPUT_MAX_BYTES,
} from './agent-automation.js';
import { parseRpc, rpcActions, streamingActions, terminalActions } from './agent-protocol.js';

const rpc = (action: string, params: unknown) =>
  parseRpc({ type: 'rpc', id: 'abcdefgh1234', action, params });

const CERT = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const KEY = ['-----BEGIN EC PRIVATE KEY-----', 'MHcC', '-----END EC PRIVATE KEY-----', ''].join(
  '\n',
);

describe('agent-automation: allowlist', () => {
  it('every automation action is on the allowlist, none streams or needs the terminal', () => {
    for (const a of Object.keys(automationRpcParams)) {
      expect(rpcActions).toContain(a);
      expect(streamingActions).not.toContain(a);
      expect(terminalActions).not.toContain(a);
    }
  });

  it('there is no generic exec/shell action besides task.exec', () => {
    const shellish = rpcActions.filter((a) => /exec|shell|command|run/i.test(a));
    expect(shellish.sort()).toEqual(['deploy.run', 'speedtest.run', 'task.exec'].sort());
  });
});

describe('agent-automation: task.exec', () => {
  it('accepts a single-line command with bounded timeout (default 300 s)', () => {
    const r = rpc('task.exec', { taskId: 'abcdefgh', command: 'docker system df' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.params).toMatchObject({ timeoutSec: 300 });
  });

  it.each([
    ['newline', { taskId: 'abcdefgh', command: 'ls\nrm -rf /' }],
    ['carriage return', { taskId: 'abcdefgh', command: 'ls\rrm' }],
    ['NUL', { taskId: 'abcdefgh', command: 'ls\0' }],
    ['blank', { taskId: 'abcdefgh', command: '   ' }],
    ['empty', { taskId: 'abcdefgh', command: '' }],
    ['too long', { taskId: 'abcdefgh', command: 'x'.repeat(2001) }],
    ['timeout too short', { taskId: 'abcdefgh', command: 'ls', timeoutSec: 4 }],
    [
      'timeout too long',
      { taskId: 'abcdefgh', command: 'ls', timeoutSec: TASK_MAX_TIMEOUT_SEC + 1 },
    ],
    ['fractional timeout', { taskId: 'abcdefgh', command: 'ls', timeoutSec: 10.5 }],
    ['bad task id', { taskId: '../etc', command: 'ls' }],
    ['short task id', { taskId: 'abc', command: 'ls' }],
    ['extra field (env)', { taskId: 'abcdefgh', command: 'ls', env: { A: '1' } }],
    ['extra field (cwd)', { taskId: 'abcdefgh', command: 'ls', cwd: '/' }],
    ['command as array', { taskId: 'abcdefgh', command: ['ls'] }],
  ])('rejects %s', (_name, params) => {
    const r = rpc('task.exec', params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_params');
  });

  it('the error message does not echo the command', () => {
    const secret = ['s3cr', 'et-', 'value'].join('');
    const r = rpc('task.exec', { taskId: 'abcdefgh', command: `echo ${secret}\n` });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain(secret);
  });

  it('taskCommandSchema matches the agent params', () => {
    expect(taskCommandSchema.safeParse('a'.repeat(2000)).success).toBe(true);
    expect(taskCommandSchema.safeParse('a\tb').success).toBe(true);
  });

  it('taskExecDataSchema bounds the output and is strict', () => {
    const base = { exitCode: 0, timedOut: false, durationMs: 1, output: '', truncated: false };
    expect(taskExecDataSchema.safeParse(base).success).toBe(true);
    expect(taskExecDataSchema.safeParse({ ...base, exitCode: null, timedOut: true }).success).toBe(
      true,
    );
    expect(
      taskExecDataSchema.safeParse({ ...base, output: 'x'.repeat(TASK_OUTPUT_MAX_BYTES * 2 + 1) })
        .success,
    ).toBe(false);
    expect(taskExecDataSchema.safeParse({ ...base, durationMs: -1 }).success).toBe(false);
    expect(taskExecDataSchema.safeParse({ ...base, command: 'ls' }).success).toBe(false);
  });
});

describe('agent-automation: speedtest.run', () => {
  it('takes only caps, no URL or host', () => {
    const r = rpc('speedtest.run', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.params).toEqual({ maxSeconds: 10, maxBytes: 100 * 1024 * 1024 });
    for (const extra of [
      { url: 'https://evil.example' },
      { host: 'evil.example' },
      { server: 'x' },
    ]) {
      expect(rpc('speedtest.run', extra).ok).toBe(false);
    }
  });

  it.each([
    { maxSeconds: 2 },
    { maxSeconds: SPEEDTEST_MAX_SECONDS + 1 },
    { maxBytes: 1024 * 1024 - 1 },
    { maxBytes: SPEEDTEST_MAX_BYTES + 1 },
    { maxBytes: 1024 * 1024 + 0.5 },
    { maxSeconds: '10' },
  ])('rejects %o', (params) => {
    expect(rpc('speedtest.run', params).ok).toBe(false);
  });

  it('speedtestDataSchema: finite, non-negative, colo three capitals or null, strict', () => {
    const base = {
      downloadMbps: 1,
      uploadMbps: 1,
      latencyMs: 1,
      jitterMs: 0,
      downloadBytes: 1,
      uploadBytes: 1,
      durationMs: 1,
      colo: 'VIE',
    };
    expect(speedtestDataSchema.safeParse(base).success).toBe(true);
    expect(speedtestDataSchema.safeParse({ ...base, colo: null }).success).toBe(true);
    for (const bad of [
      { ...base, colo: 'vie' },
      { ...base, colo: 'VIEN' },
      { ...base, colo: '<b>' },
      { ...base, downloadMbps: -1 },
      { ...base, uploadMbps: Number.POSITIVE_INFINITY },
      { ...base, latencyMs: Number.NaN },
      { ...base, downloadBytes: 1.5 },
      { ...base, server: 'x' },
    ]) {
      expect(speedtestDataSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('agent-automation: cert.write / cert.remove / app.remove', () => {
  it('accepts PEM under a validated folder name', () => {
    expect(rpc('cert.write', { name: 'example-com', fullchainPem: CERT, privkeyPem: KEY }).ok).toBe(
      true,
    );
    expect(rpc('cert.remove', { name: 'example-com' }).ok).toBe(true);
  });

  it.each(['../etc', 'a/b', 'Example', '-x', 'x-', '', 'a'.repeat(65), 'a b', '.hidden'])(
    'rejects cert name %j',
    (name) => {
      expect(certNameSchema.safeParse(name).success).toBe(false);
      expect(rpc('cert.remove', { name }).ok).toBe(false);
    },
  );

  it('rejects non-PEM content and paths from the wire', () => {
    expect(rpc('cert.write', { name: 'x1', fullchainPem: 'hello', privkeyPem: KEY }).ok).toBe(
      false,
    );
    expect(rpc('cert.write', { name: 'x1', fullchainPem: CERT, privkeyPem: 'nope' }).ok).toBe(
      false,
    );
    expect(rpc('cert.write', { name: 'x1', fullchainPem: KEY, privkeyPem: KEY }).ok).toBe(false);
    expect(
      rpc('cert.write', { name: 'x1', fullchainPem: CERT, privkeyPem: KEY, path: '/etc/ssl' }).ok,
    ).toBe(false);
    expect(
      rpc('cert.write', { name: 'x1', fullchainPem: CERT.repeat(2000), privkeyPem: KEY }).ok,
    ).toBe(false);
  });

  it('app.remove: validated app id, explicit deleteData', () => {
    expect(rpc('app.remove', { appId: 'jellyfin', deleteData: false }).ok).toBe(true);
    expect(rpc('app.remove', { appId: 'jellyfin' }).ok).toBe(false);
    for (const appId of ['../x', 'Jelly', 'a', 'a'.repeat(33), 'x_y', '-x']) {
      expect(appIdSchema.safeParse(appId).success, appId).toBe(false);
      expect(rpc('app.remove', { appId, deleteData: true }).ok).toBe(false);
    }
  });
});

describe('agent-automation: fqdnSchema', () => {
  it.each(['example.com', '*.example.com', 'a.b.c.example.org', 'xn--bcher-kva.example'])(
    'accepts %s',
    (n) => expect(fqdnSchema.safeParse(n).success).toBe(true),
  );
  it.each([
    'Example.com',
    'example',
    '*.*.example.com',
    'a.*.example.com',
    '-a.example.com',
    'a-.example.com',
    'example.com.',
    'exa mple.com',
    '1.2.3.4',
    `${'a'.repeat(64)}.com`,
    'example.123',
  ])('rejects %s', (n) => expect(fqdnSchema.safeParse(n).success).toBe(false));
});

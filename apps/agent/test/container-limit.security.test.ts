import { describe, expect, it } from 'vitest';
import type { AgentEvent, RpcEnvelope } from '@hz/shared';
import { Dispatcher, type ActionContext } from '../src/actions/index.js';
import { limitContainer, type LimitDocker } from '../src/actions/container-limit.js';
import { createLogger } from '../src/log.js';
import { StreamManager } from '../src/streams.js';

const APP_ID = 'b'.repeat(64);
const CORE_ID = 'c'.repeat(64);
const AGENT_ID = 'a'.repeat(64);
const OWN_ID = `0123456789ab${'d'.repeat(52)}`;

function fakeDocker(ncpu = 4) {
  const updates: { id: string; body: unknown }[] = [];
  const labels: Record<string, Record<string, string>> = {
    [APP_ID]: { 'com.docker.compose.service': 'web' },
    [CORE_ID]: { 'hz.role': 'core' },
    [AGENT_ID]: { 'hz.role': 'agent' },
    [OWN_ID]: {},
  };
  const byName: Record<string, string> = { web: APP_ID, core: CORE_ID, agent: AGENT_ID };
  const docker: LimitDocker = {
    getContainer: (ref: string) => ({
      inspect: async () => {
        const id = byName[ref] ?? ref;
        const l = labels[id];
        if (!l) throw Object.assign(new Error('no such container'), { statusCode: 404 });
        return { Id: id, Config: { Labels: l }, HostConfig: { Memory: 512 * 1024 * 1024 } };
      },
      update: async (body: unknown) => {
        updates.push({ id: ref, body });
        return {};
      },
    }),
    info: async () => ({ NCPU: ncpu }),
  };
  return { docker, updates };
}

function setup(docker: LimitDocker) {
  const events: AgentEvent[] = [];
  const ctx = {
    name: 'heimserver',
    allowTerminal: false,
    homelabRoot: '/opt/homelab/',
    host: { hostProc: '/proc', hostRoot: '/', docker, exec: async () => ({}) },
    log: createLogger('error', () => undefined),
    later: () => undefined,
    streams: new StreamManager({ send: () => true, bufferedAmount: () => 0 }),
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    dockerSocket: '/var/run/docker.sock',
    spawn: () => {
      throw new Error('spawn not expected');
    },
    dataDir: '/nonexistent',
  } as unknown as ActionContext;
  return { d: new Dispatcher(ctx, (e) => events.push(e)), events };
}

const rpc = (params: unknown): RpcEnvelope => ({
  type: 'rpc',
  id: 'rpc_12345678',
  action: 'container.limit',
  params,
});

describe('container.limit security', () => {
  it.each(['core', 'agent', CORE_ID, AGENT_ID])(
    'refuses hz.role container %s with not_allowed and reports denied',
    async (id) => {
      const { docker, updates } = fakeDocker();
      const { d, events } = setup(docker);
      const res = await d.handle(rpc({ id, cpus: 0.5 }));
      expect(res).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
      expect(updates).toEqual([]);
      expect(events.some((e) => e.event.kind === 'denied')).toBe(true);
    },
  );

  it('refuses the agent own container (hostname = short id), also when removing the limit', async () => {
    const { docker, updates } = fakeDocker();
    for (const cpus of [1, null]) {
      await expect(
        limitContainer(docker, { id: OWN_ID, cpus }, { hostname: '0123456789ab' }),
      ).rejects.toMatchObject({ code: 'not_allowed' });
    }
    expect(updates).toEqual([]);
  });

  it('refuses unknown containers with not_allowed', async () => {
    const { docker, updates } = fakeDocker();
    const { d } = setup(docker);
    const res = await d.handle(rpc({ id: 'ghost', cpus: 1 }));
    expect(res).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(updates).toEqual([]);
  });

  it('sends only NanoCpus to Docker, by resolved id', async () => {
    const { docker, updates } = fakeDocker();
    const { d } = setup(docker);
    const res = await d.handle(rpc({ id: 'web', cpus: 1.5 }));
    expect(res).toMatchObject({ ok: true, data: { cpus: 1.5 } });
    expect(updates).toEqual([{ id: APP_ID, body: { NanoCpus: 1_500_000_000 } }]);
    expect(Object.keys(updates[0]?.body as object)).toEqual(['NanoCpus']);
  });

  it('null removes the limit with NanoCpus 0', async () => {
    const { docker, updates } = fakeDocker();
    const { d } = setup(docker);
    const res = await d.handle(rpc({ id: 'web', cpus: null }));
    expect(res).toMatchObject({ ok: true, data: { cpus: null } });
    expect(updates).toEqual([{ id: APP_ID, body: { NanoCpus: 0 } }]);
  });

  it('caps cpus at the host CPU count', async () => {
    const { docker, updates } = fakeDocker(2);
    const { d } = setup(docker);
    const res = await d.handle(rpc({ id: 'web', cpus: 64 }));
    expect(res).toMatchObject({ ok: true, data: { cpus: 2 } });
    expect(updates[0]?.body).toEqual({ NanoCpus: 2_000_000_000 });
  });

  it.each([
    0,
    0.05,
    -1,
    64.5,
    1000,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '1',
    '0.5',
    true,
    undefined,
  ])('rejects cpus %j by schema before Docker is touched', async (cpus) => {
    const { docker, updates } = fakeDocker();
    const { d } = setup(docker);
    const res = await d.handle(rpc({ id: 'web', cpus }));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(updates).toEqual([]);
  });

  it.each([
    { id: 'web', cpus: 1, memory: 1024 },
    { id: 'web', cpus: 1, NanoCpus: 1 },
    { id: 'web', cpus: 1, Memory: 0 },
    { id: '../web', cpus: 1 },
    { id: 'web; rm -rf /', cpus: 1 },
  ])('rejects extra fields and bad refs %j', async (params) => {
    const { docker, updates } = fakeDocker();
    const { d } = setup(docker);
    const res = await d.handle(rpc(params));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(updates).toEqual([]);
  });
});

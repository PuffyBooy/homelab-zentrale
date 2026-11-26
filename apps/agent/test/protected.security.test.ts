import { describe, expect, it } from 'vitest';
import { containerRestart, containerStop } from '../src/actions/container.js';
import { containerUpdate } from '../src/actions/container-update.js';
import {
  assertProjectNotProtected,
  isProtectedContainer,
  type ProtectDocker,
} from '../src/actions/protected.js';
import type { ActionContext } from '../src/actions/types.js';

const AGENT_ID = 'a'.repeat(64);
const APP_ID = 'b'.repeat(64);

function fakeDocker(calls: string[]) {
  const labels: Record<string, Record<string, string>> = {
    [AGENT_ID]: { 'hz.role': 'agent' },
    [APP_ID]: {},
  };
  return {
    getContainer: (id: string) => ({
      inspect: async () => {
        const l = labels[id];
        if (!l) throw Object.assign(new Error('nope'), { statusCode: 404 });
        return { Id: id, Config: { Labels: l, Image: 'busybox:1.36' }, State: {} };
      },
      stop: async () => void calls.push(`stop ${id}`),
      restart: async () => void calls.push(`restart ${id}`),
      start: async () => void calls.push(`start ${id}`),
    }),
    listContainers: async (opts: { filters: string }) =>
      opts.filters.includes('/opt/homelab/agent')
        ? [{ Id: AGENT_ID, Labels: labels[AGENT_ID] }]
        : [],
  };
}

const ctx = (docker: unknown) => ({ host: { docker } }) as unknown as ActionContext;

describe('the agent and the core are protected', () => {
  it('detects the role label and the own container id', () => {
    expect(isProtectedContainer({ id: AGENT_ID, labels: { 'hz.role': 'agent' } })).toBe(true);
    expect(isProtectedContainer({ id: APP_ID, labels: { 'hz.role': 'core' } })).toBe(true);
    expect(isProtectedContainer({ id: APP_ID, labels: { 'hz.role': 'app' } })).toBe(false);
    expect(isProtectedContainer({ id: 'c0ffee123456abcd', labels: {} }, 'c0ffee123456')).toBe(true);
    expect(isProtectedContainer({ id: APP_ID, labels: {} }, 'heimserver')).toBe(false);
  });

  it('refuses stop, restart and update of the agent container', async () => {
    const calls: string[] = [];
    const d = fakeDocker(calls);
    for (const op of [containerStop, containerRestart]) {
      await expect(op({ id: AGENT_ID }, ctx(d))).rejects.toMatchObject({ code: 'not_allowed' });
    }
    await expect(containerUpdate({ id: AGENT_ID }, ctx(d))).rejects.toMatchObject({
      code: 'not_allowed',
    });
    expect(calls).toEqual([]);
    await containerStop({ id: APP_ID }, ctx(d));
    expect(calls).toEqual([`stop ${APP_ID}`]);
  });

  it('refuses compose actions on the project that contains the agent', async () => {
    const d = fakeDocker([]) as unknown as ProtectDocker;
    await expect(assertProjectNotProtected(d, '/opt/homelab/agent')).rejects.toMatchObject({
      code: 'not_allowed',
    });
    await expect(assertProjectNotProtected(d, '/opt/homelab/apps/web')).resolves.toBeUndefined();
  });
});

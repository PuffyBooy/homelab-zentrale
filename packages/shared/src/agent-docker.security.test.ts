import { describe, expect, it } from 'vitest';
import {
  composeProjectSchema,
  dockerRpcParams,
  imageIdSchema,
  imagePullRefSchema,
  networkIdSchema,
  volumeNameSchema,
} from './agent-docker.js';
import { parseRpc } from './agent-protocol.js';
import { consoleQuerySchema } from './api/console-wall.js';
import { containerRemoveRequestSchema, stackActionParamsSchema } from './api/docker.js';

const rpc = (action: string, params: unknown) =>
  parseRpc({ type: 'rpc', id: 'abcdefgh1234', action, params });

describe('M23 docker schemas (security)', () => {
  it('image refs never look like options, URLs or shell', () => {
    for (const ok of [
      'nginx',
      'nginx:1.27',
      'ghcr.io/puffybooy/homelab-agent:latest',
      'localhost:5000/team/app:v1.2.3',
      `library/redis@sha256:${'a'.repeat(64)}`,
    ]) {
      expect(imagePullRefSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      '-v',
      '--help',
      'https://evil.example/x',
      'nginx;rm -rf /',
      'nginx latest',
      'Nginx',
      'nginx:$(id)',
      '../x',
      'a\nb',
      '',
    ]) {
      expect(imagePullRefSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('ids and names are strict', () => {
    expect(imageIdSchema.safeParse(`sha256:${'0'.repeat(64)}`).success).toBe(true);
    expect(imageIdSchema.safeParse('nginx').success).toBe(false);
    expect(networkIdSchema.safeParse('bridge').success).toBe(false);
    expect(volumeNameSchema.safeParse('-rf').success).toBe(false);
    expect(volumeNameSchema.safeParse('../etc').success).toBe(false);
    expect(volumeNameSchema.safeParse('/var/lib').success).toBe(false);
    expect(composeProjectSchema.safeParse('My Stack').success).toBe(false);
    expect(composeProjectSchema.safeParse('-p').success).toBe(false);
  });

  it('no action accepts a path, a command or force', () => {
    for (const [action, schema] of Object.entries(dockerRpcParams)) {
      const keys = Object.keys(schema.shape);
      for (const k of keys) {
        expect(['dir', 'path', 'command', 'cmd', 'force', 'args', 'file', 'files']).not.toContain(
          k,
        );
      }
      expect(action).toMatch(/^[a-z]+\.[a-z]+$/);
    }
    expect(rpc('container.remove', { id: 'web', force: true }).ok).toBe(false);
    expect(rpc('stack.op', { project: 'web', op: 'down', dir: '/etc' }).ok).toBe(false);
    expect(rpc('stack.op', { project: 'web', op: 'exec' }).ok).toBe(false);
    expect(rpc('volume.remove', { name: 'data', force: true }).ok).toBe(false);
    expect(rpc('image.pull', { ref: 'nginx', auth: { username: 'x' } }).ok).toBe(false);
  });

  it('container.remove keeps named volumes unless asked, never forces', () => {
    const r = rpc('container.remove', { id: 'web' });
    expect(r.ok && r.request.params).toEqual({ id: 'web', removeVolumes: false });
  });

  it('pty.open takes only a container ref, never a command', () => {
    expect(rpc('pty.open', { cols: 80, rows: 24 }).ok).toBe(true);
    expect(rpc('pty.open', { cols: 80, rows: 24, container: 'web' }).ok).toBe(true);
    expect(rpc('pty.open', { cols: 80, rows: 24, container: 'web; id' }).ok).toBe(false);
    expect(rpc('pty.open', { cols: 80, rows: 24, container: '-u' }).ok).toBe(false);
    expect(rpc('pty.open', { cols: 80, rows: 24, command: 'bash' }).ok).toBe(false);
  });

  it('API inputs are strict', () => {
    expect(consoleQuerySchema.safeParse({ serverId: 's1', container: 'ctr_abcdefgh' }).success).toBe(
      true,
    );
    expect(consoleQuerySchema.safeParse({ serverId: 's1', container: 'a b' }).success).toBe(false);
    expect(containerRemoveRequestSchema.safeParse({ confirmName: 'x', force: true }).success).toBe(
      false,
    );
    expect(
      stackActionParamsSchema.safeParse({ serverId: 's', project: 'web', op: 'pull' }).success,
    ).toBe(false);
  });
});

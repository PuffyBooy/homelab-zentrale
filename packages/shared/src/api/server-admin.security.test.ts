import { describe, expect, it } from 'vitest';
import {
  agentEventSchema,
  duDataSchema,
  hostDirPathSchema,
  inventorySchema,
  isDeniedServiceUnit,
  parseRpc,
  processInfoSchema,
  serviceUnitSchema,
} from '../agent-protocol.js';
import { cleanupRequestSchema, duQuerySchema, shutdownRequestSchema } from './server-admin.js';
import { updateNowRequestSchema, updatePolicySchema, updateWindowSchema } from './updates.js';

const rpc = (action: string, params: unknown) =>
  parseRpc({ type: 'rpc', id: 'abcdefgh12', action, params });

describe('M16 host paths for system.du', () => {
  it.each(['/', '/var', '/var/lib/docker', '/home/alex', '/volume1/Daten mit Leerzeichen'])(
    'accepts %s',
    (p) => expect(hostDirPathSchema.safeParse(p).success).toBe(true),
  );
  it.each([
    '',
    'var',
    './var',
    '/var/',
    '/var//log',
    '/var/../etc',
    '/var/./log',
    '/proc',
    '/proc/1/root',
    '/sys/block',
    '/dev',
    '/run/secrets',
    '/var\u0000x',
    '/var\nlog',
    `/${'a'.repeat(300)}`,
  ])('rejects %j', (p) => expect(hostDirPathSchema.safeParse(p).success).toBe(false));

  it('defaults the query to / and still validates it', () => {
    expect(duQuerySchema.parse({})).toEqual({ path: '/' });
    expect(duQuerySchema.safeParse({ path: '/proc/self' }).success).toBe(false);
    expect(duQuerySchema.safeParse({ path: '/', extra: 1 }).success).toBe(false);
  });

  it('caps the du result', () => {
    const entries = Array.from({ length: 31 }, (_, i) => ({ name: `d${i}`, bytes: 1, dir: true }));
    expect(
      duDataSchema.safeParse({ path: '/', totalBytes: 1, entries, truncated: false }).success,
    ).toBe(false);
  });
});

describe('M16 service units', () => {
  it.each(['nginx.service', 'smbd.service', 'getty@tty1.service', 'foo-bar_1.2.service'])(
    'accepts %s',
    (u) => expect(serviceUnitSchema.safeParse(u).success).toBe(true),
  );
  it.each([
    'nginx',
    'nginx.socket',
    '-nginx.service',
    '../x.service',
    'a b.service',
    'x;reboot.service',
    'x\\x2d.service',
    '--now.service',
  ])('rejects %j', (u) => expect(serviceUnitSchema.safeParse(u).success).toBe(false));

  it.each([
    'tailscaled.service',
    'docker.service',
    'ssh.service',
    'sshd.service',
    'systemd-networkd.service',
    'systemd-anything.service',
    'getty@tty1.service',
  ])('denies %s whatever the agent allowlist says', (u) =>
    expect(isDeniedServiceUnit(u)).toBe(true),
  );
  it('does not deny ordinary services', () => {
    expect(isDeniedServiceUnit('nginx.service')).toBe(false);
    expect(isDeniedServiceUnit('smbd.service')).toBe(false);
  });

  it('rejects unknown service ops', () => {
    expect(rpc('system.service', { unit: 'nginx.service', op: 'restart' }).ok).toBe(true);
    expect(rpc('system.service', { unit: 'nginx.service', op: 'mask' }).ok).toBe(false);
    expect(rpc('system.service', { unit: 'nginx.service', op: 'restart', now: true }).ok).toBe(
      false,
    );
  });
});

describe('M16 RPC params', () => {
  it('bounds the process list and never carries a command line', () => {
    expect(rpc('system.processes', { sort: 'cpu', limit: 25 }).ok).toBe(true);
    expect(rpc('system.processes', { sort: 'cpu', limit: 51 }).ok).toBe(false);
    expect(rpc('system.processes', { sort: 'pid', limit: 5 }).ok).toBe(false);
    const p = { pid: 1, name: 'node', user: 'root', cpu: 1, memBytes: 1, memPct: 1, state: 'S' };
    expect(processInfoSchema.safeParse(p).success).toBe(true);
    expect(processInfoSchema.safeParse({ ...p, command: 'node --token=x' }).success).toBe(false);
  });

  it('shutdown needs the server name, nothing else', () => {
    expect(rpc('system.shutdown', { confirmName: 'pi' }).ok).toBe(true);
    expect(rpc('system.shutdown', {}).ok).toBe(false);
    expect(rpc('system.shutdown', { confirmName: 'pi', delay: 0 }).ok).toBe(false);
    expect(shutdownRequestSchema.safeParse({ confirmName: 'PI; poweroff' }).success).toBe(false);
  });

  it('cleanup items are a closed list without duplicates', () => {
    expect(rpc('system.cleanup', {}).ok).toBe(true);
    expect(rpc('system.cleanup', { items: ['docker-images'] }).ok).toBe(true);
    expect(rpc('system.cleanup', { items: ['docker-volumes'] }).ok).toBe(false);
    expect(rpc('system.cleanup', { items: ['journal', 'journal'] }).ok).toBe(false);
    expect(rpc('system.cleanup', { items: [] }).ok).toBe(false);
    expect(cleanupRequestSchema.parse(undefined)).toEqual({});
  });

  it('read-only actions take no params', () => {
    for (const a of ['system.dockerDf', 'system.services', 'system.upgrade']) {
      expect(rpc(a, {}).ok).toBe(true);
      expect(rpc(a, { args: ['-y'] }).ok).toBe(false);
    }
  });

  it('failed services in the inventory are bounded', () => {
    const base = {
      type: 'inventory',
      ts: new Date().toISOString(),
      system: { hostname: 'h', os: 'o', kernel: 'k', arch: 'x64' },
      containers: [],
      updates: null,
      rebootRequired: false,
      sshFailed24h: null,
      fail2banBanned: null,
      listeningPorts: [],
    };
    expect(inventorySchema.safeParse({ ...base, failedServices: ['x.service'] }).success).toBe(
      true,
    );
    const many = Array.from({ length: 51 }, (_, i) => `u${i}.service`);
    expect(inventorySchema.safeParse({ ...base, failedServices: many }).success).toBe(false);
  });
});

describe('M17 update protocol', () => {
  it('update targets are agent and core only, never an arbitrary image', () => {
    expect(rpc('update.check', { target: 'agent' }).ok).toBe(true);
    expect(rpc('update.check', { target: 'core' }).ok).toBe(true);
    expect(rpc('update.check', { target: 'nginx' }).ok).toBe(false);
    expect(rpc('update.check', { target: 'agent', image: 'evil/agent:latest' }).ok).toBe(false);
    expect(rpc('update.apply', { target: 'core', runId: 'run_abcdefgh' }).ok).toBe(true);
    expect(rpc('update.apply', { target: 'core', runId: 'x' }).ok).toBe(false);
    expect(rpc('update.apply', { target: 'core', runId: 'run_abcdefgh', ref: 'a:b' }).ok).toBe(
      false,
    );
  });

  it('update_result events are validated strictly', () => {
    const ev = (event: unknown) =>
      agentEventSchema.safeParse({ type: 'event', ts: new Date().toISOString(), event });
    const from = { imageId: `sha256:${'a'.repeat(64)}`, version: 'sha-1a2b3c4' };
    expect(
      ev({
        kind: 'update_result',
        runId: 'run_abcdefgh',
        target: 'agent',
        outcome: 'updated',
        from,
      }).success,
    ).toBe(true);
    expect(
      ev({ kind: 'update_result', runId: 'run_abcdefgh', target: 'agent', outcome: 'exploded' })
        .success,
    ).toBe(false);
    expect(
      ev({
        kind: 'update_result',
        runId: 'run_abcdefgh',
        target: 'agent',
        outcome: 'failed',
        message: 'x'.repeat(301),
      }).success,
    ).toBe(false);
    expect(
      ev({
        kind: 'update_result',
        runId: 'run_abcdefgh',
        target: 'agent',
        outcome: 'updated',
        from: { imageId: 'latest' },
      }).success,
    ).toBe(false);
  });

  it('policy defaults: images on, OS and reboot off, nightly window', () => {
    expect(updatePolicySchema.parse({})).toEqual({
      agent: true,
      core: true,
      os: false,
      reboot: false,
      window: { days: [1, 2, 3, 4, 5, 6, 7], start: '03:00', durationMin: 120 },
    });
  });

  it('rejects broken windows', () => {
    const ok = { days: [1], start: '03:00', durationMin: 60 };
    expect(updateWindowSchema.safeParse(ok).success).toBe(true);
    expect(updateWindowSchema.safeParse({ ...ok, days: [] }).success).toBe(false);
    expect(updateWindowSchema.safeParse({ ...ok, days: [0] }).success).toBe(false);
    expect(updateWindowSchema.safeParse({ ...ok, days: [1, 1] }).success).toBe(false);
    expect(updateWindowSchema.safeParse({ ...ok, start: '24:00' }).success).toBe(false);
    expect(updateWindowSchema.safeParse({ ...ok, durationMin: 10 }).success).toBe(false);
    expect(updateWindowSchema.safeParse({ ...ok, durationMin: 600 }).success).toBe(false);
  });

  it('manual runs are agent, core or os only', () => {
    expect(updateNowRequestSchema.safeParse({ target: 'os' }).success).toBe(true);
    expect(updateNowRequestSchema.safeParse({ target: 'reboot' }).success).toBe(false);
  });
});

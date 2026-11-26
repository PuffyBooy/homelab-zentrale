import { describe, expect, it } from 'vitest';
import type { ListeningPort } from '../agent-protocol.js';
import {
  allowedPortsUpdateRequestSchema,
  isPublicBindAddress,
  MAX_ALLOWED_PORTS,
  newPortAlertTitle,
  parsePortAlertKey,
  portAlertKey,
  portAllowRequestSchema,
  publicListeningPorts,
} from './ports.js';

describe('isPublicBindAddress', () => {
  it('counts wildcard and global binds', () => {
    for (const a of ['0.0.0.0', '::', '*', '[::]', '203.0.113.7', '2001:db8::1', '::ffff:8.8.8.8'])
      expect(isPublicBindAddress(a), a).toBe(true);
  });

  it('ignores loopback, private, Tailscale and link-local binds', () => {
    for (const a of [
      '127.0.0.1',
      '127.0.0.53',
      '::1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.1',
      '192.168.1.10',
      '100.64.0.5',
      '100.127.1.1',
      '169.254.1.1',
      'fe80::1',
      'fd7a:115c:a1e0::5',
      '::ffff:127.0.0.1',
    ])
      expect(isPublicBindAddress(a), a).toBe(false);
  });

  it('treats unknown formats as public', () => {
    expect(isPublicBindAddress('999.1.1.1')).toBe(true);
    expect(isPublicBindAddress('weird')).toBe(true);
  });
});

describe('publicListeningPorts', () => {
  it('groups by proto and port and marks allowed ones', () => {
    const ports: ListeningPort[] = [
      { proto: 'tcp', address: '0.0.0.0', port: 8081, process: 'nginx' },
      { proto: 'tcp', address: '::', port: 8081, process: 'nginx' },
      { proto: 'udp', address: '0.0.0.0', port: 8081 },
      { proto: 'tcp', address: '127.0.0.1', port: 5432, process: 'postgres' },
      { proto: 'tcp', address: '0.0.0.0', port: 22, process: 'sshd' },
    ];
    expect(publicListeningPorts(ports, [{ proto: 'tcp', port: 22 }])).toEqual([
      { proto: 'tcp', port: 22, addresses: ['0.0.0.0'], process: 'sshd', allowed: true },
      { proto: 'tcp', port: 8081, addresses: ['0.0.0.0', '::'], process: 'nginx', allowed: false },
      { proto: 'udp', port: 8081, addresses: ['0.0.0.0'], process: null, allowed: false },
    ]);
  });
});

describe('alert key and title', () => {
  it('round-trips the key', () => {
    const key = portAlertKey('srv_12345678', 'tcp', 8081);
    expect(key).toBe('port:srv_12345678:tcp:8081');
    expect(parsePortAlertKey(key)).toEqual({ serverId: 'srv_12345678', proto: 'tcp', port: 8081 });
  });

  it('rejects other keys', () => {
    for (const k of [
      'server:srv_12345678:offline',
      'port:srv_12345678:sctp:80',
      'port:srv_12345678:tcp:0',
      'port:srv_12345678:tcp:65536',
      'port:../x:tcp:80',
      'port:srv_12345678:tcp:80:x',
    ])
      expect(parsePortAlertKey(k), k).toBeNull();
  });

  it('has the documented title', () => {
    expect(newPortAlertTitle(8081, 'tcp', 'nginx')).toBe('Neuer offener Port 8081 (nginx)');
    expect(newPortAlertTitle(27015, 'udp')).toBe('Neuer offener Port 27015 (UDP)');
  });
});

describe('allowed list', () => {
  it('accepts up to the limit', () => {
    const ports = Array.from({ length: MAX_ALLOWED_PORTS }, (_, i) => ({
      port: i + 1,
      proto: 'tcp' as const,
    }));
    expect(allowedPortsUpdateRequestSchema.safeParse({ ports }).success).toBe(true);
    expect(
      allowedPortsUpdateRequestSchema.safeParse({ ports: [...ports, { port: 9999, proto: 'udp' }] })
        .success,
    ).toBe(false);
  });

  it('rejects duplicates, bad ports, protos and long notes', () => {
    const bad: unknown[] = [
      {
        ports: [
          { port: 22, proto: 'tcp' },
          { port: 22, proto: 'tcp' },
        ],
      },
      { ports: [{ port: 0, proto: 'tcp' }] },
      { ports: [{ port: 65536, proto: 'tcp' }] },
      { ports: [{ port: 22.5, proto: 'tcp' }] },
      { ports: [{ port: '22', proto: 'tcp' }] },
      { ports: [{ port: 22, proto: 'sctp' }] },
      { ports: [{ port: 22, proto: 'tcp', note: 'x'.repeat(81) }] },
      { ports: [{ port: 22, proto: 'tcp', address: '0.0.0.0' }] },
      { ports: 'all' },
    ];
    for (const b of bad) expect(allowedPortsUpdateRequestSchema.safeParse(b).success).toBe(false);
    expect(
      allowedPortsUpdateRequestSchema.safeParse({
        ports: [
          { port: 22, proto: 'tcp' },
          { port: 22, proto: 'udp' },
        ],
      }).success,
    ).toBe(true);
  });

  it('allow request is strict', () => {
    expect(portAllowRequestSchema.safeParse({ port: 8081, proto: 'tcp' }).success).toBe(true);
    expect(
      portAllowRequestSchema.safeParse({ port: 8081, proto: 'tcp', serverId: 'x' }).success,
    ).toBe(false);
  });
});

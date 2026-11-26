import { describe, expect, it } from 'vitest';
import { rpcParamsByAction, tailnetIpSchema } from '../agent-protocol.js';
import { dnsNameSchema, ingressUpdateRequestSchema, publicIpv4Schema } from './relay.js';

const route = {
  id: 'game1234:game',
  protocol: 'tcp',
  listenPort: 25565,
  count: 1,
  target: { host: '100.64.0.5', port: 25565 },
};

describe('M15 relay schemas (security)', () => {
  it('relays only into the tailnet', () => {
    for (const ok of ['100.64.0.5', '100.127.255.254', 'fd7a:115c:a1e0::1']) {
      expect(tailnetIpSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.10',
      '100.128.0.1',
      '100.063.0.1',
      '169.254.169.254',
      '::1',
      'fe80::1',
      'localhost',
      'example.org',
      '0.0.0.0',
    ]) {
      expect(tailnetIpSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('bounds relay routes', () => {
    const set = rpcParamsByAction['relay.set'];
    expect(set.safeParse({ routes: [route] }).success).toBe(true);
    expect(set.safeParse({ routes: [{ ...route, listenPort: 22 }] }).success).toBe(false);
    expect(set.safeParse({ routes: [{ ...route, count: 11 }] }).success).toBe(false);
    expect(
      set.safeParse({ routes: [{ ...route, target: { host: '10.0.0.5', port: 25565 } }] }).success,
    ).toBe(false);
    expect(set.safeParse({ routes: Array(65).fill(route) }).success).toBe(false);
  });

  it('accepts only public IPv4 for an ingress', () => {
    expect(publicIpv4Schema.safeParse('203.0.113.7').success).toBe(true);
    for (const bad of [
      '10.1.2.3',
      '192.168.0.1',
      '172.16.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '224.0.0.1',
      '192.0.0.8',
      '198.18.0.1',
      '198.19.255.1',
      '1.2.3',
    ]) {
      expect(publicIpv4Schema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('limits port ranges and DNS names', () => {
    expect(
      ingressUpdateRequestSchema.safeParse({
        enabled: true,
        publicIp: null,
        portFrom: 20000,
        portTo: 30000,
      }).success,
    ).toBe(false);
    expect(dnsNameSchema.safeParse('MC.Example.org').data).toBe('mc.example.org');
    for (const bad of [
      '*.example.org',
      'localhost',
      'a..b',
      'mc.example.org/x',
      '-a.example.org',
    ]) {
      expect(dnsNameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

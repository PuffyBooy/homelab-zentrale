import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ALLOWED_PORTS,
  allowPort,
  draftRow,
  fetchPortAudit,
  portAlertTarget,
  portAuditSummary,
  portText,
  saveAllowedPorts,
  validateAllowed,
} from './ports.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

const audit = {
  seeded: true,
  allowed: [{ port: 22, proto: 'tcp', note: 'ssh' }],
  open: [
    { proto: 'tcp', port: 22, addresses: ['0.0.0.0'], process: 'sshd', allowed: true },
    { proto: 'tcp', port: 8081, addresses: ['0.0.0.0', '::'], process: 'nginx', allowed: false },
  ],
};

describe('ports api', () => {
  it('GET, PUT and POST allow on the server routes', async () => {
    const fn = vi.fn<typeof fetch>();
    fn.mockResolvedValueOnce(json(200, audit));
    fn.mockResolvedValueOnce(json(200, audit));
    fn.mockResolvedValueOnce(json(200, audit));
    vi.stubGlobal('fetch', fn);
    await fetchPortAudit('srv-000001');
    await saveAllowedPorts('srv-000001', [{ port: 22, proto: 'tcp' }]);
    await allowPort('srv-000001', { port: 8081, proto: 'tcp' });
    expect(fn.mock.calls.map((c) => [c[0], c[1]?.method ?? 'GET', c[1]?.body ?? null])).toEqual([
      ['/api/servers/srv-000001/ports/allowed', 'GET', null],
      ['/api/servers/srv-000001/ports/allowed', 'PUT', '{"ports":[{"port":22,"proto":"tcp"}]}'],
      ['/api/servers/srv-000001/ports/allow', 'POST', '{"port":8081,"proto":"tcp"}'],
    ]);
  });
});

describe('ports helpers', () => {
  it('summarises like a status line', () => {
    expect(portText({ port: 8081, proto: 'tcp' })).toBe('8081/tcp');
    expect(portAuditSummary({ open: audit.open as never })).toEqual({
      status: 'warn',
      label: '1 Port nicht erlaubt',
    });
    expect(portAuditSummary({ open: [] })).toEqual({ status: 'ok', label: 'keine offen' });
    expect(
      portAuditSummary({
        open: [
          { ...audit.open[0], allowed: true },
          { ...audit.open[0], port: 443 },
        ] as never,
      }),
    ).toEqual({ status: 'ok', label: 'alle 2 erlaubt' });
  });

  it('validates the allowed list like the schema', () => {
    const a = { ...draftRow(), port: '22', note: ' ssh ' };
    const b = { ...draftRow(), port: '22' };
    const c = { ...draftRow(), port: '70000' };
    const d = { ...draftRow(), port: '53', proto: 'udp' as const, note: 'x'.repeat(81) };
    const e = { ...draftRow(), port: '22', proto: 'udp' as const };
    const res = validateAllowed([a, b, c, d, e]);
    expect(res.ports).toEqual([
      { port: 22, proto: 'tcp', note: 'ssh' },
      { port: 22, proto: 'udp' },
    ]);
    expect(res.errors).toEqual({
      [`${b.key}:port`]: '22/tcp steht schon in der Liste.',
      [`${c.key}:port`]: 'Port 1 bis 65535.',
      [`${d.key}:note`]: 'Höchstens 80 Zeichen.',
    });
  });

  it('refuses more than 200 entries', () => {
    const rows = Array.from({ length: MAX_ALLOWED_PORTS + 1 }, (_, i) => ({
      ...draftRow(),
      port: String(1000 + i),
    }));
    expect(validateAllowed(rows).errors.list).toBe('Höchstens 200 Ports.');
  });

  it('reads server and port from a port alert key only', () => {
    expect(portAlertTarget('port:srv-000001:tcp:8081')).toEqual({
      serverId: 'srv-000001',
      proto: 'tcp',
      port: 8081,
    });
    expect(portAlertTarget('autostop:ctr-000001')).toBeNull();
    expect(portAlertTarget('port:srv-000001:tcp:70000')).toBeNull();
  });
});

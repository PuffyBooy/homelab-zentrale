import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, json, mockFetch, monitor } from '../test-m14.js';
import {
  canImport,
  importKumaMonitors,
  importSummary,
  kumaStatus,
  monitorTarget,
  needsPingAgent,
  sortMonitors,
} from './kuma.js';

afterEach(() => vi.unstubAllGlobals());

describe('uptime kuma', () => {
  it('maps status to shape and sorts problems first', () => {
    expect(kumaStatus(monitor())).toBe('ok');
    expect(kumaStatus(monitor({ status: 'down' }))).toBe('crit');
    expect(kumaStatus(monitor({ status: 'maintenance' }))).toBe('off');
    const list = sortMonitors([
      monitor({ name: 'b' }),
      monitor({ name: 'a', status: 'down' }),
      monitor({ name: 'c', status: 'pending' }),
    ]);
    expect(list.map((m) => m.name)).toEqual(['a', 'c', 'b']);
  });

  it('shows the target and what can be imported', () => {
    expect(monitorTarget(monitor())).toBe('https://example.at/');
    expect(
      monitorTarget(monitor({ url: null, hostname: 'nas.lan', port: 445, type: 'port' })),
    ).toBe('nas.lan:445');
    expect(canImport(monitor())).toBe(true);
    expect(canImport(monitor({ checkId: 'chk_abcdefgh' }))).toBe(false);
    expect(canImport(monitor({ importAs: null, type: 'docker' }))).toBe(false);
    expect(needsPingAgent([monitor(), monitor({ importAs: 'ping' })])).toBe(true);
  });

  it('sends the names and the ping agent, summarises the result', async () => {
    const fetchMock = mockFetch(
      json(200, { created: 2, skipped: [{ name: 'router', reason: 'Typ nicht unterstützt' }] }),
    );
    const r = await importKumaMonitors(['example.at', 'nas'], 'srv-home0001');
    expect(bodyOf(fetchMock)).toEqual({ names: ['example.at', 'nas'], pingFrom: 'srv-home0001' });
    expect(importSummary(r)).toBe('2 Checks angelegt · 1 übersprungen');
    expect(importSummary({ created: 1, skipped: [] })).toBe('1 Check angelegt');
    mockFetch(json(200, { created: 0, skipped: [] }));
    await importKumaMonitors(['x']);
    const fn = vi.mocked(fetch);
    expect(JSON.parse(String(fn.mock.calls[0]?.[1]?.body))).toEqual({ names: ['x'] });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/log.js';
import {
  GATEWAY_TOKEN,
  SHARE_TOKEN,
  okStatus,
  raw,
  shareHeaders,
  startHarness,
} from './helpers.js';
import type { Harness } from './helpers.js';

describe('logs never contain tokens or PINs', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(() => h.close());

  it('redacts the page path and API credentials', async () => {
    h.setCore(() => ({ body: okStatus }));
    await raw(h.url, `/s/${SHARE_TOKEN}`);
    await raw(h.url, '/s/api/status', { headers: shareHeaders({ 'x-share-pin': '4711' }) });
    await raw(h.url, `/s/${SHARE_TOKEN}/does-not-exist`);
    await raw(h.url, `/s/api/console?after=${SHARE_TOKEN}`, { headers: shareHeaders() });
    h.setCore(() => ({ body: { leaked: GATEWAY_TOKEN } }));
    await raw(h.url, '/s/api/status', { headers: shareHeaders() });
    h.setCore(() => ({ status: 401, body: { ok: false, error: 'pin_wrong', triesLeft: 2 } }));
    await raw(h.url, '/s/api/status', { headers: shareHeaders({ 'x-share-pin': '4711' }) });

    const all = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThanOrEqual(6);
    expect(all).not.toContain(SHARE_TOKEN);
    expect(all).not.toContain(GATEWAY_TOKEN);
    expect(all).not.toContain('4711');
    expect(all).toContain('GET /s/:token');
    expect(all).toContain('GET /s/api/status');
    for (const line of h.logs) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('logger masks secret fields, registered secrets and token-shaped strings', () => {
    const lines: string[] = [];
    const log = createLogger('debug', (l) => lines.push(l));
    log.addSecret(GATEWAY_TOKEN);
    log.info(`url /s/${SHARE_TOKEN}`, {
      authorization: 'Share abc',
      pin: '1234',
      nested: { gatewayToken: 'x', note: `Bearer ${GATEWAY_TOKEN}` },
    });
    const out = lines.join('\n');
    expect(out).not.toContain(SHARE_TOKEN);
    expect(out).not.toContain(GATEWAY_TOKEN);
    expect(out).not.toContain('1234');
    expect(out).not.toContain('Share abc');
  });
});

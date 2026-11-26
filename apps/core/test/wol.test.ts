import { afterEach, describe, expect, it } from 'vitest';
import { WOL_DEFAULTS } from '@hz/shared';
import { openDatabase, type DbHandle } from '../src/db/index.js';
import { readSetting, writeSetting } from '../src/db/settings.js';
import { magicPacket, MAGIC_PACKET_BYTES } from '../src/wol/packet.js';
import { removeWolConfig, wolKey } from '../src/wol/service.js';
import { authHeaders } from './helpers.js';
import { makePluginApp, type PluginApp } from './notify-helpers.js';

const A = 'srv-heim-0001';
const B = 'srv-pi-000002';

let p: PluginApp | undefined;
let h: DbHandle | undefined;
afterEach(async () => {
  await p?.app.close();
  p = undefined;
  h?.close();
  h = undefined;
});

describe('magic packet', () => {
  it('is 6 x 0xFF followed by the MAC 16 times, 102 bytes', () => {
    const packet = magicPacket('01:23:45:67:89:AB');
    expect(packet.length).toBe(MAGIC_PACKET_BYTES);
    const expected = Buffer.concat([
      Buffer.alloc(6, 0xff),
      ...Array.from({ length: 16 }, () => Buffer.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab])),
    ]);
    expect(packet.equals(expected)).toBe(true);
  });

  it('refuses anything but a colon MAC', () => {
    expect(() => magicPacket('01-23-45-67-89-AB')).toThrow();
    expect(() => magicPacket('01:23:45:67:89')).toThrow();
  });
});

describe('wol routes', () => {
  async function app(): Promise<PluginApp> {
    const t = await makePluginApp();
    t.servers.set(A, { id: A, name: 'heimserver' });
    t.servers.set(B, { id: B, name: 'raspi' });
    return t;
  }

  it('GET returns the defaults with mac null before setup', async () => {
    p = await app();
    const res = await p.app.inject({
      method: 'GET',
      url: `/api/servers/${A}/wol`,
      headers: authHeaders(p.cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mac: null, ...WOL_DEFAULTS });
  });

  it('PUT normalizes the MAC, wake sends the packet from the core', async () => {
    p = await app();
    const put = await p.app.inject({
      method: 'PUT',
      url: `/api/servers/${A}/wol`,
      headers: authHeaders(p.cookie),
      payload: { mac: 'aa-bb-cc-dd-ee-01', broadcast: '192.168.1.255' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      mac: 'AA:BB:CC:DD:EE:01',
      broadcast: '192.168.1.255',
      port: 9,
      via: 'core',
    });
    const res = await p.app.inject({
      method: 'POST',
      url: `/api/servers/${A}/wake`,
      headers: authHeaders(p.cookie),
    });
    expect(res.json()).toEqual({ ok: true, via: 'core' });
    expect(p.udp.sent).toHaveLength(1);
    expect(p.udp.sent[0]?.address).toBe('192.168.1.255');
    expect(p.udp.sent[0]?.port).toBe(9);
    expect(p.udp.sent[0]?.packet.equals(magicPacket('AA:BB:CC:DD:EE:01'))).toBe(true);
  });

  it('a failing UDP send is a fixed 500, no details', async () => {
    p = await app();
    await p.app.inject({
      method: 'PUT',
      url: `/api/servers/${A}/wol`,
      headers: authHeaders(p.cookie),
      payload: { mac: 'AA:BB:CC:DD:EE:01' },
    });
    p.udp.fail = true;
    const res = await p.app.inject({
      method: 'POST',
      url: `/api/servers/${A}/wake`,
      headers: authHeaders(p.cookie),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      ok: false,
      error: 'internal',
      message: 'Paket konnte nicht gesendet werden',
    });
  });

  it('PUT mac null removes the entry', async () => {
    p = await app();
    await p.app.inject({
      method: 'PUT',
      url: `/api/servers/${A}/wol`,
      headers: authHeaders(p.cookie),
      payload: { mac: 'AA:BB:CC:DD:EE:01', port: 7 },
    });
    const res = await p.app.inject({
      method: 'PUT',
      url: `/api/servers/${A}/wol`,
      headers: authHeaders(p.cookie),
      payload: { mac: null },
    });
    expect(res.json()).toEqual({ mac: null, ...WOL_DEFAULTS });
    expect(readSetting(p.db.db, wolKey(A))).toBeUndefined();
  });
});

describe('removeWolConfig', () => {
  it('forgets the entry of a deleted server; servers that used it as sender fall back to the core', () => {
    h = openDatabase(':memory:');
    const entry = { mac: 'AA:BB:CC:DD:EE:01', broadcast: '255.255.255.255', port: 9 };
    writeSetting(h.db, wolKey(A), { ...entry, via: B }, 0);
    writeSetting(h.db, wolKey(B), { ...entry, via: 'core' }, 0);
    writeSetting(h.db, 'wolfish', { keep: true }, 0);
    removeWolConfig(h.db, B, 1);
    expect(readSetting(h.db, wolKey(B))).toBeUndefined();
    expect(readSetting(h.db, wolKey(A))).toEqual({ ...entry, via: 'core' });
    expect(readSetting(h.db, 'wolfish')).toEqual({ keep: true });
  });
});

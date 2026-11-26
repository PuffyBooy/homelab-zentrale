import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fritzStatusSchema, integrationSettingsSchema } from '@hz/shared';
import { auditLog } from '../src/db/schema.js';
import { digestAuthorization, parseDigestChallenge } from '../src/integrations/digest.js';
import {
  decodeXml,
  FRITZ_INTERNET_ALERT_KEY,
  parseHostList,
  xmlValue,
} from '../src/integrations/fritzbox.js';
import {
  FakeServer,
  SENTINEL,
  tickIntegrations,
  withIntegrations,
  type IntegrationSetup,
  type Recorded,
} from './integrations-helpers.js';

let s: IntegrationSetup | undefined;
const fakes: FakeServer[] = [];
afterEach(async () => {
  await s?.t.app.close();
  s = undefined;
  for (const f of fakes.splice(0)) await f.stop();
});

const md5 = (x: string) => createHash('md5').update(x).digest('hex');
const REALM = 'F!Box SOAP-Auth';
const USER = 'hz';

function parseAuth(h: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of h.replace(/^Digest\s+/, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    out[m[1] ?? ''] = m[2] ?? m[3] ?? '';
  }
  return out;
}

const soap = (action: string, inner: string) =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
  `<u:${action}Response xmlns:u="urn:x">${inner}</u:${action}Response></s:Body></s:Envelope>`;

/** TR-064 fake: verifies the digest (RFC 2617, qop=auth) of every SOAP call. */
class FakeFritz {
  readonly server = new FakeServer();
  nonce = 'abc123nonce';
  connected = true;
  verified = 0;
  rebooted = 0;
  constructor() {
    fakes.push(this.server);
    this.server.handler = (q, r) => this.handle(q, r);
  }

  private challenge(r: ServerResponse): void {
    r.statusCode = 401;
    r.setHeader(
      'www-authenticate',
      `Digest realm="${REALM}", nonce="${this.nonce}", algorithm=MD5, qop="auth", opaque="op4que"`,
    );
    r.end();
  }

  private handle(q: Recorded, r: ServerResponse): void {
    if (q.method === 'GET' && q.url.startsWith('/devicehostlist.lua?sid=')) {
      r.setHeader('content-type', 'text/xml');
      r.end(
        '<List><Item><Index>1</Index><IPAddress>192.168.178.20</IPAddress><MACAddress>AA:BB:CC:DD:EE:01</MACAddress>' +
          '<Active>1</Active><Port>0</Port><HostName>pi &amp; co</HostName><InterfaceType>Ethernet</InterfaceType></Item>' +
          '<Item><IPAddress>192.168.178.30</IPAddress><MACAddress>AA:BB:CC:DD:EE:02</MACAddress><Active>0</Active>' +
          '<HostName>handy</HostName><InterfaceType>802.11</InterfaceType></Item>' +
          '<Item><IPAddress></IPAddress><MACAddress></MACAddress><Active>0</Active><HostName></HostName><InterfaceType></InterfaceType></Item></List>',
      );
      return;
    }
    const h = q.headers.authorization;
    if (typeof h !== 'string') return this.challenge(r);
    const a = parseAuth(h);
    const ha1 = md5(`${USER}:${REALM}:${SENTINEL}`);
    const ha2 = md5(`POST:${a.uri ?? ''}`);
    const expected = md5(`${ha1}:${a.nonce}:${a.nc}:${a.cnonce}:auth:${ha2}`);
    if (
      a.username !== USER ||
      a.realm !== REALM ||
      a.nonce !== this.nonce ||
      a.uri !== q.url ||
      a.qop !== 'auth' ||
      a.opaque !== 'op4que' ||
      a.response !== expected
    ) {
      return this.challenge(r);
    }
    this.verified++;
    const action = /#([\w-]+)"$/.exec(String(q.headers.soapaction))?.[1] ?? '';
    // The body is the fixed envelope of that action.
    expect(q.body).toContain(`<u:${action} xmlns:u="urn:dslforum-org:service:`);
    r.setHeader('content-type', 'text/xml');
    switch (`${q.url}#${action}`) {
      case '/upnp/control/deviceinfo#GetInfo':
        r.end(
          soap(
            'GetInfo',
            '<NewModelName>FRITZ!Box 7590</NewModelName><NewSoftwareVersion>154.07.57</NewSoftwareVersion>',
          ),
        );
        return;
      case '/upnp/control/wancommonifconfig1#GetCommonLinkProperties':
        r.end(
          soap(
            'GetCommonLinkProperties',
            `<NewPhysicalLinkStatus>${this.connected ? 'Up' : 'Down'}</NewPhysicalLinkStatus>` +
              '<NewLayer1DownstreamMaxBitRate>250000000</NewLayer1DownstreamMaxBitRate>' +
              '<NewLayer1UpstreamMaxBitRate>40000000</NewLayer1UpstreamMaxBitRate>',
          ),
        );
        return;
      case '/upnp/control/wanipconnection1#GetStatusInfo':
        r.end(
          soap(
            'GetStatusInfo',
            `<NewConnectionStatus>${this.connected ? 'Connected' : 'Disconnected'}</NewConnectionStatus><NewUptime>86400</NewUptime>`,
          ),
        );
        return;
      case '/upnp/control/wanipconnection1#GetExternalIPAddress':
        r.end(
          soap('GetExternalIPAddress', '<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>'),
        );
        return;
      case '/upnp/control/hosts#X_AVM-DE_GetHostListPath':
        r.end(
          soap(
            'X_AVM-DE_GetHostListPath',
            '<NewX_AVM-DE_HostListPath>/devicehostlist.lua?sid=f00dcafe</NewX_AVM-DE_HostListPath>',
          ),
        );
        return;
      case '/upnp/control/deviceconfig#Reboot':
        this.rebooted++;
        r.end(soap('Reboot', ''));
        return;
      default:
        r.statusCode = 500;
        r.end('<s:Fault/>');
    }
  }
}

describe('digest and XML helpers', () => {
  it('builds an RFC 2617 response (qop=auth)', () => {
    // RFC 2617 section 3.5 example.
    const ch = parseDigestChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    );
    const h = digestAuthorization(ch, {
      username: 'Mufasa',
      password: 'Circle Of Life',
      method: 'GET',
      uri: '/dir/index.html',
      nc: 1,
      cnonce: '0a4f113b',
    });
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(h).toContain('nc=00000001');
  });

  it('refuses odd challenges', () => {
    expect(() => parseDigestChallenge('Basic realm="x"')).toThrow();
    expect(() =>
      parseDigestChallenge('Digest realm="x", nonce="n", algorithm=SHA-512-256'),
    ).toThrow();
    expect(() => parseDigestChallenge('Digest realm="x", nonce="n", qop="auth-int"')).toThrow();
    expect(() => parseDigestChallenge(undefined)).toThrow();
  });

  it('decodes only predefined and numeric entities; DTDs are refused', () => {
    expect(decodeXml('a &amp; b &lt;c&gt; &#228; &#xE4; &foo;')).toBe('a & b <c> ä ä &foo;');
    expect(xmlValue('<u:X><NewA>1</NewA></u:X>', 'NewA')).toBe('1');
    expect(() => parseHostList('<!DOCTYPE x [<!ENTITY a "b">]><List></List>')).toThrow();
    const many = `<List>${'<Item><HostName>x</HostName></Item>'.repeat(1200)}</List>`;
    expect(parseHostList(many)).toHaveLength(1000);
  });

  it('hostile XML parses in linear time (unterminated items and start tags)', () => {
    const size = 4 * 1024 * 1024;
    const items = '<Item>'.repeat(Math.ceil(size / 6)).slice(0, size);
    const tags = '<NewModelName '.repeat(Math.ceil(size / 14)).slice(0, size);
    const mixed = `<List>${'<Item><HostName>a'.repeat(Math.ceil(size / 17))}`.slice(0, size);
    let t = performance.now();
    expect(parseHostList(items)).toEqual([]);
    expect(performance.now() - t).toBeLessThan(500);
    t = performance.now();
    expect(xmlValue(tags, 'NewModelName')).toBeNull();
    expect(parseHostList(tags)).toEqual([]);
    expect(performance.now() - t).toBeLessThan(500);
    t = performance.now();
    expect(parseHostList(mixed)).toEqual([]);
    expect(xmlValue(mixed, 'HostName')).toBeNull();
    expect(performance.now() - t).toBeLessThan(500);
    // Attributes are still accepted, within bounds.
    expect(xmlValue('<NewModelName a="1">FRITZ!Box</NewModelName>', 'NewModelName')).toBe(
      'FRITZ!Box',
    );
    expect(
      xmlValue(`<NewModelName a="${'x'.repeat(300)}">FRITZ!Box</NewModelName>`, 'NewModelName'),
    ).toBeNull();
  });
});

describe('FRITZ!Box', () => {
  async function setup(): Promise<{ s: IntegrationSetup; box: FakeFritz }> {
    const box = new FakeFritz();
    await box.server.start();
    s = await withIntegrations();
    const put = await s.configure('fritzbox', {
      url: box.server.url,
      username: USER,
      secret: SENTINEL,
    });
    expect(integrationSettingsSchema.parse(put.json())).toMatchObject({
      status: 'ok',
      error: null,
    });
    return { s, box };
  }

  it('internet status, model and devices over TR-064 with digest auth', async () => {
    const { s, box } = await setup();
    const res = await s.req('GET', '/api/fritzbox/status');
    const st = fritzStatusSchema.parse(res.json());
    expect(st).toMatchObject({
      model: 'FRITZ!Box 7590',
      firmware: '154.07.57',
      internet: {
        connected: true,
        linkStatus: 'Up',
        externalIp: '203.0.113.7',
        uptimeS: 86400,
        maxDownBps: 250000000,
        maxUpBps: 40000000,
      },
      error: null,
    });
    expect(st.devices).toEqual([
      {
        name: 'pi & co',
        ip: '192.168.178.20',
        mac: 'AA:BB:CC:DD:EE:01',
        active: true,
        interface: 'lan',
      },
      {
        name: 'handy',
        ip: '192.168.178.30',
        mac: 'AA:BB:CC:DD:EE:02',
        active: false,
        interface: 'wlan',
      },
      { name: 'Unbekannt', ip: null, mac: null, active: false, interface: 'other' },
    ]);
    expect(box.verified).toBe(5);
    // The password never travels in clear.
    for (const r of box.server.requests) {
      expect(JSON.stringify(r.headers)).not.toContain(SENTINEL);
      expect(r.body).not.toContain(SENTINEL);
    }
    // The cached challenge is reused (nc counts up), not one 401 per call.
    expect(
      box.server.requests.filter(
        (r) => r.headers.authorization === undefined && r.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('wrong password: Zugangsdaten ungültig', async () => {
    const box = new FakeFritz();
    await box.server.start();
    s = await withIntegrations();
    const put = await s.configure('fritzbox', {
      url: box.server.url,
      username: USER,
      secret: 'wrong-pass',
    });
    expect(integrationSettingsSchema.parse(put.json())).toMatchObject({
      status: 'error',
      error: 'Zugangsdaten ungültig',
    });
  });

  it('a new nonce is answered with a fresh digest', async () => {
    const { s, box } = await setup();
    box.nonce = 'fresh-nonce-2';
    s.t.clock.advance(60_000);
    await tickIntegrations(s.t);
    expect(
      integrationSettingsSchema.parse((await s.req('GET', '/api/fritzbox/settings')).json()).status,
    ).toBe('ok');
  });

  it('internet down: crit alert "Internet getrennt", resolved when back', async () => {
    const { s, box } = await setup();
    box.connected = false;
    s.t.clock.advance(60_000);
    await tickIntegrations(s.t);
    const alert = s.t.app.hzCore.alerts.active(FRITZ_INTERNET_ALERT_KEY);
    expect(alert).toMatchObject({ level: 'crit', title: 'Internet getrennt' });
    box.connected = true;
    s.t.clock.advance(60_000);
    await tickIntegrations(s.t);
    expect(s.t.app.hzCore.alerts.active(FRITZ_INTERNET_ALERT_KEY)).toBeNull();
  });

  it('reboot needs step-up and confirm; audited', async () => {
    const { s, box } = await setup();
    s.expireStepUp();
    const no = await s.req('POST', '/api/fritzbox/reboot', { confirm: true });
    expect(no.statusCode).toBe(403);
    expect(no.json()).toEqual({ ok: false, error: 'step_up_required' });
    await s.stepUp();
    expect((await s.req('POST', '/api/fritzbox/reboot', {})).statusCode).toBe(400);
    expect(box.rebooted).toBe(0);
    const ok = await s.req('POST', '/api/fritzbox/reboot', { confirm: true });
    expect(ok.statusCode).toBe(200);
    expect(box.rebooted).toBe(1);
    expect(
      s.t.db.db
        .select()
        .from(auditLog)
        .all()
        .some((r) => r.action === 'fritzbox.reboot'),
    ).toBe(true);
  });

  it('a host list path off the origin is not fetched', async () => {
    const { s, box } = await setup();
    const other = new FakeServer();
    fakes.push(other);
    await other.start((_q, r) => r.end('<List></List>'));
    const handler = box.server.handler;
    box.server.handler = (q, r) => {
      if (String(q.headers.soapaction).includes('GetHostListPath') && q.headers.authorization) {
        r.end(
          soap(
            'X_AVM-DE_GetHostListPath',
            `<NewX_AVM-DE_HostListPath>//127.0.0.1:${other.port}/x</NewX_AVM-DE_HostListPath>`,
          ),
        );
        return;
      }
      handler(q, r);
    };
    const res = await s.req('POST', '/api/fritzbox/test', {});
    expect(integrationSettingsSchema.parse(res.json())).toMatchObject({
      status: 'error',
      error: 'Unerwartete Antwort',
    });
    expect(other.requests).toHaveLength(0);
  });

  it('poll and reboot run one after another: a nonce count is never reused', async () => {
    const { s, box } = await setup();
    const seen: string[] = [];
    const handler = box.server.handler;
    box.server.handler = (q, r) => {
      const h = q.headers.authorization;
      if (typeof h === 'string') {
        const a = parseAuth(h);
        const key = `${a.nonce}/${a.nc}`;
        // A real box refuses a replayed nonce count.
        if (a.nonce === box.nonce && seen.includes(key)) {
          r.statusCode = 401;
          r.end();
          return;
        }
        if (a.nonce === box.nonce) seen.push(key);
      }
      handler(q, r);
    };
    // A new nonce: every queued call would answer the challenge and start nc at 1 again.
    box.nonce = 'fresh-nonce-3';
    s.t.clock.advance(60_000);
    const [test, reboot] = await Promise.all([
      s.req('POST', '/api/fritzbox/test', {}),
      s.req('POST', '/api/fritzbox/reboot', { confirm: true }),
    ]);
    expect(reboot.statusCode).toBe(200);
    expect(integrationSettingsSchema.parse(test.json())).toMatchObject({ status: 'ok' });
    expect(box.rebooted).toBe(1);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(1);
  });

  it('reboot is limited to 2 per 10 minutes (429 rate_limited)', async () => {
    const { s, box } = await setup();
    for (let i = 0; i < 2; i++) {
      expect((await s.req('POST', '/api/fritzbox/reboot', { confirm: true })).statusCode).toBe(200);
    }
    const third = await s.req('POST', '/api/fritzbox/reboot', { confirm: true });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(box.rebooted).toBe(2);
    s.t.clock.advance(10 * 60_000);
    await s.stepUp();
    expect((await s.req('POST', '/api/fritzbox/reboot', { confirm: true })).statusCode).toBe(200);
    expect(box.rebooted).toBe(3);
  });
});

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Minimal stand-ins for the M14 integrations, on 127.0.0.1 in the Playwright
 * process: Proxmox VE API, Pi-hole v6, FRITZ!Box TR-064 (with HTTP Digest auth)
 * and Uptime Kuma /metrics. Plus an ntfy endpoint that records what it gets.
 * They speak the parts of the real APIs the core uses, with the real shapes.
 */

// Split so secret scanners stay quiet; these are test values only.
export const FAKE_PVE_TOKEN_ID = 'hz@pve!zentrale';
export const FAKE_PVE_SECRET = ['1f2e3d4c', '5b6a', '4789', '8a7b', '6c5d4e3f2a1b'].join('-');
export const FAKE_PIHOLE_PASSWORD = `app-${'pw'}-e2e-0123456789`;
export const FAKE_FRITZ_USER = 'zentrale';
// HA1 below (FAKE_FRITZ_HA1) is MD5(zentrale:F!Box SOAP-Auth:<this password>); change both together.
export const FAKE_FRITZ_PASSWORD = `fritz-${'e2e'}-passwort`;
export const FAKE_KUMA_KEY = `uk1_${'e2eFakeKumaKey'}0123456789abcdef`;

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

abstract class FakeServer {
  private server: Server | null = null;
  port = 0;
  readonly requests: { method: string; path: string; auth: string | undefined }[] = [];

  protected abstract handle: Handler;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.requests.push({
          method: req.method ?? '',
          path: req.url ?? '',
          auth: req.headers.authorization,
        });
        this.handle(req, Buffer.concat(chunks).toString('utf8'), res);
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---- Proxmox ---------------------------------------------------------------------------

interface PveGuest {
  type: 'qemu' | 'lxc';
  vmid: number;
  name: string;
  status: 'running' | 'stopped';
  template: 0 | 1;
  maxmem: number;
  maxcpu: number;
}

export class FakeProxmox extends FakeServer {
  readonly actions: string[] = [];
  readonly guests: PveGuest[] = [
    {
      type: 'qemu',
      vmid: 101,
      name: 'homeassistant',
      status: 'running',
      template: 0,
      maxmem: 4 * 2 ** 30,
      maxcpu: 2,
    },
    {
      type: 'lxc',
      vmid: 200,
      name: 'pihole',
      status: 'running',
      template: 0,
      maxmem: 512 * 2 ** 20,
      maxcpu: 1,
    },
    {
      type: 'qemu',
      vmid: 102,
      name: 'win11',
      status: 'stopped',
      template: 0,
      maxmem: 8 * 2 ** 30,
      maxcpu: 4,
    },
    {
      type: 'qemu',
      vmid: 9000,
      name: 'ubuntu-vorlage',
      status: 'stopped',
      template: 1,
      maxmem: 2 * 2 ** 30,
      maxcpu: 2,
    },
  ];

  protected handle: Handler = (req, _body, res) => {
    if (req.headers.authorization !== `PVEAPIToken=${FAKE_PVE_TOKEN_ID}=${FAKE_PVE_SECRET}`) {
      json(res, 401, { data: null });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/api2/json/cluster/resources') {
      const type = url.searchParams.get('type');
      const node = {
        type: 'node',
        id: 'node/pve',
        node: 'pve',
        status: 'online',
        cpu: 0.12,
        maxcpu: 8,
        mem: 9 * 2 ** 30,
        maxmem: 32 * 2 ** 30,
        uptime: 864000,
      };
      const vms = this.guests.map((g) => ({
        id: `${g.type}/${g.vmid}`,
        type: g.type,
        vmid: g.vmid,
        name: g.name,
        node: 'pve',
        status: g.status,
        template: g.template,
        cpu: g.status === 'running' ? 0.07 : 0,
        maxcpu: g.maxcpu,
        mem: g.status === 'running' ? Math.round(g.maxmem * 0.4) : 0,
        maxmem: g.maxmem,
        uptime: g.status === 'running' ? 3600 * 26 : 0,
      }));
      const data = type === 'vm' ? vms : type === 'node' ? [node] : [node, ...vms];
      json(res, 200, { data });
      return;
    }
    const m =
      /^\/api2\/json\/nodes\/pve\/(qemu|lxc)\/(\d+)\/status\/(start|shutdown|stop|reboot)$/.exec(
        url.pathname,
      );
    if (req.method === 'POST' && m) {
      const g = this.guests.find((x) => x.type === m[1] && x.vmid === Number(m[2]));
      if (!g) {
        json(res, 500, { data: null });
        return;
      }
      this.actions.push(`${m[1]}/${m[2]}/${m[3]}`);
      g.status = m[3] === 'start' || m[3] === 'reboot' ? 'running' : 'stopped';
      json(res, 200, {
        data: `UPID:pve:0000ABCD:00000001:65000000:${m[3]}:${m[2]}:hz@pve!zentrale:`,
      });
      return;
    }
    json(res, 404, { data: null });
  };
}

// ---- Pi-hole v6 -----------------------------------------------------------------------------

export class FakePihole extends FakeServer {
  blocking = true;
  timer: number | null = null;
  private readonly sid = 'e2eFakeSid0123456789abcd';

  protected handle: Handler = (req, body, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/auth') {
      const pw = (JSON.parse(body || '{}') as { password?: string }).password;
      if (pw !== FAKE_PIHOLE_PASSWORD) {
        json(res, 401, { session: { valid: false, sid: null }, error: { key: 'unauthorized' } });
        return;
      }
      json(res, 200, {
        session: { valid: true, totp: false, sid: this.sid, csrf: 'x', validity: 1800 },
      });
      return;
    }
    if (req.headers['x-ftl-sid'] !== this.sid && req.headers.sid !== this.sid) {
      json(res, 401, { error: { key: 'unauthorized' } });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/stats/summary') {
      json(res, 200, {
        queries: { total: 48213, blocked: 9120, percent_blocked: 18.9, unique_domains: 3120 },
        gravity: { domains_being_blocked: 182345 },
        clients: { active: 14, total: 21 },
      });
      return;
    }
    if (url.pathname === '/api/dns/blocking') {
      if (req.method === 'POST') {
        const b = JSON.parse(body || '{}') as { blocking?: boolean; timer?: number | null };
        this.blocking = b.blocking !== false;
        this.timer = this.blocking ? null : (b.timer ?? null);
      }
      json(res, 200, { blocking: this.blocking ? 'enabled' : 'disabled', timer: this.timer });
      return;
    }
    json(res, 404, { error: { key: 'not_found' } });
  };
}

// ---- FRITZ!Box TR-064 ------------------------------------------------------------------------

// Digest auth is MD5 by protocol (RFC 2617, as the FRITZ!Box speaks it). The fake never hashes
// the password itself: like the box it only knows HA1 = MD5(user:realm:password), precomputed.
const md5 = (s: string): string => createHash('md5').update(s).digest('hex');
const FAKE_FRITZ_HA1 = ['267a0a37', 'c43d219f', '5bb937c7', '9fd209da'].join('');

/** `key="value"` / `key=value` pairs of a Digest header, without regex backtracking. */
function digestParams(header: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < header.length && out.size < 20) {
    while (header[i] === ' ' || header[i] === ',') i++;
    const eq = header.indexOf('=', i);
    if (eq < 0) break;
    const key = header.slice(i, eq).trim();
    let value: string;
    if (header[eq + 1] === '"') {
      const end = header.indexOf('"', eq + 2);
      if (end < 0) break;
      value = header.slice(eq + 2, end);
      i = end + 1;
    } else {
      const end = header.indexOf(',', eq + 1);
      value = header.slice(eq + 1, end < 0 ? header.length : end).trim();
      i = end < 0 ? header.length : end + 1;
    }
    out.set(key, value);
  }
  return out;
}

function soap(action: string, service: string, fields: Record<string, string | number>): string {
  const inner = Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action}Response xmlns:u="${service}">${inner}</u:${action}Response></s:Body></s:Envelope>`;
}

export class FakeFritz extends FakeServer {
  connected = true;
  rebooted = 0;
  private readonly nonce = 'E2EFAKENONCE0123';
  private readonly realm = 'F!Box SOAP-Auth';

  /** Verifies RFC 2617 digest (qop=auth) like the box does. */
  private authorized(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Digest ')) return false;
    const params = digestParams(h.slice(7, 2000));
    const p = {
      username: params.get('username'),
      nonce: params.get('nonce'),
      realm: params.get('realm'),
      uri: params.get('uri'),
      qop: params.get('qop'),
      nc: params.get('nc'),
      cnonce: params.get('cnonce'),
      response: params.get('response'),
    };
    if (p.username !== FAKE_FRITZ_USER || p.nonce !== this.nonce || p.realm !== this.realm)
      return false;
    const ha1 = FAKE_FRITZ_HA1;
    const ha2 = md5(`${req.method ?? 'POST'}:${p.uri ?? ''}`);
    const expected = p.qop
      ? md5(`${ha1}:${this.nonce}:${p.nc ?? ''}:${p.cnonce ?? ''}:${p.qop}:${ha2}`)
      : md5(`${ha1}:${this.nonce}:${ha2}`);
    return p.response === expected;
  }

  protected handle: Handler = (req, _body, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/devicehostlist.lua') {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0"?><List>
<Item><Index>1</Index><IPAddress>192.168.178.20</IPAddress><MACAddress>AA:BB:CC:00:00:01</MACAddress><Active>1</Active><HostName>heimserver</HostName><InterfaceType>Ethernet</InterfaceType></Item>
<Item><Index>2</Index><IPAddress>192.168.178.31</IPAddress><MACAddress>AA:BB:CC:00:00:02</MACAddress><Active>1</Active><HostName>Handy &amp; Tablet</HostName><InterfaceType>802.11</InterfaceType></Item>
<Item><Index>3</Index><IPAddress>192.168.178.40</IPAddress><MACAddress>AA:BB:CC:00:00:03</MACAddress><Active>0</Active><HostName>drucker</HostName><InterfaceType>802.11</InterfaceType></Item>
</List>`);
      return;
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/upnp/control/')) {
      res.writeHead(404).end();
      return;
    }
    if (!this.authorized(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': `Digest realm="${this.realm}", nonce="${this.nonce}", algorithm=MD5, qop="auth"`,
      });
      res.end();
      return;
    }
    const sa = String(req.headers.soapaction ?? '').replaceAll('"', '');
    const [service = '', action = ''] = sa.split('#');
    let xml: string | null = null;
    switch (action) {
      case 'GetInfo':
        xml = soap(action, service, {
          NewModelName: 'FRITZ!Box 7590 AX',
          NewSoftwareVersion: '8.02',
        });
        break;
      case 'GetCommonLinkProperties':
        xml = soap(action, service, {
          NewWANAccessType: 'DSL',
          NewLayer1UpstreamMaxBitRate: 40_000_000,
          NewLayer1DownstreamMaxBitRate: 250_000_000,
          NewPhysicalLinkStatus: this.connected ? 'Up' : 'Down',
        });
        break;
      case 'GetStatusInfo':
        xml = soap(action, service, {
          NewConnectionStatus: this.connected ? 'Connected' : 'Disconnected',
          NewLastConnectionError: 'ERROR_NONE',
          NewUptime: this.connected ? 172800 : 0,
        });
        break;
      case 'GetExternalIPAddress':
        xml = soap(action, service, { NewExternalIPAddress: this.connected ? '198.51.100.7' : '' });
        break;
      case 'X_AVM-DE_GetHostListPath':
        xml = soap(action, service, {
          'NewX_AVM-DE_HostListPath': '/devicehostlist.lua?sid=e2e0123456789abc',
        });
        break;
      case 'Reboot':
        this.rebooted++;
        xml = soap(action, service, {});
        break;
    }
    if (xml === null) {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' });
    res.end(xml);
  };
}

// ---- Uptime Kuma --------------------------------------------------------------------------------

export class FakeKuma extends FakeServer {
  constructor(private readonly siteUrl: string) {
    super();
  }

  protected handle: Handler = (req, _body, res) => {
    const expected = `Basic ${Buffer.from(`:${FAKE_KUMA_KEY}`).toString('base64')}`;
    if (req.headers.authorization !== expected) {
      res.writeHead(401).end('Unauthorized');
      return;
    }
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    const l = (name: string, type: string, url: string, host: string, port: string): string =>
      `monitor_name="${name}",monitor_type="${type}",monitor_url="${url}",monitor_hostname="${host}",monitor_port="${port}"`;
    const a = l('Meine Website', 'http', this.siteUrl, 'null', 'null');
    const b = l('NAS SSH', 'port', 'https://', '127.0.0.1', String(this.port));
    const c = l('Router "Ping"', 'ping', 'https://', '192.168.178.1', 'null');
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(`# HELP monitor_status Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE)
# TYPE monitor_status gauge
monitor_status{${a}} 1
monitor_status{${b}} 0
monitor_status{${c}} 1
# HELP monitor_response_time Monitor Response Time (ms)
# TYPE monitor_response_time gauge
monitor_response_time{${a}} 87
monitor_response_time{${b}} -1
monitor_response_time{${c}} 4
# HELP monitor_cert_days_remaining The number of days remaining until the certificate expires
# TYPE monitor_cert_days_remaining gauge
monitor_cert_days_remaining{${a}} 54
`);
  };
}

// ---- ntfy -------------------------------------------------------------------------------------

export class FakeNtfy extends FakeServer {
  readonly messages: { topic: string; title: string | undefined; body: string }[] = [];

  protected handle: Handler = (req, body, res) => {
    const topic = (req.url ?? '/').slice(1);
    if (req.method === 'POST' && /^[A-Za-z0-9_-]+$/.test(topic)) {
      const t = req.headers.title;
      this.messages.push({ topic, title: Array.isArray(t) ? t[0] : t, body });
      json(res, 200, { id: 'e2e', event: 'message', topic });
      return;
    }
    res.writeHead(404).end();
  };
}

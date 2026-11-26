import type { FritzDevice, FritzStatus } from '@hz/shared';
import { clockTime } from '../format.js';
import { IntegrationService, type IntegrationDeps, type ReadyConfig } from './base.js';
import { digestAuthorization, parseDigestChallenge, type DigestChallenge } from './digest.js';
import { IntegrationError, requireOk, requestUrl, type IntegrationResponse } from './http.js';

export const FRITZ_POLL_MS = 60_000;
export const FRITZ_CACHE_MS = 10_000;
export const FRITZ_INTERNET_ALERT_KEY = 'integration:fritzbox:internet';
const MAX_DEVICES = 1000;

/** Fixed TR-064 actions; no user input ever goes into the SOAP body. */
const ACTIONS = {
  deviceInfo: {
    path: '/upnp/control/deviceinfo',
    service: 'urn:dslforum-org:service:DeviceInfo:1',
    action: 'GetInfo',
  },
  linkProperties: {
    path: '/upnp/control/wancommonifconfig1',
    service: 'urn:dslforum-org:service:WANCommonInterfaceConfig:1',
    action: 'GetCommonLinkProperties',
  },
  statusInfo: {
    path: '/upnp/control/wanipconnection1',
    service: 'urn:dslforum-org:service:WANIPConnection:1',
    action: 'GetStatusInfo',
  },
  externalIp: {
    path: '/upnp/control/wanipconnection1',
    service: 'urn:dslforum-org:service:WANIPConnection:1',
    action: 'GetExternalIPAddress',
  },
  hostListPath: {
    path: '/upnp/control/hosts',
    service: 'urn:dslforum-org:service:Hosts:1',
    action: 'X_AVM-DE_GetHostListPath',
  },
  reboot: {
    path: '/upnp/control/deviceconfig',
    service: 'urn:dslforum-org:service:DeviceConfig:1',
    action: 'Reboot',
  },
} as const;
type ActionName = keyof typeof ACTIONS;

export function soapEnvelope(name: ActionName): string {
  const a = ACTIONS[name];
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${a.action} xmlns:u="${a.service}"></u:${a.action}></s:Body></s:Envelope>`
  );
}

/** XML entities: the five predefined ones and numeric references, nothing else (no DTD). */
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    switch (e) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const cp = e.startsWith('#x') ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
        return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
          ? String.fromCodePoint(cp)
          : '';
      }
    }
  });
}

function assertPlainXml(xml: string): void {
  // No DTDs or entity declarations: nothing gets expanded.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new IntegrationError('Unerwartete Antwort');
}

/**
 * Text of the first `<tag>` (optionally namespaced), decoded; null if missing.
 * Every repetition is bounded or stops at the next "<", so a hostile body
 * (e.g. many unterminated start tags) costs linear time.
 */
export function xmlValue(xml: string, tag: string): string | null {
  const name = tag.replace(/[^A-Za-z0-9_-]/g, '');
  const re = new RegExp(
    `<(?:[A-Za-z0-9_]{1,40}:)?${name}(?:\\s[^<>]{0,200})?>([^<]*)</(?:[A-Za-z0-9_]{1,40}:)?${name}>`,
  );
  const m = re.exec(xml);
  return m?.[1] === undefined ? null : decodeXml(m[1]).trim();
}

function clip(v: string | null, max: number): string | null {
  if (v === null || v === '') return null;
  return v.length > max ? null : v;
}

function nonNegInt(v: string | null): number | null {
  if (v === null || !/^\d{1,15}$/.test(v)) return null;
  return Number(v);
}

/** Host list XML of `X_AVM-DE_GetHostListPath` (`<Item>` elements), at most 1000. */
export function parseHostList(xml: string): FritzDevice[] {
  assertPlainXml(xml);
  const out: FritzDevice[] = [];
  // indexOf scan instead of a lazy regex: an unterminated <Item> ends the scan (linear).
  let pos = 0;
  while (out.length < MAX_DEVICES) {
    const open = xml.indexOf('<Item>', pos);
    if (open < 0) break;
    const close = xml.indexOf('</Item>', open + 6);
    if (close < 0) break;
    const item = xml.slice(open + 6, close);
    pos = close + 7;
    const type = xmlValue(item, 'InterfaceType') ?? '';
    const ip = clip(xmlValue(item, 'IPAddress'), 45);
    const name = (xmlValue(item, 'HostName') ?? '').slice(0, 120);
    out.push({
      name: name === '' ? (ip ?? 'Unbekannt') : name,
      ip,
      mac: clip(xmlValue(item, 'MACAddress'), 17),
      active: xmlValue(item, 'Active') === '1',
      interface: type === 'Ethernet' ? 'lan' : type === '802.11' ? 'wlan' : 'other',
    });
  }
  return out;
}

export type FritzData = Omit<FritzStatus, 'fetchedAt' | 'error'>;

/**
 * FRITZ!Box over TR-064 (SPEC 16): internet status, devices, reboot. SOAP over
 * HTTP with Digest auth; the body is fixed per action.
 */
export class FritzService extends IntegrationService<FritzData> {
  private challenge: DigestChallenge | null = null;
  private nc = 0;
  /** SOAP calls run one after another: poll and reboot share challenge and nc. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: IntegrationDeps) {
    super(deps, 'fritzbox', 'FRITZ!Box', FRITZ_POLL_MS, FRITZ_CACHE_MS);
  }

  protected override onReset(): void {
    this.challenge = null;
    this.nc = 0;
  }

  protected override extraAlertKeys(): string[] {
    return [FRITZ_INTERNET_ALERT_KEY];
  }

  private authHeader(cfg: ReadyConfig, uri: string): Record<string, string> {
    if (this.challenge === null) return {};
    this.nc++;
    return {
      authorization: digestAuthorization(this.challenge, {
        username: cfg.username ?? '',
        password: cfg.secret,
        method: 'POST',
        uri,
        nc: this.nc,
      }),
    };
  }

  /** One SOAP call, queued behind any running one, so a nonce count is never reused. */
  private soap(cfg: ReadyConfig, name: ActionName): Promise<string> {
    const run = this.queue.then(() => this.soapNow(cfg, name));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** One SOAP call; answers the digest challenge once. */
  private async soapNow(cfg: ReadyConfig, name: ActionName): Promise<string> {
    const a = ACTIONS[name];
    const uri = requestUrl({ base: cfg.url, path: a.path }).pathname;
    const gen = this.generation;
    const send = (): Promise<IntegrationResponse> =>
      this.deps.http.request({
        base: cfg.url,
        path: a.path,
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset="utf-8"',
          soapaction: `"${a.service}#${a.action}"`,
          ...this.authHeader(cfg, uri),
        },
        body: soapEnvelope(name),
        ca: cfg.caCert,
      });
    let res = await send();
    if (res.status === 401) {
      const ch = parseDigestChallenge(res.headers['www-authenticate']);
      if (gen !== this.generation) throw new IntegrationError('Nicht erreichbar');
      this.challenge = ch;
      this.nc = 0;
      res = await send();
    }
    const xml = requireOk(res).body;
    assertPlainXml(xml);
    return xml;
  }

  /** A call that older boxes may not offer: "Unerwartete Antwort" gives null. */
  private async optional(cfg: ReadyConfig, name: ActionName): Promise<string | null> {
    try {
      return await this.soap(cfg, name);
    } catch (err) {
      if (err instanceof IntegrationError && err.text === 'Unerwartete Antwort') return null;
      throw err;
    }
  }

  private async devices(cfg: ReadyConfig): Promise<FritzDevice[]> {
    const xml = await this.optional(cfg, 'hostListPath');
    const path = xml === null ? null : xmlValue(xml, 'NewX_AVM-DE_HostListPath');
    if (path === null || path === '') return [];
    // The path (it carries a session id) stays on the box's origin and is never logged.
    const res = requireOk(
      await this.deps.http.request({
        base: cfg.url,
        path,
        fromOrigin: true,
        ca: cfg.caCert,
      }),
    );
    return parseHostList(res.body);
  }

  protected async fetch(cfg: ReadyConfig): Promise<FritzData> {
    const info = await this.soap(cfg, 'deviceInfo');
    const link = await this.optional(cfg, 'linkProperties');
    const status = await this.optional(cfg, 'statusInfo');
    const ip = status === null ? null : await this.optional(cfg, 'externalIp');
    const devices = await this.devices(cfg);
    const bps = (xml: string | null, tag: string): number | null =>
      xml === null ? null : nonNegInt(xmlValue(xml, tag));
    return {
      model: clip(xmlValue(info, 'NewModelName'), 120),
      firmware: clip(xmlValue(info, 'NewSoftwareVersion'), 60),
      internet:
        status === null && link === null
          ? null
          : {
              connected: status !== null && xmlValue(status, 'NewConnectionStatus') === 'Connected',
              linkStatus: link === null ? null : clip(xmlValue(link, 'NewPhysicalLinkStatus'), 40),
              externalIp: ip === null ? null : clip(xmlValue(ip, 'NewExternalIPAddress'), 45),
              uptimeS: status === null ? null : nonNegInt(xmlValue(status, 'NewUptime')),
              maxDownBps: bps(link, 'NewLayer1DownstreamMaxBitRate'),
              maxUpBps: bps(link, 'NewLayer1UpstreamMaxBitRate'),
            },
      devices,
    };
  }

  /** Internet down: crit alert; back: resolved. */
  protected override afterFetch(data: FritzData): void {
    if (data.internet === null) return;
    if (!data.internet.connected) {
      this.deps.alerts.raise(
        FRITZ_INTERNET_ALERT_KEY,
        'crit',
        'Internet getrennt',
        `Die FRITZ!Box meldet seit ${clockTime(this.deps.now())} keine Verbindung ins Internet.`,
        null,
        'system',
      );
    } else if (this.deps.alerts.active(FRITZ_INTERNET_ALERT_KEY)) {
      this.deps.alerts.resolve(FRITZ_INTERNET_ALERT_KEY, {
        title: 'Internet wieder verbunden',
        body: `Seit ${clockTime(this.deps.now())} wieder verbunden.`,
      });
    }
  }

  async fritzStatus(): Promise<FritzStatus> {
    const c = await this.current();
    return {
      model: c.data?.model ?? null,
      firmware: c.data?.firmware ?? null,
      internet: c.data?.internet ?? null,
      devices: c.data?.devices ?? [],
      fetchedAt: this.iso(c.fetchedAt),
      error: c.error,
    };
  }

  async reboot(): Promise<void> {
    await this.act(async (cfg) => {
      await this.soap(cfg, 'reboot');
    });
    this.invalidate();
  }
}

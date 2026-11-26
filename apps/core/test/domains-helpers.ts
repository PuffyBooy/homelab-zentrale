import { execFileSync } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type JsonWebKey as CryptoJwk,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { writeSetting } from '../src/db/settings.js';
import {
  bitString,
  ctx,
  integer,
  nameWithCn,
  oid,
  OID,
  sanExtension,
  seq,
  tlv,
} from '../src/domains/der.js';
import type { DomainsDeps } from '../src/domains/service.js';
import { MODULES_SETTING } from '../src/modules/service.js';
import { emptyDir, KEY, SETUP_TOKEN, T0, type TestApp } from './helpers.js';

/** Fake secrets are assembled at runtime so secret scanners do not flag them. */
export const CF_TOKEN = ['cf', 'test', 'token', 'A1b2C3d4E5f6G7h8I9j0'].join('_');
export const CF_TOKEN_2 = ['cf', 'test', 'token', 'Z9y8X7w6V5u4T3s2R1q0'].join('_');
export const DUCK_TOKEN = ['0f1e2d3c', '4b5a', '6978', '8796', 'a5b4c3d2e1f0'].join('-');
export const ACME_DIR = 'https://acme.test/directory';

export interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}

type Handler = (req: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}) => Response | Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

// ---- fake DNS (TXT lookups of the DNS-01 check) ------------------------------------

export class FakeDns {
  readonly txt = new Map<string, string[]>();
  lookups: string[] = [];
  /** Answer nothing (propagation never finishes). */
  silent = false;

  resolve = (name: string): Promise<string[][]> => {
    this.lookups.push(name);
    const v = this.silent ? undefined : this.txt.get(name);
    if (!v || v.length === 0) {
      const err = Object.assign(new Error('queryTxt ENODATA'), { code: 'ENODATA' });
      return Promise.reject(err);
    }
    return Promise.resolve(v.map((x) => [x]));
  };
}

// ---- fake Cloudflare ---------------------------------------------------------------

export interface CfRecord {
  id: string;
  zoneId: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

export class FakeCloudflare {
  tokens = new Set<string>([CF_TOKEN, CF_TOKEN_2]);
  zones = [
    { id: 'zone1', name: 'example.com' },
    { id: 'zone2', name: 'other.org' },
  ];
  records = new Map<string, CfRecord>();
  private n = 0;

  constructor(private readonly dns: FakeDns) {}

  addForeign(name: string, type: string, content: string): CfRecord {
    const r: CfRecord = {
      id: `foreign${++this.n}`,
      zoneId: 'zone1',
      type,
      name,
      content,
      ttl: 300,
      proxied: false,
    };
    this.records.set(r.id, r);
    return r;
  }

  private txtNames = new Set<string>();

  private syncTxt(): void {
    for (const k of this.txtNames) this.dns.txt.delete(k);
    const byName = new Map<string, string[]>();
    for (const r of this.records.values()) {
      if (r.type !== 'TXT') continue;
      byName.set(r.name, [...(byName.get(r.name) ?? []), r.content]);
    }
    this.txtNames = new Set(byName.keys());
    for (const [name, values] of byName) this.dns.txt.set(name, values);
  }

  handler: Handler = ({ method, url, headers, body }) => {
    const auth = headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !this.tokens.has(auth.slice(7)))
      return json(401, { success: false, errors: [{ code: 10000, message: 'auth' }] });
    const path = url.pathname.replace(/^\/client\/v4/, '');
    if (path === '/user/tokens/verify' && method === 'GET')
      return json(200, { success: true, result: { id: 'x', status: 'active' } });
    if (path === '/zones' && method === 'GET')
      return json(200, {
        success: true,
        result: this.zones,
        result_info: { page: 1, total_pages: 1 },
      });
    const m = /^\/zones\/([a-z0-9]+)\/dns_records(?:\/([A-Za-z0-9]+))?$/.exec(path);
    if (!m) return json(404, { success: false });
    const zoneId = m[1] ?? '';
    const recId = m[2];
    if (!this.zones.some((z) => z.id === zoneId)) return json(404, { success: false });
    if (method === 'GET' && !recId) {
      const name = url.searchParams.get('name');
      const type = url.searchParams.get('type');
      const result = [...this.records.values()].filter(
        (r) => r.zoneId === zoneId && r.name === name && r.type === type,
      );
      return json(200, { success: true, result });
    }
    if (method === 'POST' && !recId) {
      const b = JSON.parse(body) as Omit<CfRecord, 'id' | 'zoneId'>;
      const conflict = [...this.records.values()].some(
        (r) => r.name === b.name && (r.type === 'CNAME' || b.type === 'CNAME') && b.type !== 'TXT',
      );
      if (conflict) return json(400, { success: false, errors: [{ code: 81053 }] });
      const r: CfRecord = { ...b, id: `rec${++this.n}`, zoneId };
      this.records.set(r.id, r);
      this.syncTxt();
      return json(200, { success: true, result: r });
    }
    if (recId && !this.records.has(recId)) return json(404, { success: false });
    if (method === 'PUT' && recId) {
      const b = JSON.parse(body) as Omit<CfRecord, 'id' | 'zoneId'>;
      const r: CfRecord = { ...b, id: recId, zoneId };
      this.records.set(recId, r);
      this.syncTxt();
      return json(200, { success: true, result: r });
    }
    if (method === 'DELETE' && recId) {
      this.records.delete(recId);
      this.syncTxt();
      return json(200, { success: true, result: { id: recId } });
    }
    return json(405, { success: false });
  };
}

// ---- fake DuckDNS ------------------------------------------------------------------

export class FakeDuck {
  token = DUCK_TOKEN;
  subs = new Map<string, { ip: string | null; ipv6: string | null; txt: string | null }>([
    ['meinheim', { ip: null, ipv6: null, txt: null }],
  ]);
  updates: URLSearchParams[] = [];

  constructor(private readonly dns: FakeDns) {}

  handler: Handler = ({ url }) => {
    if (url.pathname !== '/update') return new Response('', { status: 404 });
    const q = url.searchParams;
    this.updates.push(q);
    const domains = (q.get('domains') ?? '').split(',');
    if (q.get('token') !== this.token || domains.some((d) => !this.subs.has(d)))
      return new Response('KO', { status: 200 });
    for (const d of domains) {
      const s = this.subs.get(d);
      if (!s) continue;
      const clear = q.get('clear') === 'true';
      if (q.has('txt')) {
        s.txt = clear ? null : q.get('txt');
        const name = `_acme-challenge.${d}.duckdns.org`;
        if (s.txt === null) this.dns.txt.delete(name);
        else this.dns.txt.set(name, [s.txt]);
        continue;
      }
      if (clear) {
        s.ip = null;
        s.ipv6 = null;
        continue;
      }
      if (q.has('ip')) s.ip = q.get('ip');
      if (q.has('ipv6')) s.ipv6 = q.get('ipv6');
    }
    return new Response('OK', { status: 200 });
  };
}

// ---- minimal DER reader (tests only) ------------------------------------------------

export interface DerNode {
  tag: number;
  raw: Buffer;
  content: Buffer;
  children: DerNode[];
}

export function parseDer(buf: Buffer, start = 0, end = buf.length): DerNode[] {
  const out: DerNode[] = [];
  let i = start;
  while (i < end) {
    const tag = buf[i] ?? 0;
    let len = buf[i + 1] ?? 0;
    let hdr = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = len * 256 + (buf[i + 2 + k] ?? 0);
      hdr = 2 + n;
    }
    const content = buf.subarray(i + hdr, i + hdr + len);
    const node: DerNode = {
      tag,
      raw: buf.subarray(i, i + hdr + len),
      content,
      children: tag & 0x20 ? parseDer(buf, i + hdr, i + hdr + len) : [],
    };
    out.push(node);
    i += hdr + len;
  }
  return out;
}

function findSan(node: DerNode, sanOid: Buffer): string[] | null {
  const [first, second] = node.children;
  if (node.tag === 0x30 && first?.tag === 0x06 && first.content.equals(sanOid) && second) {
    const [names] = parseDer(second.content);
    return (names?.children ?? []).map((c) => c.content.toString('ascii'));
  }
  for (const c of node.children) {
    const r = findSan(c, sanOid);
    if (r) return r;
  }
  return null;
}

/** Checks a CSR (signature, SAN); returns its public key and names. */
export function readCsr(der: Buffer): { key: KeyObject; names: string[]; cn: string | null } {
  const [top] = parseDer(der);
  const [info, , sig] = top?.children ?? [];
  if (!info || !sig) throw new Error('bad csr');
  const [, subject, spki] = info.children;
  if (!spki) throw new Error('bad csr');
  const key = createPublicKey({ key: spki.raw, format: 'der', type: 'spki' });
  const ok = verify('sha256', info.raw, { key, dsaEncoding: 'der' }, sig.content.subarray(1));
  if (!ok) throw new Error('bad csr signature');
  const sanOid = oid(OID.subjectAltName).subarray(2);
  const names = findSan(info, sanOid) ?? [];
  const cnNode = subject?.children[0]?.children[0]?.children[1];
  return { key, names, cn: cnNode ? cnNode.content.toString('utf8') : null };
}

function utcTime(ms: number): Buffer {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

/** X.509 v3 certificate signed with ECDSA-SHA256. */
export function makeCert(opts: {
  subjectCn: string | null;
  issuerCn: string;
  spki: Buffer;
  signer: KeyObject;
  notBefore: number;
  notAfter: number;
  names?: string[];
}): string {
  const exts = opts.names ? [ctx(3, seq(sanExtension(opts.names)))] : [];
  const tbs = seq(
    ctx(0, integer(2)),
    integer(randomBytes(8)),
    seq(oid(OID.ecdsaWithSha256)),
    nameWithCn(opts.issuerCn),
    seq(utcTime(opts.notBefore), utcTime(opts.notAfter)),
    nameWithCn(opts.subjectCn),
    opts.spki,
    ...exts,
  );
  const sigBytes = sign('sha256', tbs, { key: opts.signer, dsaEncoding: 'der' });
  const der = seq(tbs, seq(oid(OID.ecdsaWithSha256)), bitString(sigBytes));
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64.replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
}

let opensslChecked: boolean | null = null;
/** `openssl req -verify` as an extra, independent CSR check (if openssl exists). */
export function opensslVerifyCsr(der: Buffer): boolean | null {
  if (opensslChecked === false) return null;
  const dir = mkdtempSync(join(tmpdir(), 'hz-csr-'));
  const file = join(dir, 'csr.der');
  writeFileSync(file, der);
  try {
    execFileSync('openssl', ['req', '-verify', '-noout', '-inform', 'DER', '-in', file], {
      stdio: 'pipe',
    });
    opensslChecked = true;
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      opensslChecked = false;
      return null;
    }
    return false;
  }
}

// ---- fake ACME (RFC 8555 subset) ---------------------------------------------------

interface Authz {
  id: number;
  value: string;
  wildcard: boolean;
  token: string;
  status: 'pending' | 'valid' | 'invalid';
  account: string;
}

interface Order {
  id: number;
  names: string[];
  authz: number[];
  status: 'pending' | 'ready' | 'processing' | 'valid' | 'invalid';
  cert: string | null;
  account: string;
}

const b64u = (b: Buffer | string): string =>
  (typeof b === 'string' ? Buffer.from(b) : b).toString('base64url');

function thumbprint(jwk: Record<string, unknown>): string {
  const c = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64u(createHash('sha256').update(c).digest());
}

export class FakeAcme {
  readonly base = 'https://acme.test';
  private readonly nonces = new Set<string>();
  readonly accounts = new Map<string, { key: KeyObject; thumb: string; contact: unknown }>();
  private readonly authzs = new Map<number, Authz>();
  private readonly orders = new Map<number, Order>();
  private n = 0;
  readonly caKey: KeyObject;
  readonly caPem: string;
  /** Signed requests whose JWS was verified. */
  verified = 0;
  csrs: Buffer[] = [];
  opensslResults: (boolean | null)[] = [];
  /** Reject the next N POSTs with badNonce. */
  badNonces = 0;
  /** Answer newOrder with URLs on another host. */
  evil: 'authz' | 'finalize' | 'location' | null = null;
  /** Validity of issued certificates. */
  validityMs = 90 * 86_400_000;
  /** Fail every challenge. */
  failChallenges = false;

  constructor(
    private readonly dns: FakeDns,
    private readonly now: () => number,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.caKey = privateKey;
    this.caPem = makeCert({
      subjectCn: 'Fake ACME CA',
      issuerCn: 'Fake ACME CA',
      spki: publicKey.export({ type: 'spki', format: 'der' }),
      signer: privateKey,
      notBefore: now() - 86_400_000,
      notAfter: now() + 3650 * 86_400_000,
    });
  }

  private nonce(): string {
    const v = randomBytes(16).toString('base64url');
    this.nonces.add(v);
    return v;
  }

  private reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return json(status, body, { 'replay-nonce': this.nonce(), ...headers });
  }

  private problem(status: number, type: string): Response {
    return this.reply(status, { type: `urn:ietf:params:acme:error:${type}`, detail: type });
  }

  private authzJson(a: Authz): unknown {
    return {
      status: a.status,
      identifier: { type: 'dns', value: a.value },
      ...(a.wildcard ? { wildcard: true } : {}),
      challenges: [
        { type: 'http-01', url: `${this.base}/chall-http/${a.id}`, token: a.token },
        { type: 'dns-01', url: `${this.base}/chall/${a.id}`, token: a.token, status: a.status },
      ],
    };
  }

  private orderJson(o: Order): unknown {
    if (o.status === 'pending' && o.authz.every((id) => this.authzs.get(id)?.status === 'valid'))
      o.status = 'ready';
    const evilBase = 'https://evil.example';
    return {
      status: o.status,
      identifiers: o.names.map((value) => ({ type: 'dns', value })),
      authorizations: o.authz.map(
        (id) => `${this.evil === 'authz' ? evilBase : this.base}/authz/${id}`,
      ),
      finalize: `${this.evil === 'finalize' ? evilBase : this.base}/finalize/${o.id}`,
      ...(o.cert ? { certificate: `${this.base}/cert/${o.id}` } : {}),
    };
  }

  handler: Handler = ({ method, url, body }) => {
    const path = url.pathname;
    if (path === '/directory' && method === 'GET')
      return json(200, {
        newNonce: `${this.base}/new-nonce`,
        newAccount: `${this.base}/new-account`,
        newOrder: `${this.base}/new-order`,
      });
    if (path === '/new-nonce')
      return new Response(null, { status: 200, headers: { 'replay-nonce': this.nonce() } });
    if (method !== 'POST') return json(405, {});

    // ---- JWS check ----
    const jws = JSON.parse(body) as { protected: string; payload: string; signature: string };
    const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString()) as {
      alg: string;
      nonce: string;
      url: string;
      jwk?: Record<string, unknown>;
      kid?: string;
    };
    if (header.alg !== 'ES256') return this.problem(400, 'badSignatureAlgorithm');
    if (!this.nonces.delete(header.nonce)) return this.problem(400, 'badNonce');
    if (this.badNonces > 0) {
      this.badNonces--;
      return this.problem(400, 'badNonce');
    }
    if (header.url !== url.toString()) return this.problem(401, 'unauthorized');
    let key: KeyObject;
    let account: string | null = null;
    if (header.jwk) {
      if (path !== '/new-account') return this.problem(400, 'malformed');
      key = createPublicKey({ key: header.jwk as unknown as CryptoJwk, format: 'jwk' });
    } else {
      const acct = header.kid ? this.accounts.get(header.kid) : undefined;
      if (!acct || !header.kid) return this.problem(400, 'accountDoesNotExist');
      key = acct.key;
      account = header.kid;
    }
    const ok = verify(
      'sha256',
      Buffer.from(`${jws.protected}.${jws.payload}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(jws.signature, 'base64url'),
    );
    if (!ok) return this.problem(400, 'malformed');
    this.verified++;
    const payload =
      jws.payload === ''
        ? null
        : (JSON.parse(Buffer.from(jws.payload, 'base64url').toString()) as Record<string, unknown>);

    // ---- routes ----
    if (path === '/new-account') {
      const jwk = header.jwk ?? {};
      const thumb = thumbprint(jwk);
      for (const [kid, a] of this.accounts)
        if (a.thumb === thumb) return this.reply(200, { status: 'valid' }, { location: kid });
      if (payload?.termsOfServiceAgreed !== true) return this.problem(400, 'userActionRequired');
      const kid = `${this.base}/acct/${++this.n}`;
      this.accounts.set(kid, { key, thumb, contact: payload.contact ?? null });
      return this.reply(201, { status: 'valid' }, { location: kid });
    }
    if (!account) return this.problem(400, 'malformed');
    const acct = this.accounts.get(account);
    if (!acct) return this.problem(400, 'accountDoesNotExist');
    if (path.startsWith('/acct/')) {
      if (path !== new URL(account).pathname) return this.problem(403, 'unauthorized');
      if (payload && 'contact' in payload) acct.contact = payload.contact;
      return this.reply(200, { status: 'valid', contact: acct.contact });
    }
    if (path === '/new-order') {
      const ids = (payload?.identifiers ?? []) as { type: string; value: string }[];
      const order: Order = {
        id: ++this.n,
        names: ids.map((i) => i.value),
        authz: [],
        status: 'pending',
        cert: null,
        account,
      };
      for (const i of ids) {
        const wildcard = i.value.startsWith('*.');
        const a: Authz = {
          id: ++this.n,
          value: wildcard ? i.value.slice(2) : i.value,
          wildcard,
          token: randomBytes(24).toString('base64url'),
          status: 'pending',
          account,
        };
        this.authzs.set(a.id, a);
        order.authz.push(a.id);
      }
      this.orders.set(order.id, order);
      const loc = `${this.evil === 'location' ? 'https://evil.example' : this.base}/order/${order.id}`;
      return this.reply(201, this.orderJson(order), { location: loc });
    }
    let m = /^\/authz\/(\d+)$/.exec(path);
    if (m) {
      const a = this.authzs.get(Number(m[1]));
      if (!a || a.account !== account) return this.problem(404, 'malformed');
      return this.reply(200, this.authzJson(a));
    }
    m = /^\/chall\/(\d+)$/.exec(path);
    if (m) {
      const a = this.authzs.get(Number(m[1]));
      if (!a || a.account !== account) return this.problem(404, 'malformed');
      const expected = b64u(createHash('sha256').update(`${a.token}.${acct.thumb}`).digest());
      const seen = this.dns.txt.get(`_acme-challenge.${a.value}`) ?? [];
      a.status = !this.failChallenges && seen.includes(expected) ? 'valid' : 'invalid';
      return this.reply(200, { type: 'dns-01', status: a.status, token: a.token });
    }
    m = /^\/order\/(\d+)$/.exec(path);
    if (m) {
      const o = this.orders.get(Number(m[1]));
      if (!o || o.account !== account) return this.problem(404, 'malformed');
      return this.reply(200, this.orderJson(o));
    }
    m = /^\/finalize\/(\d+)$/.exec(path);
    if (m) {
      const o = this.orders.get(Number(m[1]));
      if (!o || o.account !== account) return this.problem(404, 'malformed');
      this.orderJson(o);
      if (o.status !== 'ready') return this.problem(403, 'orderNotReady');
      const der = Buffer.from(String(payload?.csr ?? ''), 'base64url');
      let csr: ReturnType<typeof readCsr>;
      try {
        csr = readCsr(der);
      } catch {
        return this.problem(400, 'badCSR');
      }
      this.csrs.push(der);
      this.opensslResults.push(opensslVerifyCsr(der));
      if ([...csr.names].sort().join(',') !== [...o.names].sort().join(','))
        return this.problem(400, 'badCSR');
      const leaf = makeCert({
        subjectCn: csr.cn,
        issuerCn: 'Fake ACME CA',
        spki: csr.key.export({ type: 'spki', format: 'der' }),
        signer: this.caKey,
        notBefore: this.now() - 60_000,
        notAfter: this.now() + this.validityMs,
        names: csr.names,
      });
      o.cert = `${leaf}${this.caPem}`;
      o.status = 'valid';
      return this.reply(200, this.orderJson(o));
    }
    m = /^\/cert\/(\d+)$/.exec(path);
    if (m) {
      const o = this.orders.get(Number(m[1]));
      if (!o?.cert || o.account !== account) return this.problem(404, 'malformed');
      return new Response(o.cert, {
        status: 200,
        headers: {
          'content-type': 'application/pem-certificate-chain',
          'replay-nonce': this.nonce(),
        },
      });
    }
    return this.problem(404, 'malformed');
  };
}

// ---- world: fetch router + app ------------------------------------------------------

export class World {
  readonly dns = new FakeDns();
  readonly cf = new FakeCloudflare(this.dns);
  readonly duck = new FakeDuck(this.dns);
  readonly acme: FakeAcme;
  readonly calls: FetchCall[] = [];
  /** Extra hosts answered by the router (for redirect tests). */
  readonly extra = new Map<string, Handler>();

  constructor(now: () => number) {
    this.acme = new FakeAcme(this.dns, now);
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v;
    const method = init.method ?? 'GET';
    this.calls.push({ method, url: input, headers, redirect: init.redirect });
    const body = typeof init.body === 'string' ? init.body : '';
    const h =
      this.extra.get(url.hostname) ??
      (url.hostname === 'api.cloudflare.com'
        ? this.cf.handler
        : url.hostname === 'www.duckdns.org'
          ? this.duck.handler
          : url.hostname === 'acme.test'
            ? this.acme.handler
            : null);
    if (!h) throw new TypeError('fetch failed');
    return h({ method, url, headers, body });
  };

  deps(over: Partial<DomainsDeps> = {}): DomainsDeps {
    return {
      fetch: this.fetch,
      resolveTxt: this.dns.resolve,
      acmeDirectories: { letsencrypt: ACME_DIR, 'letsencrypt-staging': ACME_DIR },
      sleep: () => new Promise((r) => setImmediate(r)),
      acmePollMs: 1,
      acmeMaxPolls: 5,
      dnsPollMs: 1,
      dnsMaxPolls: 3,
      ...over,
    };
  }
}

export interface DomainsTestApp extends TestApp {
  world: World;
}

/** Like makeApp (helpers.ts), with the domains module on and the fake world injected. */
export async function makeDomainsApp(
  opts: {
    captureLogs?: boolean;
    domainsOn?: boolean;
    deps?: (w: World) => Partial<DomainsDeps>;
  } = {},
): Promise<DomainsTestApp> {
  const clock = {
    t: T0,
    advance(ms: number) {
      this.t += ms;
    },
  };
  const world = new World(() => clock.t);
  const logs: string[] = [];
  const db = openDatabase(':memory:');
  writeSetting(
    db.db,
    MODULES_SETTING,
    { github: false, homeassistant: false, games: false, domains: opts.domainsOn ?? true },
    clock.t,
  );
  const config = loadConfig({
    HZ_SECRET_KEY: KEY,
    NODE_ENV: 'test',
    HZ_WEB_DIR: emptyDir(),
    HZ_SETUP_TOKEN: SETUP_TOKEN,
  });
  const reject = (): Promise<never> => Promise.reject(new Error('no network in tests'));
  const app = await buildApp(config, {
    db,
    now: () => clock.t,
    startScheduler: false,
    rdapFetch: reject,
    githubFetch: reject,
    gameFetch: reject,
    pushTransport: { send: reject },
    features: { domains: world.deps(opts.deps?.(world)) },
    ...(opts.captureLogs
      ? {
          logStream: new Writable({
            write(chunk: Buffer, _enc, cb) {
              logs.push(chunk.toString('utf8'));
              cb();
            },
          }),
        }
      : {}),
  });
  await app.ready();
  return { app, db, clock, logs, world };
}

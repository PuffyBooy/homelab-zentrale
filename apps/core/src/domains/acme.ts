import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { buildCsr } from './der.js';
import type { DomainsHttp, HttpResult } from './http.js';

/**
 * ACME client (RFC 8555) for DNS-01 with an EC P-256 account key (JWS ES256).
 * Every URL the CA hands out (Location, authorizations, challenges, finalize,
 * certificate) must have the origin of the directory; the HTTP client checks
 * the host allowlist again. Polling is bounded.
 */

const b64u = (b: Buffer | string): string =>
  (typeof b === 'string' ? Buffer.from(b, 'utf8') : b).toString('base64url');

/** Expected failure with a short German reason (safe to show and store). */
export class AcmeError extends Error {
  constructor(
    public readonly reason: string,
    /** Short ACME problem type ("badNonce", "rateLimited"), if any. */
    public readonly problem: string | null = null,
  ) {
    super('acme_error');
    this.name = 'AcmeError';
  }
}

const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);
const problemSchema = z.object({ type: z.string().max(200).optional() });

const directorySchema = z.object({
  newNonce: z.string().max(500),
  newAccount: z.string().max(500),
  newOrder: z.string().max(500),
});
const orderSchema = z.object({
  status: z.string(),
  authorizations: z.array(z.string().max(500)).max(20),
  finalize: z.string().max(500),
  certificate: z.string().max(500).optional(),
});
const authzSchema = z.object({
  status: z.string(),
  identifier: z.object({ type: z.literal('dns'), value: z.string().max(253) }),
  wildcard: z.boolean().optional(),
  challenges: z
    .array(z.object({ type: z.string(), url: z.string().max(500), token: z.string().optional() }))
    .max(10),
});

export type Order = z.infer<typeof orderSchema>;

/** Sets, waits for and removes the _acme-challenge TXT value. */
export interface Dns01Solver {
  set(name: string, value: string): Promise<string>;
  /** Resolves once the value is visible in DNS; throws when it is not in time. */
  wait(name: string, value: string): Promise<void>;
  clear(name: string, handle: string): Promise<void>;
}

export interface AcmeOptions {
  http: DomainsHttp;
  directoryUrl: string;
  accountKey: KeyObject;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  maxPolls: number;
}

/** RFC 7638 thumbprint of an EC public key. */
export function jwkThumbprint(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64u(createHash('sha256').update(canonical, 'utf8').digest());
}

/** TXT value for DNS-01: base64url(sha256(token + "." + thumbprint)). */
export function dns01Value(token: string, accountKey: KeyObject): string {
  const keyAuth = `${token}.${jwkThumbprint(accountKey)}`;
  return b64u(createHash('sha256').update(keyAuth, 'utf8').digest());
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function problemOf(res: HttpResult): string | null {
  const p = problemSchema.safeParse(parseJson(res.text));
  const type = p.success ? p.data.type : undefined;
  if (!type?.startsWith('urn:ietf:params:acme:error:')) return null;
  const short = type.slice('urn:ietf:params:acme:error:'.length);
  return /^[A-Za-z]{1,40}$/.test(short) ? short : null;
}

function failure(res: HttpResult, what: string): AcmeError {
  const problem = problemOf(res);
  if (problem === 'rateLimited') return new AcmeError('ACME-Rate-Limit erreicht', problem);
  return new AcmeError(
    problem ? `${what} abgelehnt (${problem})` : `${what} fehlgeschlagen (HTTP ${res.status})`,
    problem,
  );
}

export class AcmeClient {
  private nonce: string | null = null;
  private directory: z.infer<typeof directorySchema> | null = null;
  private kid: string | null = null;
  private readonly origin: string;
  private readonly jwk: Record<string, unknown>;

  constructor(private readonly o: AcmeOptions) {
    this.origin = new URL(o.directoryUrl).origin;
    const jwk = createPublicKey(o.accountKey).export({ format: 'jwk' });
    this.jwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  }

  /** URLs from the CA must stay on the directory's origin. */
  private sameOrigin(url: string): string {
    let u: URL;
    try {
      u = new URL(url, this.o.directoryUrl);
    } catch {
      throw new AcmeError('Ungültige Adresse vom ACME-Server');
    }
    if (u.origin !== this.origin) throw new AcmeError('ACME-Adresse auf fremdem Host abgelehnt');
    return u.toString();
  }

  private async dir(): Promise<z.infer<typeof directorySchema>> {
    if (this.directory) return this.directory;
    const res = await this.o.http.request(this.o.directoryUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (res.status !== 200) throw failure(res, 'ACME-Verzeichnis');
    const d = directorySchema.safeParse(parseJson(res.text));
    if (!d.success) throw new AcmeError('Unerwartetes ACME-Verzeichnis');
    this.directory = {
      newNonce: this.sameOrigin(d.data.newNonce),
      newAccount: this.sameOrigin(d.data.newAccount),
      newOrder: this.sameOrigin(d.data.newOrder),
    };
    return this.directory;
  }

  private takeNonce(res: HttpResult): void {
    const n = nonceSchema.safeParse(res.headers.get('replay-nonce'));
    if (n.success) this.nonce = n.data;
  }

  private async freshNonce(): Promise<string> {
    if (this.nonce) {
      const n = this.nonce;
      this.nonce = null;
      return n;
    }
    const res = await this.o.http.request((await this.dir()).newNonce, { method: 'HEAD' });
    const n = nonceSchema.safeParse(res.headers.get('replay-nonce'));
    if (!n.success) throw new AcmeError('ACME-Server lieferte keine Nonce');
    return n.data;
  }

  /** Signed POST (payload null = POST-as-GET). Retries badNonce up to 3 times. */
  private async post(
    url: string,
    payload: unknown,
    opts: { jwk?: boolean; accept?: string } = {},
  ): Promise<HttpResult> {
    const target = this.sameOrigin(url);
    for (let attempt = 0; ; attempt++) {
      const nonce = await this.freshNonce();
      const header: Record<string, unknown> = { alg: 'ES256', nonce, url: target };
      if (opts.jwk) header.jwk = this.jwk;
      else if (this.kid) header.kid = this.kid;
      else throw new AcmeError('Kein ACME-Konto');
      const protectedB64 = b64u(JSON.stringify(header));
      const payloadB64 = payload === null ? '' : b64u(JSON.stringify(payload));
      const signature = sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`, 'ascii'), {
        key: this.o.accountKey,
        dsaEncoding: 'ieee-p1363',
      });
      const res = await this.o.http.request(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/jose+json',
          accept: opts.accept ?? 'application/json',
        },
        body: JSON.stringify({
          protected: protectedB64,
          payload: payloadB64,
          signature: b64u(signature),
        }),
      });
      this.takeNonce(res);
      if (res.status === 400 && problemOf(res) === 'badNonce' && attempt < 3) continue;
      return res;
    }
  }

  /**
   * newAccount with the account key (the CA answers an existing account with
   * 200 and its URL). Accepts the terms of service. Returns the account URL.
   */
  async account(email: string | null, knownEmail: string | null | undefined): Promise<string> {
    const d = await this.dir();
    const contact = email ? [`mailto:${email}`] : [];
    const res = await this.post(
      d.newAccount,
      { termsOfServiceAgreed: true, ...(email ? { contact } : {}) },
      { jwk: true },
    );
    if (res.status !== 200 && res.status !== 201) throw failure(res, 'ACME-Konto');
    const loc = res.headers.get('location');
    if (!loc) throw new AcmeError('ACME-Konto ohne Adresse');
    this.kid = this.sameOrigin(loc);
    if (res.status === 200 && knownEmail !== undefined && knownEmail !== email) {
      const upd = await this.post(this.kid, { contact });
      if (upd.status !== 200) throw failure(upd, 'ACME-Kontakt');
    }
    return this.kid;
  }

  private async getJson<T>(url: string, schema: z.ZodType<T>, what: string): Promise<T> {
    const res = await this.post(url, null);
    if (res.status !== 200) throw failure(res, what);
    const parsed = schema.safeParse(parseJson(res.text));
    if (!parsed.success) throw new AcmeError(`Unerwartete Antwort (${what})`);
    return parsed.data;
  }

  private async pollAuthz(url: string): Promise<void> {
    for (let i = 0; i < this.o.maxPolls; i++) {
      const a = await this.getJson(url, authzSchema, 'Autorisierung');
      if (a.status === 'valid') return;
      if (a.status !== 'pending' && a.status !== 'processing')
        throw new AcmeError(`Autorisierung ${a.identifier.value} ungültig`);
      await this.o.sleep(this.o.pollMs);
    }
    throw new AcmeError('Autorisierung dauerte zu lange');
  }

  private async pollOrder(url: string, until: readonly string[]): Promise<Order> {
    for (let i = 0; i < this.o.maxPolls; i++) {
      const o = await this.getJson(url, orderSchema, 'Auftrag');
      if (until.includes(o.status)) return o;
      if (o.status === 'invalid') throw new AcmeError('ACME-Auftrag ungültig');
      await this.o.sleep(this.o.pollMs);
    }
    throw new AcmeError('ACME-Auftrag dauerte zu lange');
  }

  private async authorize(url: string, names: readonly string[], dns: Dns01Solver): Promise<void> {
    const a = await this.getJson(url, authzSchema, 'Autorisierung');
    if (a.status === 'valid') return;
    if (a.status !== 'pending') throw new AcmeError('Autorisierung nicht offen');
    const base = a.identifier.value.toLowerCase();
    const wanted = a.wildcard ? `*.${base}` : base;
    if (!names.includes(wanted)) throw new AcmeError('ACME-Server nannte einen fremden Namen');
    const ch = a.challenges.find((c) => c.type === 'dns-01');
    const token = tokenSchema.safeParse(ch?.token);
    if (!ch || !token.success) throw new AcmeError('Keine DNS-01-Challenge angeboten');
    const challengeUrl = this.sameOrigin(ch.url);
    const recordName = `_acme-challenge.${base}`;
    const value = dns01Value(token.data, this.o.accountKey);
    const handle = await dns.set(recordName, value);
    try {
      await dns.wait(recordName, value);
      const res = await this.post(challengeUrl, {});
      if (res.status !== 200) throw failure(res, 'Challenge');
      await this.pollAuthz(this.sameOrigin(url));
    } finally {
      await dns.clear(recordName, handle).catch(() => undefined);
    }
  }

  /**
   * Orders a certificate for `names` with the key `certKey` and returns the
   * PEM chain. Authorizations run one after the other (DuckDNS has only one TXT
   * value per subdomain).
   */
  async issue(names: readonly string[], certKey: KeyObject, dns: Dns01Solver): Promise<string> {
    const d = await this.dir();
    const res = await this.post(d.newOrder, {
      identifiers: names.map((value) => ({ type: 'dns', value })),
    });
    if (res.status !== 201) throw failure(res, 'ACME-Auftrag');
    const loc = res.headers.get('location');
    if (!loc) throw new AcmeError('ACME-Auftrag ohne Adresse');
    const orderUrl = this.sameOrigin(loc);
    const parsed = orderSchema.safeParse(parseJson(res.text));
    if (!parsed.success) throw new AcmeError('Unerwartete Antwort (Auftrag)');
    const authzUrls = parsed.data.authorizations.map((u) => this.sameOrigin(u));
    const finalizeUrl = this.sameOrigin(parsed.data.finalize);
    for (const url of authzUrls) await this.authorize(url, names, dns);

    await this.pollOrder(orderUrl, ['ready', 'processing', 'valid']);
    const fin = await this.post(finalizeUrl, { csr: b64u(buildCsr(certKey, names)) });
    if (fin.status !== 200) throw failure(fin, 'Finalisierung');
    const done = await this.pollOrder(orderUrl, ['valid']);
    if (!done.certificate) throw new AcmeError('ACME-Auftrag ohne Zertifikat');
    const cert = await this.post(this.sameOrigin(done.certificate), null, {
      accept: 'application/pem-certificate-chain',
    });
    if (cert.status !== 200) throw failure(cert, 'Zertifikat-Download');
    return cert.text;
  }
}

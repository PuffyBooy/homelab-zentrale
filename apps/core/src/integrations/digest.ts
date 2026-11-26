import { createHash, randomBytes } from 'node:crypto';
import { IntegrationError } from './http.js';

/**
 * HTTP Digest authentication (RFC 2617 / RFC 7616 subset): what TR-064 of the
 * FRITZ!Box requires. Only MD5 and MD5-sess with qop=auth (or no qop).
 */
export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque: string | null;
  qop: 'auth' | null;
  algorithm: 'MD5' | 'MD5-sess';
}

/** Values the server sends are re-quoted, so they must not contain quotes, backslashes or controls. */
const SAFE_VALUE = /^[\x20-\x7e]{0,500}$/;

function unexpected(): IntegrationError {
  return new IntegrationError('Unerwartete Antwort');
}

/** Parses `WWW-Authenticate: Digest realm="…", nonce="…", qop="auth", …`. */
export function parseDigestChallenge(header: string | string[] | undefined): DigestChallenge {
  const values = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const digest = values.find((v) => /^\s*digest\s/i.test(v));
  if (digest === undefined || digest.length > 4000) throw unexpected();
  const params = new Map<string, string>();
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/g;
  for (const m of digest.replace(/^\s*digest\s+/i, '').matchAll(re)) {
    const key = (m[1] ?? '').toLowerCase();
    const raw = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : (m[3] ?? '');
    if (!params.has(key)) params.set(key, raw);
  }
  const realm = params.get('realm');
  const nonce = params.get('nonce');
  if (realm === undefined || nonce === undefined || nonce === '') throw unexpected();
  const opaque = params.get('opaque') ?? null;
  for (const v of [realm, nonce, opaque ?? '']) {
    if (!SAFE_VALUE.test(v) || v.includes('"') || v.includes('\\')) throw unexpected();
  }
  const algo = (params.get('algorithm') ?? 'MD5').toUpperCase();
  if (algo !== 'MD5' && algo !== 'MD5-SESS') throw unexpected();
  const qopList = params.get('qop');
  let qop: DigestChallenge['qop'] = null;
  if (qopList !== undefined) {
    if (!qopList.split(',').some((q) => q.trim().toLowerCase() === 'auth')) throw unexpected();
    qop = 'auth';
  }
  return { realm, nonce, opaque, qop, algorithm: algo === 'MD5' ? 'MD5' : 'MD5-sess' };
}

function md5(s: string): string {
  // MD5 is mandated by HTTP Digest as TR-064 of the FRITZ!Box speaks it; never used for storage.
  // nosemgrep
  return createHash('md5').update(s, 'utf8').digest('hex');
}

export interface DigestInput {
  username: string;
  password: string;
  method: string;
  uri: string;
  nc: number;
  /** Tests pass a fixed cnonce. */
  cnonce?: string;
}

/** The `Authorization` header value for one request. */
export function digestAuthorization(ch: DigestChallenge, input: DigestInput): string {
  if (!SAFE_VALUE.test(input.username) || /["\\]/.test(input.username)) throw unexpected();
  if (!SAFE_VALUE.test(input.uri) || /["\\]/.test(input.uri)) throw unexpected();
  const cnonce = input.cnonce ?? randomBytes(16).toString('hex');
  const nc = input.nc.toString(16).padStart(8, '0');
  let ha1 = md5(`${input.username}:${ch.realm}:${input.password}`);
  if (ch.algorithm === 'MD5-sess') ha1 = md5(`${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = md5(`${input.method}:${input.uri}`);
  const response =
    ch.qop === 'auth'
      ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:auth:${ha2}`)
      : md5(`${ha1}:${ch.nonce}:${ha2}`);
  const parts = [
    `username="${input.username}"`,
    `realm="${ch.realm}"`,
    `nonce="${ch.nonce}"`,
    `uri="${input.uri}"`,
    `algorithm=${ch.algorithm}`,
    `response="${response}"`,
  ];
  if (ch.qop === 'auth') parts.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
  if (ch.opaque !== null) parts.push(`opaque="${ch.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';

/**
 * Minimal DER (X.690) encoder for the certificate signing request of the ACME
 * client: only the types a PKCS#10 CSR with a subjectAltName needs.
 */

function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);
}

export const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
export const octetString = (b: Buffer): Buffer => tlv(0x04, b);
export const utf8String = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
/** BIT STRING without unused bits. */
export const bitString = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
/** Context-specific tag: constructed (EXPLICIT / IMPLICIT SET) or primitive. */
export const ctx = (n: number, content: Buffer, constructed = true): Buffer =>
  tlv((constructed ? 0xa0 : 0x80) | n, content);

/** Non-negative INTEGER from a small number or big-endian bytes. */
export function integer(v: number | Buffer): Buffer {
  let b: Buffer;
  if (typeof v === 'number') {
    const bytes: number[] = [];
    let n = v;
    do {
      bytes.unshift(n & 0xff);
      n = Math.floor(n / 256);
    } while (n > 0);
    b = Buffer.from(bytes);
  } else {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    b = v.subarray(i);
  }
  if ((b[0] ?? 0) & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const [a = 0, b = 0, ...rest] = parts;
  const out: number[] = [a * 40 + b];
  for (const p of rest) {
    const chunk: number[] = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

export const OID = {
  commonName: '2.5.4.3',
  subjectAltName: '2.5.29.17',
  extensionRequest: '1.2.840.113549.1.9.14',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
} as const;

/** GeneralNames with one dNSName per name (IA5String, [2] IMPLICIT). */
export function sanExtension(names: readonly string[]): Buffer {
  const general = names.map((n) => ctx(2, Buffer.from(n, 'ascii'), false));
  return seq(oid(OID.subjectAltName), octetString(seq(...general)));
}

/** Name with a single CN, or an empty Name if the CN would be too long (RFC 5280: 64). */
export function nameWithCn(cn: string | null): Buffer {
  if (cn === null || cn.length > 64) return seq();
  return seq(set(seq(oid(OID.commonName), utf8String(cn))));
}

/**
 * PKCS#10 certificate signing request (DER) for an EC P-256 key with all names
 * in the subjectAltName and the first one as CN, signed with ECDSA-SHA256.
 */
export function buildCsr(privateKey: KeyObject, names: readonly string[]): Buffer {
  const pub = createPublicKey(privateKey);
  const spki = pub.export({ type: 'spki', format: 'der' });
  const attributes = ctx(0, seq(oid(OID.extensionRequest), set(seq(sanExtension(names)))));
  const info = seq(integer(0), nameWithCn(names[0] ?? null), spki, attributes);
  const signature = sign('sha256', info, { key: privateKey, dsaEncoding: 'der' });
  return seq(info, seq(oid(OID.ecdsaWithSha256)), bitString(signature));
}

/** PEM of a PKCS#8 private key (the format the agent's cert.write accepts). */
export function privateKeyPem(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export function keyFromPem(pem: string): KeyObject {
  return createPrivateKey({ key: pem, format: 'pem' });
}

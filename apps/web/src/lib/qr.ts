/**
 * Minimal QR code encoder (ISO/IEC 18004): byte mode, error correction M, versions 1–10
 * (up to 213 bytes, enough for a wall device link). Written here because the web app has
 * no QR dependency (docs/QUESTIONS.md, M9). Follows the reference algorithm by Nayuki
 * (MIT); the matrix is checked against the `qrcode` package in lib/qr.test.ts fixtures.
 */

const MAX_VERSION = 10;
/** Error correction M: codewords per block and number of blocks, index = version. */
const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Format bits of level M. */
const ECL_M_BITS = 0;

export interface QrCode {
  version: number;
  size: number;
  mask: number;
  /** modules[y][x], true = dark. */
  modules: boolean[][];
}

/** Array read without `!` (noUncheckedIndexedAccess): out of range reads as 0. */
function at(arr: ArrayLike<number>, i: number): number {
  return arr[i] ?? 0;
}

function bit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - at(ECC_PER_BLOCK_M, ver) * at(BLOCKS_M, ver);
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---- Reed-Solomon over GF(2^8) with polynomial 0x11D ----

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(at(result, j), root);
      if (j + 1 < degree) result[j] = at(result, j) ^ at(result, j + 1);
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = at(result, i) ^ gfMul(coef, factor);
    });
  }
  return result;
}

// ---- encoding ----

function encodeData(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = [];
  const push = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(ver) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | at(bits, i + j);
    out.push(v);
  }
  return out;
}

function addEcc(data: number[], ver: number): number[] {
  const numBlocks = at(BLOCKS_M, ver);
  const eccLen = at(ECC_PER_BLOCK_M, ver);
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  const blockLen = blocks[0]?.length ?? 0;
  for (let i = 0; i < blockLen; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(at(block, i));
    });
  }
  return result;
}

class Matrix {
  /** Row-major, 1 = dark. */
  readonly dark: Uint8Array;
  /** 1 = function pattern (finder, timing, format …), never masked. */
  readonly fn: Uint8Array;
  constructor(readonly size: number) {
    this.dark = new Uint8Array(size * size);
    this.fn = new Uint8Array(size * size);
  }
  get(x: number, y: number): boolean {
    return at(this.dark, y * this.size + x) === 1;
  }
  isFn(x: number, y: number): boolean {
    return at(this.fn, y * this.size + x) === 1;
  }
  put(x: number, y: number, dark: boolean): void {
    this.dark[y * this.size + x] = dark ? 1 : 0;
  }
  set(x: number, y: number, dark: boolean): void {
    this.put(x, y, dark);
    this.fn[y * this.size + x] = 1;
  }
  rows(): boolean[][] {
    return Array.from({ length: this.size }, (_, y) =>
      Array.from({ length: this.size }, (_, x) => this.get(x, y)),
    );
  }
}

function drawFunctionPatterns(m: Matrix, ver: number): void {
  const size = m.size;
  for (let i = 0; i < size; i++) {
    m.set(6, i, i % 2 === 0);
    m.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) m.set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const pos = alignmentPositions(ver);
  const last = pos.length - 1;
  pos.forEach((px, i) => {
    pos.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          m.set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });
  drawFormatBits(m, 0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = bit(bits, i);
      const a = size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      m.set(a, c, b);
      m.set(c, a, b);
    }
  }
}

function drawFormatBits(m: Matrix, mask: number): void {
  const data = (ECL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const size = m.size;
  for (let i = 0; i <= 5; i++) m.set(8, i, bit(bits, i));
  m.set(8, 7, bit(bits, 6));
  m.set(8, 8, bit(bits, 7));
  m.set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) m.set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) m.set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) m.set(8, size - 15 + i, bit(bits, i));
  m.set(8, size - 8, true);
}

function drawCodewords(m: Matrix, data: readonly number[]): void {
  const size = m.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!m.isFn(x, y) && i < data.length * 8) {
          m.put(x, y, bit(at(data, i >>> 3), 7 - (i & 7)));
          i++;
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.isFn(x, y) && maskBit(mask, x, y)) m.put(x, y, !m.get(x, y));
    }
  }
}

/** Penalty rules 1–4 of the standard (lower is easier to scan). */
function penalty(m: Matrix): number {
  const size = m.size;
  let score = 0;
  const finder = [true, false, true, true, true, false, true, false, false, false, false];
  const finderRev = [...finder].reverse();
  for (const col of [false, true]) {
    const cell = (a: number, b: number): boolean => (col ? m.get(b, a) : m.get(a, b));
    for (let y = 0; y < size; y++) {
      let run = 1;
      for (let x = 1; x <= size; x++) {
        if (x < size && cell(x, y) === cell(x - 1, y)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      // Finder-like 1:1:3:1:1 with 4 light modules on one side.
      for (let x = 0; x + 10 < size; x++) {
        const match = (p: boolean[]): boolean => p.every((v, k) => cell(x + k, y) === v);
        if (match(finder) || match(finderRev)) score += 40;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = m.get(x, y);
      if (c) dark++;
      if (
        x + 1 < size &&
        y + 1 < size &&
        c === m.get(x + 1, y) &&
        c === m.get(x, y + 1) &&
        c === m.get(x + 1, y + 1)
      ) {
        score += 3;
      }
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encodes UTF-8 text. `forceMask`/`minVersion` exist for the fixture test. */
export function encodeQr(
  text: string,
  opts: { forceMask?: number; minVersion?: number } = {},
): QrCode {
  const bytes = new TextEncoder().encode(text);
  let ver = Math.max(1, opts.minVersion ?? 1);
  for (; ver <= MAX_VERSION; ver++) {
    const header = 4 + (ver <= 9 ? 8 : 16);
    if (header + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > MAX_VERSION) throw new Error('qr: text too long');
  const codewords = addEcc(encodeData(bytes, ver), ver);
  const size = ver * 4 + 17;

  let best: { mask: number; m: Matrix; score: number } | null = null;
  const masks = opts.forceMask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.forceMask];
  for (const mask of masks) {
    const m = new Matrix(size);
    drawFunctionPatterns(m, ver);
    drawCodewords(m, codewords);
    applyMask(m, mask);
    drawFormatBits(m, mask);
    const score = masks.length > 1 ? penalty(m) : 0;
    if (!best || score < best.score) best = { mask, m, score };
  }
  if (!best) throw new Error('qr: no mask');
  return { version: ver, size, mask: best.mask, modules: best.m.rows() };
}

/** SVG path ("M x y h1 v1 h-1 z" per dark module) with a 4-module quiet zone. */
export function qrPath(qr: QrCode, quiet = 4): string {
  const parts: string[] = [];
  qr.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    });
  });
  return parts.join('');
}

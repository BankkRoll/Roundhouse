/**
 * A QR code encoder (ISO/IEC 18004, model 2), small enough to keep in the dashboard so
 * an authenticator enrollment URI never leaves the browser for a third-party QR service.
 *
 * Byte mode only, versions 1–40, all four error correction levels, and the standard
 * mask selection by penalty score. The algorithm follows Project Nayuki's reference
 * implementation; `qr.test.ts` checks the output module for module against an
 * independent encoder.
 *
 * @module
 */

/** Error correction level: about 7, 15, 25 or 30 percent of codewords recoverable. */
export type QrErrorCorrection = "L" | "M" | "Q" | "H";

/** An encoded symbol. */
export interface QrCode {
  /** 1 to 40. */
  version: number;
  /** Modules per side: `17 + 4 × version`. */
  size: number;
  /** 0 to 7. */
  mask: number;
  /** `modules[y][x]` is `true` for a dark module. */
  modules: boolean[][];
}

/** Options for {@link encodeQr}. */
export interface QrOptions {
  /** Defaults to `M`. */
  errorCorrection?: QrErrorCorrection;
  /** Force a mask pattern instead of choosing the best by penalty. */
  mask?: number;
  /** Smallest version to use. Defaults to 1. */
  minVersion?: number;
}

const ECL_INDEX: Record<QrErrorCorrection, number> = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_FORMAT_BITS: Record<QrErrorCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Indexed [level][version]; index 0 is padding.
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
    30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30,
    30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
];

const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
    15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
    25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
    34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35,
    37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

// -----------------------------------------------------------------------------
// Capacity
// -----------------------------------------------------------------------------

/** Modules available for data and ECC after the function patterns. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, level: number): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[level]![version]! * NUM_ERROR_CORRECTION_BLOCKS[level]![version]!
  );
}

// -----------------------------------------------------------------------------
// Reed-Solomon over GF(2^8), polynomial 0x11D
// -----------------------------------------------------------------------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i]! ^= gfMultiply(coefficient, factor);
    });
  }
  return result;
}

function withEccInterleaved(data: readonly number[], version: number, level: number): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[level]![version]!;
  const eccLength = ECC_CODEWORDS_PER_BLOCK[level]![version]!;
  const raw = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (raw % numBlocks);
  const shortBlockLength = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLength);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const block = data.slice(k, k + shortBlockLength - eccLength + (i < numShortBlocks ? 0 : 1));
    k += block.length;
    const ecc = rsRemainder(block, divisor);
    if (i < numShortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      // The padding byte of a short block is not transmitted.
      if (i !== shortBlockLength - eccLength || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

// -----------------------------------------------------------------------------
// Symbol
// -----------------------------------------------------------------------------

const bit = (value: number, i: number) => ((value >>> i) & 1) !== 0;

class QrSymbol {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  constructor(
    readonly version: number,
    private readonly level: QrErrorCorrection,
  ) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.drawFunctionPatterns();
  }

  private set(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  private drawFunctionPatterns() {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const positions = this.alignmentPositions();
    const n = positions.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const nearFinder =
          (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
        if (!nearFinder) this.drawAlignment(positions[i]!, positions[j]!);
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  }

  private drawFinder(x: number, y: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.set(xx, yy, distance !== 2 && distance !== 4);
        }
      }
    }
  }

  private drawAlignment(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  drawFormatBits(mask: number) {
    const data = (ECL_FORMAT_BITS[this.level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(bits, i));
    this.set(8, this.size - 8, true);
  }

  private drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = bit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  drawCodewords(data: readonly number[]) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (!this.isFunction[y]![x] && invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  penalty(): number {
    let result = 0;
    const size = this.size;
    const line = (get: (i: number) => boolean) => {
      let runColor = false;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < size; i++) {
        if (get(i) === runColor) {
          runLength++;
          if (runLength === 5) result += PENALTY_N1;
          else if (runLength > 5) result++;
        } else {
          this.addHistory(runLength, history);
          if (!runColor) result += this.countFinderLike(history) * PENALTY_N3;
          runColor = get(i);
          runLength = 1;
        }
      }
      if (runColor) {
        this.addHistory(runLength, history);
        runLength = 0;
      }
      this.addHistory(runLength + size, history);
      result += this.countFinderLike(history) * PENALTY_N3;
    };
    for (let y = 0; y < size; y++) line((x) => this.modules[y]![x]!);
    for (let x = 0; x < size; x++) line((y) => this.modules[y]![x]!);
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = this.modules[y]![x];
        if (
          color === this.modules[y]![x + 1] &&
          color === this.modules[y + 1]![x] &&
          color === this.modules[y + 1]![x + 1]
        ) {
          result += PENALTY_N2;
        }
      }
    }
    const dark = this.modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }

  private addHistory(runLength: number, history: number[]) {
    // The light border around the symbol extends the first run.
    const length = history[0] === 0 ? runLength + this.size : runLength;
    history.pop();
    history.unshift(length);
  }

  private countFinderLike(history: readonly number[]): number {
    const n = history[1]!;
    const core =
      n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (
      (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) +
      (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0)
    );
  }
}

// -----------------------------------------------------------------------------
// Encoding
// -----------------------------------------------------------------------------

/**
 * Encodes text (as UTF-8 bytes) into a QR code.
 *
 * @param text - What the code carries, e.g. an `otpauth://` URI.
 * @param options - Error correction level, a forced mask or a minimum version.
 * @returns The symbol's modules.
 * @throws {RangeError} When the text doesn't fit in version 40.
 * @example
 * const qr = encodeQr("otpauth://totp/Roundhouse:ada%40example.com?secret=…");
 * qr.modules[0][0]; // true: the top-left finder pattern
 */
export function encodeQr(text: string, options: QrOptions = {}): QrCode {
  const level = options.errorCorrection ?? "M";
  const levelIndex = ECL_INDEX[level];
  const bytes = [...new TextEncoder().encode(text)];

  let version = Math.max(1, options.minVersion ?? 1);
  let usedBits = 0;
  for (; ; version++) {
    if (version > 40) throw new RangeError("Text is too long for a QR code");
    usedBits = 4 + (version < 10 ? 8 : 16) + bytes.length * 8;
    if (usedBits <= dataCodewords(version, levelIndex) * 8) break;
  }

  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  const capacity = dataCodewords(version, levelIndex) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((byte, b) => (byte << 1) | b, 0));
  }

  const symbol = new QrSymbol(version, level);
  symbol.drawCodewords(withEccInterleaved(data, version, levelIndex));

  let mask = options.mask ?? -1;
  if (mask < 0) {
    let best = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < 8; candidate++) {
      symbol.applyMask(candidate);
      symbol.drawFormatBits(candidate);
      const score = symbol.penalty();
      if (score < best) {
        best = score;
        mask = candidate;
      }
      symbol.applyMask(candidate);
    }
  }
  symbol.applyMask(mask);
  symbol.drawFormatBits(mask);
  return { version, size: symbol.size, mask, modules: symbol.modules };
}

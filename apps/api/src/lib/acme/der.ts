/**
 * A minimal ASN.1 DER encoder and decoder (X.690), just enough for PKCS#10
 * certificate requests, X.509 certificate parsing and ECDSA signatures.
 *
 * - Encoding: {@link encodeTlv} plus typed helpers ({@link derSequence},
 *   {@link derInteger}, {@link derOid}, ...). Output is canonical DER.
 * - Decoding: {@link decodeDer} parses one complete element into a
 *   {@link DerNode} tree (constructed elements are parsed recursively), and
 *   the `read*` helpers interpret primitive contents.
 *
 * SECURITY: the decoder reads untrusted bytes (certificates from the CA), so
 * it is strict: definite lengths only, minimal length encoding, no
 * high-tag-number form, bounded nesting depth, and no trailing bytes.
 *
 * @module
 */

import { concatBytes, utf8 } from "./encoding";

/** Universal and context tag bytes used by this package. */
export const DerTag = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  T61_STRING: 0x14,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  BMP_STRING: 0x1e,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** One decoded DER element. */
export interface DerNode {
  /** The full identifier octet (class, constructed bit and tag number). */
  tag: number;
  /** Whether the constructed bit is set; `children` is then populated. */
  constructed: boolean;
  /** The content octets (excluding tag and length). */
  value: Uint8Array;
  /** The complete encoding of this element, tag and length included. */
  raw: Uint8Array;
  /** Parsed children of a constructed element; empty for primitives. */
  children: DerNode[];
}

const MAX_DEPTH = 32;

// -----------------------------------------------------------------------------
// Encoding
// -----------------------------------------------------------------------------

function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/**
 * Encodes one tag-length-value element.
 *
 * @param tag - The identifier octet (single-byte tags only).
 * @param content - The content octets.
 * @returns The DER encoding.
 */
export function encodeTlv(tag: number, content: Uint8Array): Uint8Array {
  if (tag < 0 || tag > 0xff || (tag & 0x1f) === 0x1f) throw new Error("unsupported DER tag");
  return concatBytes(Uint8Array.of(tag), encodeLength(content.length), content);
}

/**
 * Encodes a SEQUENCE of already-encoded elements.
 *
 * @param items - The encoded children.
 * @returns The DER encoding.
 */
export function derSequence(...items: Uint8Array[]): Uint8Array {
  return encodeTlv(DerTag.SEQUENCE, concatBytes(...items));
}

/**
 * Encodes a SET OF already-encoded elements, sorted as DER requires
 * (X.690 §11.6).
 *
 * @param items - The encoded children.
 * @returns The DER encoding.
 */
export function derSet(...items: Uint8Array[]): Uint8Array {
  const sorted = [...items].sort(compareBytes);
  return encodeTlv(DerTag.SET, concatBytes(...sorted));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/**
 * Encodes a non-negative INTEGER from a number or big-endian unsigned bytes,
 * minimally (leading zeros stripped, a `0x00` added when the top bit is set).
 *
 * @param value - A non-negative safe integer, or unsigned big-endian bytes.
 * @returns The DER encoding.
 * @example
 * derInteger(0); // 02 01 00
 * derInteger(Uint8Array.of(0x80)); // 02 02 00 80
 */
export function derInteger(value: number | Uint8Array): Uint8Array {
  let bytes: Uint8Array;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("unsupported INTEGER value");
    const list: number[] = [];
    for (let n = value; n > 0; n = Math.floor(n / 256)) list.unshift(n % 256);
    bytes = Uint8Array.from(list);
  } else {
    bytes = value;
  }
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let content = bytes.subarray(start);
  if (content.length === 0) content = Uint8Array.of(0);
  if ((content[0] ?? 0) & 0x80) content = concatBytes(Uint8Array.of(0), content);
  return encodeTlv(DerTag.INTEGER, content);
}

/**
 * Encodes an OBJECT IDENTIFIER from dotted-decimal text.
 *
 * @param dotted - e.g. `2.5.29.17`.
 * @returns The DER encoding.
 */
export function derOid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map((part) => {
    if (!/^\d+$/.test(part)) throw new Error(`invalid OID: ${dotted}`);
    return Number(part);
  });
  const [first, second, ...rest] = arcs;
  if (first === undefined || second === undefined || first > 2 || (first < 2 && second > 39)) {
    throw new Error(`invalid OID: ${dotted}`);
  }
  const out: number[] = [];
  for (const arc of [first * 40 + second, ...rest]) {
    if (!Number.isSafeInteger(arc)) throw new Error(`invalid OID: ${dotted}`);
    const chunk: number[] = [arc & 0x7f];
    for (let n = Math.floor(arc / 128); n > 0; n = Math.floor(n / 128))
      chunk.unshift(0x80 | (n & 0x7f));
    out.push(...chunk);
  }
  return encodeTlv(DerTag.OID, Uint8Array.from(out));
}

/**
 * Encodes NULL.
 *
 * @returns `05 00`.
 */
export function derNull(): Uint8Array {
  return Uint8Array.of(DerTag.NULL, 0);
}

/**
 * Encodes a BOOLEAN (DER uses `0xff` for true).
 *
 * @param value - The value.
 * @returns The DER encoding.
 */
export function derBoolean(value: boolean): Uint8Array {
  return Uint8Array.of(DerTag.BOOLEAN, 1, value ? 0xff : 0);
}

/**
 * Encodes an OCTET STRING.
 *
 * @param bytes - The content.
 * @returns The DER encoding.
 */
export function derOctetString(bytes: Uint8Array): Uint8Array {
  return encodeTlv(DerTag.OCTET_STRING, bytes);
}

/**
 * Encodes a BIT STRING of whole bytes (zero unused bits).
 *
 * @param bytes - The content.
 * @returns The DER encoding.
 */
export function derBitString(bytes: Uint8Array): Uint8Array {
  return encodeTlv(DerTag.BIT_STRING, concatBytes(Uint8Array.of(0), bytes));
}

/**
 * Encodes a UTF8String.
 *
 * @param text - The text.
 * @returns The DER encoding.
 */
export function derUtf8String(text: string): Uint8Array {
  return encodeTlv(DerTag.UTF8_STRING, utf8(text));
}

/**
 * Encodes an IA5String (ASCII only).
 *
 * @param text - ASCII text.
 * @returns The DER encoding.
 * @throws {Error} When `text` has non-ASCII characters.
 */
export function derIa5String(text: string): Uint8Array {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: IA5 is exactly the 7-bit range
  if (!/^[\x00-\x7f]*$/.test(text)) throw new Error("IA5String must be ASCII");
  return encodeTlv(DerTag.IA5_STRING, utf8(text));
}

/**
 * Encodes a context-specific EXPLICIT wrapper (`[n] { inner }`).
 *
 * @param n - The tag number (0–30).
 * @param inner - The encoded inner element.
 * @returns The DER encoding.
 */
export function derExplicit(n: number, inner: Uint8Array): Uint8Array {
  return encodeTlv(0xa0 | n, inner);
}

/**
 * Encodes a context-specific IMPLICIT element (`[n] IMPLICIT ...`).
 *
 * @param n - The tag number (0–30).
 * @param content - The content octets of the underlying type.
 * @param constructed - Whether the underlying type is constructed (SET, SEQUENCE).
 * @returns The DER encoding.
 */
export function derImplicit(n: number, content: Uint8Array, constructed = false): Uint8Array {
  return encodeTlv((constructed ? 0xa0 : 0x80) | n, content);
}

// -----------------------------------------------------------------------------
// Decoding
// -----------------------------------------------------------------------------

function readElement(bytes: Uint8Array, offset: number, depth: number): DerNode {
  if (depth > MAX_DEPTH) throw new Error("DER nesting too deep");
  const tag = bytes[offset];
  if (tag === undefined) throw new Error("DER truncated");
  if ((tag & 0x1f) === 0x1f) throw new Error("DER high-tag-number form unsupported");
  const first = bytes[offset + 1];
  if (first === undefined) throw new Error("DER truncated");
  let length: number;
  let headerLength: number;
  if (first < 0x80) {
    length = first;
    headerLength = 2;
  } else {
    const count = first & 0x7f;
    if (count === 0) throw new Error("DER indefinite length not allowed");
    if (count > 4) throw new Error("DER length too large");
    length = 0;
    for (let i = 0; i < count; i++) {
      const b = bytes[offset + 2 + i];
      if (b === undefined) throw new Error("DER truncated");
      if (i === 0 && b === 0) throw new Error("DER non-minimal length");
      length = length * 256 + b;
    }
    if (length < 0x80) throw new Error("DER non-minimal length");
    headerLength = 2 + count;
  }
  const start = offset + headerLength;
  const end = start + length;
  if (end > bytes.length) throw new Error("DER truncated");
  const value = bytes.subarray(start, end);
  const constructed = (tag & 0x20) !== 0;
  const children: DerNode[] = [];
  if (constructed) {
    let pos = 0;
    while (pos < value.length) {
      const child = readElement(value, pos, depth + 1);
      children.push(child);
      pos += child.raw.length;
    }
  }
  return { tag, constructed, value, raw: bytes.subarray(offset, end), children };
}

/**
 * Decodes exactly one DER element (and everything nested in it).
 *
 * @param bytes - The encoding.
 * @returns The parsed tree.
 * @throws {Error} On malformed or non-canonical-length input, or trailing bytes.
 */
export function decodeDer(bytes: Uint8Array): DerNode {
  const node = readElement(bytes, 0, 0);
  if (node.raw.length !== bytes.length) throw new Error("DER trailing bytes");
  return node;
}

/**
 * Asserts `node` has `tag` and returns it, for readable structure walking.
 *
 * @param node - The element (possibly missing).
 * @param tag - The expected identifier octet.
 * @param what - A name for error messages.
 * @returns The same node.
 * @throws {Error} When the node is missing or has another tag.
 */
export function expectTag(node: DerNode | undefined, tag: number, what: string): DerNode {
  if (!node) throw new Error(`DER: missing ${what}`);
  if (node.tag !== tag) {
    throw new Error(
      `DER: ${what} has tag 0x${node.tag.toString(16)}, expected 0x${tag.toString(16)}`,
    );
  }
  return node;
}

/**
 * Decodes an OBJECT IDENTIFIER's content octets to dotted-decimal text.
 *
 * @param node - An OID element.
 * @returns e.g. `1.2.840.10045.2.1`.
 */
export function readOid(node: DerNode): string {
  expectTag(node, DerTag.OID, "OID");
  const arcs: number[] = [];
  let value = 0;
  for (let i = 0; i < node.value.length; i++) {
    const b = node.value[i] ?? 0;
    if (value === 0 && b === 0x80) throw new Error("DER: non-minimal OID arc");
    value = value * 128 + (b & 0x7f);
    if (!Number.isSafeInteger(value)) throw new Error("DER: OID arc too large");
    if ((b & 0x80) === 0) {
      if (arcs.length === 0) {
        const first = value < 80 ? Math.floor(value / 40) : 2;
        arcs.push(first, value - first * 40);
      } else {
        arcs.push(value);
      }
      value = 0;
    } else if (i === node.value.length - 1) {
      throw new Error("DER: truncated OID");
    }
  }
  if (arcs.length === 0) throw new Error("DER: empty OID");
  return arcs.join(".");
}

/**
 * Returns an INTEGER's content octets with any sign-padding `0x00` removed,
 * i.e. the unsigned big-endian magnitude of a non-negative integer.
 *
 * @param node - An INTEGER element.
 * @returns The magnitude bytes (at least one byte).
 * @throws {Error} For negative integers, which nothing here should carry.
 */
export function readUnsignedInteger(node: DerNode): Uint8Array {
  expectTag(node, DerTag.INTEGER, "INTEGER");
  const v = node.value;
  if (v.length === 0) throw new Error("DER: empty INTEGER");
  if ((v[0] ?? 0) & 0x80) throw new Error("DER: negative INTEGER");
  return v.length > 1 && v[0] === 0 ? v.subarray(1) : v;
}

/**
 * Reads a small non-negative INTEGER as a number.
 *
 * @param node - An INTEGER element.
 * @returns Its value.
 */
export function readSmallInteger(node: DerNode): number {
  const bytes = readUnsignedInteger(node);
  if (bytes.length > 6) throw new Error("DER: INTEGER too large");
  return bytes.reduce((n, b) => n * 256 + b, 0);
}

/**
 * Returns a BIT STRING's bytes, requiring zero unused bits.
 *
 * @param node - A BIT STRING element.
 * @returns The bit string's bytes.
 */
export function readBitString(node: DerNode): Uint8Array {
  expectTag(node, DerTag.BIT_STRING, "BIT STRING");
  if (node.value[0] !== 0) throw new Error("DER: BIT STRING with unused bits");
  return node.value.subarray(1);
}

/**
 * Decodes the common ASN.1 string types to text.
 *
 * @param node - A UTF8String, PrintableString, IA5String, T61String or BMPString.
 * @returns The text.
 */
export function readString(node: DerNode): string {
  switch (node.tag) {
    case DerTag.UTF8_STRING:
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(node.value);
    case DerTag.PRINTABLE_STRING:
    case DerTag.IA5_STRING:
    case DerTag.T61_STRING:
      return String.fromCharCode(...node.value);
    case DerTag.BMP_STRING: {
      let out = "";
      for (let i = 0; i + 1 < node.value.length; i += 2) {
        out += String.fromCharCode(((node.value[i] ?? 0) << 8) | (node.value[i + 1] ?? 0));
      }
      return out;
    }
    default:
      throw new Error(`DER: tag 0x${node.tag.toString(16)} is not a string`);
  }
}

/**
 * Decodes a UTCTime or GeneralizedTime (UTC, `Z`-suffixed, as RFC 5280
 * requires) to a millisecond timestamp.
 *
 * @param node - A time element.
 * @returns Milliseconds since the epoch.
 */
export function readTime(node: DerNode): number {
  const text = String.fromCharCode(...node.value);
  let match: RegExpMatchArray | null;
  let year: number;
  if (node.tag === DerTag.UTC_TIME) {
    match = text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!match) throw new Error("DER: malformed UTCTime");
    const yy = Number(match[1]);
    // RFC 5280 §4.1.2.5.1: two-digit years 50–99 are 19xx.
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (node.tag === DerTag.GENERALIZED_TIME) {
    match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!match) throw new Error("DER: malformed GeneralizedTime");
    year = Number(match[1]);
  } else {
    throw new Error("DER: not a time");
  }
  const [, , mo, d, h, mi, s] = match.map(Number);
  return Date.UTC(year, (mo ?? 1) - 1, d, h, mi, s);
}

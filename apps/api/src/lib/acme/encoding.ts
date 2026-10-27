/**
 * Byte encodings shared by the ACME client: base64url (RFC 4648 §5, unpadded
 * as JWS requires), standard base64, hex and PEM armouring.
 *
 * Only `atob`/`btoa`/`TextEncoder` are used, so the module runs unchanged in
 * workerd and Node.
 *
 * @module
 */

const encoder = new TextEncoder();

/**
 * Encodes UTF-8 text as bytes.
 *
 * @param text - The text to encode.
 * @returns Its UTF-8 bytes.
 */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * Standard (padded) base64 of `bytes`.
 *
 * @param bytes - The bytes to encode.
 * @returns The base64 text.
 */
export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  // PERF: chunked so a multi-kilobyte chain never builds one huge argument list.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Decodes standard base64 (padding optional, whitespace ignored).
 *
 * @param text - The base64 text.
 * @returns The decoded bytes.
 * @throws {Error} When the input is not base64.
 */
export function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error("invalid base64");
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Unpadded base64url of `input` (text is UTF-8 encoded first).
 *
 * @param input - Bytes, or text to encode as UTF-8.
 * @returns The base64url text.
 * @example
 * base64UrlEncode("{}"); // "e30"
 */
export function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? utf8(input) : input;
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes base64url, padded or not.
 *
 * @param text - The base64url text.
 * @returns The decoded bytes.
 * @throws {Error} When the input is not base64url.
 */
export function base64UrlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error("invalid base64url");
  const std = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  return base64Decode(std + "=".repeat((4 - (std.length % 4)) % 4));
}

/**
 * Lowercase hex of `bytes`.
 *
 * @param bytes - The bytes to encode.
 * @returns The hex text.
 */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Decodes hex (either case).
 *
 * @param hex - An even-length hex string.
 * @returns The decoded bytes.
 * @throws {Error} When the input is not hex.
 */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Wraps DER bytes in PEM armour with 64-column lines and `\n` endings.
 *
 * @param label - The armour label, e.g. `CERTIFICATE`.
 * @param der - The DER bytes.
 * @returns The PEM block, ending in a single `\n`.
 */
export function pemEncode(label: string, der: Uint8Array): string {
  const body = base64Encode(der).replace(/.{64}/g, "$&\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/**
 * Extracts every PEM block with the given label, in order.
 *
 * @param pem - Text holding zero or more PEM blocks (any line endings).
 * @param label - The armour label to match.
 * @returns The DER bytes of each block.
 * @throws {Error} When a block's body is not base64.
 */
export function pemDecodeAll(pem: string, label: string): Uint8Array[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`-----BEGIN ${escaped}-----([\\s\\S]*?)-----END ${escaped}-----`, "g");
  const out: Uint8Array[] = [];
  for (const match of pem.matchAll(re)) out.push(base64Decode(match[1] ?? ""));
  return out;
}

/**
 * Copies `bytes` into a fresh `ArrayBuffer`-backed view, which WebCrypto's
 * `BufferSource` typing requires.
 *
 * @param bytes - The bytes to copy.
 * @returns An `ArrayBuffer` holding exactly those bytes.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/**
 * Concatenates byte arrays.
 *
 * @param parts - The arrays to join.
 * @returns One array holding all of them in order.
 */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

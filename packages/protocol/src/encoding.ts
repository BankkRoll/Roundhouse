/**
 * Base64 helpers shared by envelopes (./signing) and sealed boxes (./box).
 * Kept apart from both so neither has to import the other.
 *
 * @module
 */

/**
 * Encodes bytes as standard base64.
 *
 * @param bytes - Raw bytes.
 * @returns Padded base64 string.
 */
export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Decodes standard base64.
 *
 * @param value - Base64 string.
 * @returns Decoded bytes.
 */
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * TOTP (RFC 6238 over RFC 4226 HOTP, HMAC-SHA-1), matching Better Auth's
 * two-factor plugin byte for byte: the HMAC key is the UTF-8 encoding of the
 * stored secret string, 6 digits, 30-second steps, one step of clock skew
 * either way. Better Auth only answers "valid or not"; the control plane
 * also needs *which* step matched, to refuse a code that was already used
 * ({@link matchTotpStep}).
 *
 * @module
 */

/** Digits per code. */
export const TOTP_DIGITS = 6;

/** Seconds per time step. */
export const TOTP_PERIOD_S = 30;

/** Steps of clock skew accepted on either side of the current one. */
export const TOTP_WINDOW = 1;

const encoder = new TextEncoder();

/**
 * The HOTP value of a counter (RFC 4226 section 5.3).
 *
 * @param secret - The shared secret as stored (its UTF-8 bytes are the key).
 * @param counter - The moving factor.
 * @param digits - Code length.
 * @returns The zero-padded code.
 */
export async function hotp(secret: string, counter: number, digits = TOTP_DIGITS): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const message = new ArrayBuffer(8);
  new DataView(message).setBigUint64(0, BigInt(counter), false);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

/**
 * The time step a moment falls in.
 *
 * @param nowMs - Unix ms.
 * @returns `floor(now / period)`.
 */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / (TOTP_PERIOD_S * 1000));
}

/**
 * Compares two codes in time independent of where they differ.
 *
 * @param a - Code entered.
 * @param b - Code expected.
 * @returns Whether they are equal.
 */
function sameCode(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Finds the time step a TOTP code belongs to.
 *
 * Every step of the window is computed and compared whether or not an
 * earlier one matched, so the time taken says nothing about which did.
 *
 * @param secret - The shared secret as stored.
 * @param code - The code entered (surrounding whitespace is ignored).
 * @param nowMs - Unix ms.
 * @returns The matching step, or `null` when the code is wrong.
 * @example
 * const step = await matchTotpStep(secret, "287082", Date.now());
 */
export async function matchTotpStep(
  secret: string,
  code: string,
  nowMs: number,
): Promise<number | null> {
  const entered = code.trim();
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const step = current + delta;
    if (sameCode(entered, await hotp(secret, step)) && matched === null) matched = step;
  }
  return matched;
}

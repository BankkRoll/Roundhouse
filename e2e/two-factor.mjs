/**
 * Two-factor helpers for the end-to-end suites: the control plane makes the
 * setup admin enroll before any change (ADR 0014), so every suite that drives
 * it as that admin enrolls first and answers the sign-in challenge.
 *
 * TOTP is RFC 6238 exactly as the control plane checks it: HMAC-SHA-1 keyed
 * with the UTF-8 bytes of the secret, 6 digits, 30-second steps. A step is
 * accepted once per user, so {@link TotpSource} hands out increasing steps.
 *
 * @module
 */
import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_MS = 30_000;

/**
 * The secret inside an `otpauth://` URI, decoded from base32.
 *
 * @param {string} uri - The TOTP URI from `/api/auth/two-factor/enable`.
 * @returns {string} The secret as the server stores it.
 */
export function secretFromUri(uri) {
  const encoded = new URL(uri).searchParams.get("secret") ?? "";
  let bits = "";
  for (const ch of encoded.replace(/=+$/, "").toUpperCase()) {
    bits += BASE32.indexOf(ch).toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The code of one time step.
 *
 * @param {string} secret - The decoded secret.
 * @param {number} step - The time step.
 * @returns {string} Six digits.
 */
export function totpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", Buffer.from(secret, "utf8")).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(binary).padStart(6, "0");
}

/** Hands out codes for steps the server hasn't seen yet, waiting when none is left. */
export class TotpSource {
  /** @param {string} secret - The decoded secret. */
  constructor(secret) {
    this.secret = secret;
    this.last = Number.NEGATIVE_INFINITY;
  }

  /** @returns {string | null} A code the server will accept once, or `null` when none is left right now. */
  tryNext() {
    const current = Math.floor(Date.now() / PERIOD_MS);
    const step = Math.max(current - 1, this.last + 1);
    if (step > current + 1) return null;
    this.last = step;
    return totpAt(this.secret, step);
  }

  /** @returns {Promise<string>} A code the server will accept once. */
  async next() {
    for (;;) {
      const current = Math.floor(Date.now() / PERIOD_MS);
      const step = Math.max(current - 1, this.last + 1);
      if (step <= current + 1) {
        this.last = step;
        return totpAt(this.secret, step);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

/**
 * Enrolls the signed-in user through the API.
 *
 * @param {(path: string, body: unknown) => Promise<any>} post - Sends a JSON POST with the session.
 * @param {string} password - The user's password.
 * @returns {Promise<{ codes: TotpSource, backupCodes: string[] }>}
 */
export async function enrollTwoFactor(post, password) {
  const { totpURI, backupCodes } = await post("/api/auth/two-factor/enable", { password });
  const codes = new TotpSource(secretFromUri(totpURI));
  await post("/api/auth/two-factor/verify-totp", { code: await codes.next() });
  return { codes, backupCodes };
}

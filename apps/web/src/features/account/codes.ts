/**
 * Small helpers for two-factor codes, shared by the sign-in page and the security
 * dialogs.
 *
 * @module
 */

/**
 * The base32 key inside an `otpauth://` URI, in groups of four for typing by hand.
 *
 * @param uri - The TOTP URI.
 * @returns E.g. `KRSX G5CT MVRX …`, or `""` when the URI carries none.
 */
export function manualEntryKey(uri: string): string {
  let secret = "";
  try {
    secret = new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Normalises a code as typed: whitespace dropped, so "123 456" copied from an app's
 * display works.
 *
 * @param code - The code as entered.
 * @returns The code to send.
 */
export function normalizeCode(code: string): string {
  return code.replace(/\s+/g, "");
}

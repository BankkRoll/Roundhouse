/**
 * Generates a random key suitable for the Worker's `MASTER_KEY` secret.
 *
 * SECURITY: The key is generated in the browser with the platform CSPRNG and never sent to
 * the API; the operator pastes it into `wrangler secret put` themselves.
 *
 * @param byteLength - Number of random bytes. Defaults to 32 (256-bit).
 * @returns The bytes, base64-encoded (44 characters for 32 bytes).
 */
export function generateMasterKey(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Command that stores the master key as a Worker secret. */
export const MASTER_KEY_COMMAND = "npx wrangler secret put MASTER_KEY";

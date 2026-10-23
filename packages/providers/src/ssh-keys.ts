/**
 * SSH public key validation and stable naming, shared by every adapter.
 *
 * Providers identify keys by an MD5 fingerprint, but WebCrypto has no MD5,
 * so adapters match existing keys by their normalised `type base64` text
 * and name new ones after a SHA-256 of it.
 *
 * @module
 */
import { ProvisionError } from "./errors";

const KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

const BASE64 = /^[A-Za-z0-9+/]+={0,3}$/;

/**
 * Validates an OpenSSH public key and reduces it to `type base64`, dropping
 * the comment.
 *
 * @param publicKey - One line from an `.pub` file or `authorized_keys`.
 * @returns The normalised key.
 * @throws ProvisionError `invalid_input`.
 */
export function normalizeSshPublicKey(publicKey: string): string {
  const trimmed = publicKey.trim();
  if (/[\r\n]/.test(trimmed))
    throw new ProvisionError("invalid_input", "SSH public key must be a single line");
  const [type, body] = trimmed.split(/\s+/);
  if (!type || !KEY_TYPES.has(type) || !body || !BASE64.test(body) || body.length < 64) {
    throw new ProvisionError(
      "invalid_input",
      "SSH public key is not a supported OpenSSH public key",
    );
  }
  return `${type} ${body}`;
}

/**
 * Whether a provider's stored key text is the same key as `normalized`.
 *
 * @param stored - Key text as the provider returns it.
 * @param normalized - Output of {@link normalizeSshPublicKey}.
 * @returns `true` for the same type and material, whatever the comment.
 */
export function sameSshKey(stored: string, normalized: string): boolean {
  try {
    return normalizeSshPublicKey(stored) === normalized;
  } catch {
    return false;
  }
}

/**
 * Stable provider-side name for a key: `roundhouse-` plus 12 hex chars of SHA-256.
 *
 * @param normalized - Output of {@link normalizeSshPublicKey}.
 * @returns The key name.
 */
export async function sshKeyName(normalized: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `roundhouse-${hex.slice(0, 12)}`;
}

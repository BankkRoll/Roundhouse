/**
 * Idempotent upload of an operator's SSH public key.
 *
 * Hetzner identifies keys by MD5 fingerprint, but WebCrypto has no MD5, so
 * keys are matched by their normalised `type base64` text instead and named
 * after a SHA-256 of it.
 *
 * @module
 */
import type { HetznerClient, RequestOptions } from "./client";
import { HetznerApiError, ProvisionError } from "./errors";
import { LABEL_MANAGED } from "./labels";
import type { SshKey } from "./types";

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
 * Stable Hetzner name for a key: `roundhouse-` plus 12 hex chars of SHA-256.
 *
 * @param normalized - Output of {@link normalizeSshPublicKey}.
 * @returns The key name.
 */
export async function sshKeyName(normalized: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `roundhouse-${hex.slice(0, 12)}`;
}

function sameKey(a: SshKey, normalized: string): boolean {
  try {
    return normalizeSshPublicKey(a.public_key) === normalized;
  } catch {
    return false;
  }
}

/**
 * Returns the project's copy of a public key, uploading it if missing. An
 * existing key with the same material is reused whatever its name.
 *
 * @param api - Hetzner client.
 * @param publicKey - OpenSSH public key.
 * @param request - Signal and timeout.
 * @returns The Hetzner SSH key.
 * @throws ProvisionError `invalid_input` for a malformed key.
 */
export async function ensureSshKey(
  api: HetznerClient,
  publicKey: string,
  request: RequestOptions = {},
): Promise<SshKey> {
  const normalized = normalizeSshPublicKey(publicKey);
  const find = async () => (await api.listSshKeys({}, request)).find((k) => sameKey(k, normalized));
  const existing = await find();
  if (existing) return existing;
  try {
    return await api.createSshKey(
      {
        name: await sshKeyName(normalized),
        // Hetzner rejects leading whitespace in keys (changelog 2026-04-22).
        public_key: publicKey.trim(),
        labels: { [LABEL_MANAGED]: "true" },
      },
      request,
    );
  } catch (e) {
    if (!(e instanceof HetznerApiError && e.code === "uniqueness_error")) throw e;
    const raced = await find();
    if (raced) return raced;
    throw e;
  }
}

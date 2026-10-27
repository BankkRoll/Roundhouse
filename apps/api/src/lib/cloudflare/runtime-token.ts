/**
 * The runtime token (ADR 0011 "Runtime Worker"): what a runtime script
 * presents to `RuntimeEnv.resolveEnv` to get its service-environment's
 * resolved variables.
 *
 * Format: `rht1.<service_id>.<environment_id>.<generation>.<mac>`, where
 * `mac` is base64url HMAC-SHA256 over `<service_id>|<environment_id>|<generation>`
 * under a subkey derived from the master key: HKDF-SHA256 with salt
 * `roundhouse/v2/runtime-token` and info `runtime-token`.
 *
 * The token is stateless (derived on demand, never stored) and bound to
 * `cf_runtimes.generation`, which every Cloudflare deploy and every disable
 * bumps, so the previous script's token stops working as soon as the new
 * generation is recorded.
 *
 * SECURITY: verification tries the current master key and then each
 * previous one, so a key rotation does not break running scripts before
 * their next deploy re-mints the token; the comparison is constant-time.
 *
 * @module
 */
import { constantTimeEqual } from "../crypto";
import { type KeyEnv, keyringOf } from "../keyring";

const PREFIX = "rht1";
const PURPOSE = "runtime-token";
const encoder = new TextEncoder();

/** What a valid token names. */
export interface RuntimeTokenClaims {
  serviceId: string;
  environmentId: string;
  generation: number;
}

function base64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function macKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(`roundhouse/v2/${PURPOSE}`),
      info: encoder.encode(PURPOSE),
    },
    ikm,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function mac(raw: Uint8Array<ArrayBuffer>, claims: RuntimeTokenClaims): Promise<string> {
  const key = await macKey(raw);
  const message = `${claims.serviceId}|${claims.environmentId}|${claims.generation}`;
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * Mints the token of one generation under the current master key.
 *
 * @param keys - The keyring bindings.
 * @param claims - Service, environment and generation.
 * @returns The token, for the script's `RH_RUNTIME_TOKEN` secret.
 * @example
 * const token = await mintRuntimeToken(env, { serviceId, environmentId, generation: 3 });
 */
export async function mintRuntimeToken(keys: KeyEnv, claims: RuntimeTokenClaims): Promise<string> {
  const ring = await keyringOf(keys);
  return `${PREFIX}.${claims.serviceId}.${claims.environmentId}.${claims.generation}.${await mac(ring.current.raw, claims)}`;
}

/**
 * Parses and verifies a token's MAC. The caller still checks the
 * generation against `cf_runtimes`.
 *
 * @param keys - The keyring bindings.
 * @param token - Untrusted input.
 * @returns The claims, or `null` when malformed or forged.
 */
export async function verifyRuntimeToken(
  keys: KeyEnv,
  token: unknown,
): Promise<RuntimeTokenClaims | null> {
  if (typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== PREFIX) return null;
  const [, serviceId, environmentId, gen, given] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^[a-z]+_[A-Za-z0-9]+$/.test(serviceId) || !/^[a-z]+_[A-Za-z0-9]+$/.test(environmentId))
    return null;
  if (!/^(0|[1-9][0-9]{0,9})$/.test(gen)) return null;
  const claims = { serviceId, environmentId, generation: Number(gen) };
  const ring = await keyringOf(keys);
  for (const key of [ring.current, ...ring.previous]) {
    if (await constantTimeEqual(given, await mac(key.raw, claims))) return claims;
  }
  return null;
}

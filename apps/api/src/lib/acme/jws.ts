/**
 * Account keys and JSON Web Signatures for ACME (RFC 8555 §6.2, RFC 7515,
 * RFC 7638).
 *
 * - {@link generateAccountKey}: a fresh ES256 account key as a private JWK,
 *   the serialisable form a workflow step stores (sealed) between steps.
 * - {@link importAccountKey}: the private JWK back into a signing key plus
 *   its public JWK.
 * - {@link jwkThumbprint}: the RFC 7638 thumbprint used in key authorizations.
 * - {@link signJws}: a flattened JWS with the ACME protected header.
 *
 * @module
 */

import { base64UrlEncode, toArrayBuffer, utf8 } from "./encoding";

const EC_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The public half of an account key, as sent in a `jwk` protected header. */
export interface PublicJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

/** An imported account key: the signing key and its public JWK. */
export interface AccountSigner {
  /** Non-extractable ECDSA P-256 signing key. */
  privateKey: CryptoKey;
  /** Public JWK with only the RFC 7638 required members. */
  publicJwk: PublicJwk;
}

/**
 * Generates a new ES256 (ECDSA P-256) ACME account key.
 *
 * @returns A private JWK (`kty`, `crv`, `x`, `y`, `d`), safe to serialise and
 * re-import with {@link importAccountKey}. Treat it as a secret.
 */
export async function generateAccountKey(): Promise<JsonWebKey> {
  const pair = (await crypto.subtle.generateKey(EC_P256, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d };
}

/**
 * Imports a private P-256 JWK for signing.
 *
 * @param jwk - A private EC P-256 JWK (must have `d`).
 * @returns The signing key and public JWK.
 * @throws {Error} When the JWK is not a private P-256 key.
 */
export async function importAccountKey(jwk: JsonWebKey): Promise<AccountSigner> {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d) {
    throw new Error("ACME account key must be a private EC P-256 JWK");
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
    EC_P256,
    false,
    ["sign"],
  );
  return { privateKey, publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } };
}

/**
 * The RFC 7638 JWK thumbprint: SHA-256 over the required members in
 * lexicographic order with no whitespace, base64url encoded.
 *
 * @param jwk - An EC or RSA public (or private) JWK.
 * @returns The base64url thumbprint.
 * @example
 * await jwkThumbprint({ kty: "RSA", e: "AQAB", n: "0vx7…" }); // RFC 7638 §3.1
 */
export async function jwkThumbprint(jwk: PublicJwk | JsonWebKey): Promise<string> {
  let canonical: string;
  if (jwk.kty === "EC") {
    canonical = JSON.stringify({ crv: jwk.crv, kty: "EC", x: jwk.x, y: jwk.y });
  } else if (jwk.kty === "RSA") {
    canonical = JSON.stringify({ e: jwk.e, kty: "RSA", n: jwk.n });
  } else {
    throw new Error(`unsupported JWK kty: ${String(jwk.kty)}`);
  }
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(utf8(canonical)));
  return base64UrlEncode(new Uint8Array(digest));
}

/** A flattened JWS (RFC 7515 §7.2.2), the body ACME POSTs carry. */
export interface FlattenedJws {
  protected: string;
  payload: string;
  signature: string;
}

/** The identity half of an ACME protected header. */
export type JwsKeyRef = { jwk: PublicJwk } | { kid: string };

/**
 * Signs an ACME request body.
 *
 * @param signer - The account key.
 * @param keyRef - `{ jwk }` for newAccount (and revocation by key), `{ kid }` after.
 * @param nonce - A fresh `Replay-Nonce`.
 * @param url - The exact request URL (bound into the signature).
 * @param payload - The JSON payload, or `null` for POST-as-GET (empty payload).
 * @returns The flattened JWS.
 */
export async function signJws(
  signer: AccountSigner,
  keyRef: JwsKeyRef,
  nonce: string,
  url: string,
  payload: unknown | null,
): Promise<FlattenedJws> {
  const header = { alg: "ES256", ...keyRef, nonce, url };
  const protectedB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = payload === null ? "" : base64UrlEncode(JSON.stringify(payload));
  // WebCrypto ECDSA yields IEEE P1363 r||s, which is exactly JWS's ES256 format.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signer.privateKey,
    toArrayBuffer(utf8(`${protectedB64}.${payloadB64}`)),
  );
  return {
    protected: protectedB64,
    payload: payloadB64,
    signature: base64UrlEncode(new Uint8Array(signature)),
  };
}

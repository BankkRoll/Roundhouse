/**
 * Certificate keys and PKCS#10 certificate signing requests (RFC 2986), built
 * with WebCrypto and the local DER encoder.
 *
 * - {@link generateCertificateKey}: an ECDSA P-256 key pair for a certificate.
 * - {@link exportPrivateKeyPem}: its PKCS#8 PEM, the form Caddy loads.
 * - {@link createCsr}: a DER CSR carrying every hostname as a SAN.
 * - {@link ecdsaRawToDer} / {@link ecdsaDerToRaw}: signature format conversion
 *   between WebCrypto (IEEE P1363 `r||s`) and X.509 (`ECDSA-Sig-Value`).
 *
 * @module
 */

import {
  DerTag,
  decodeDer,
  derBitString,
  derImplicit,
  derInteger,
  derOctetString,
  derOid,
  derSequence,
  derSet,
  derUtf8String,
  expectTag,
  readUnsignedInteger,
} from "./der";
import { concatBytes, pemDecodeAll, pemEncode, toArrayBuffer, utf8 } from "./encoding";
import { normalizeHostnames } from "./hostnames";

/** Object identifiers used in CSRs and certificates. */
export const Oid = {
  commonName: "2.5.4.3",
  extensionRequest: "1.2.840.113549.1.9.14",
  subjectAltName: "2.5.29.17",
  authorityKeyIdentifier: "2.5.29.35",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
} as const;

const EC_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const P256_COORD_BYTES = 32;

/**
 * Generates an ECDSA P-256 key pair for a certificate.
 *
 * @returns The pair; the private key is extractable so it can be exported
 * with {@link exportPrivateKeyPem} and sealed.
 */
export async function generateCertificateKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(EC_P256, true, ["sign", "verify"])) as CryptoKeyPair;
}

/**
 * Exports a private key as PKCS#8 PEM.
 *
 * @param key - An extractable private key.
 * @returns `-----BEGIN PRIVATE KEY-----` armour with `\n` line endings.
 */
export async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey("pkcs8", key);
  return pemEncode("PRIVATE KEY", new Uint8Array(der as ArrayBuffer));
}

/**
 * Builds a DER PKCS#10 CSR signed with ecdsa-with-SHA256.
 *
 * The subject is `CN=<first hostname>` (omitted when longer than the 64
 * characters X.520 allows, which CAs accept since they read only the SANs),
 * and every hostname goes into a subjectAltName extension request.
 *
 * @param keys - The certificate key pair (P-256).
 * @param hostnames - The names to certify; wildcards allowed.
 * @returns The DER-encoded CSR.
 */
export async function createCsr(keys: CryptoKeyPair, hostnames: string[]): Promise<Uint8Array> {
  const names = normalizeHostnames(hostnames);
  const first = names[0] as string;
  const subject =
    first.length <= 64
      ? derSequence(derSet(derSequence(derOid(Oid.commonName), derUtf8String(first))))
      : derSequence();
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer,
  );
  const generalNames = derSequence(...names.map((n) => derImplicit(2, utf8(n))));
  const extensions = derSequence(
    derSequence(derOid(Oid.subjectAltName), derOctetString(generalNames)),
  );
  const attributes = derImplicit(
    0,
    derSequence(derOid(Oid.extensionRequest), derSet(extensions)),
    true,
  );
  const info = derSequence(derInteger(0), subject, spki, attributes);
  const raw = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    toArrayBuffer(info),
  );
  return derSequence(
    info,
    derSequence(derOid(Oid.ecdsaWithSha256)),
    derBitString(ecdsaRawToDer(new Uint8Array(raw))),
  );
}

/**
 * Converts a WebCrypto ECDSA signature (`r||s`) to a DER `ECDSA-Sig-Value`.
 *
 * @param raw - The fixed-width `r||s` signature.
 * @returns `SEQUENCE { INTEGER r, INTEGER s }`.
 */
export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  if (raw.length === 0 || raw.length % 2 !== 0) throw new Error("invalid raw ECDSA signature");
  const half = raw.length / 2;
  return derSequence(derInteger(raw.subarray(0, half)), derInteger(raw.subarray(half)));
}

/**
 * Converts a DER `ECDSA-Sig-Value` to WebCrypto's fixed-width `r||s`.
 *
 * @param der - `SEQUENCE { INTEGER r, INTEGER s }`.
 * @param coordinateBytes - Width of each half (32 for P-256).
 * @returns The `r||s` signature.
 */
export function ecdsaDerToRaw(der: Uint8Array, coordinateBytes = P256_COORD_BYTES): Uint8Array {
  const seq = expectTag(decodeDer(der), DerTag.SEQUENCE, "ECDSA-Sig-Value");
  if (seq.children.length !== 2) throw new Error("invalid ECDSA-Sig-Value");
  const parts = seq.children.map((child) => {
    const bytes = readUnsignedInteger(child);
    if (bytes.length > coordinateBytes) throw new Error("ECDSA integer too large");
    return concatBytes(new Uint8Array(coordinateBytes - bytes.length), bytes);
  });
  return concatBytes(...parts);
}

/**
 * Imports a PKCS#8 PEM P-256 private key (from {@link exportPrivateKeyPem})
 * with its public half, so a stored key can sign a CSR again.
 *
 * @param pem - `-----BEGIN PRIVATE KEY-----` armour.
 * @returns The key pair.
 * @throws {Error} When the PEM holds no P-256 private key.
 */
export async function importCertificateKeyPem(pem: string): Promise<CryptoKeyPair> {
  const [der] = pemDecodeAll(pem, "PRIVATE KEY");
  if (!der) throw new Error("no PRIVATE KEY block");
  const privateKey = await crypto.subtle.importKey("pkcs8", toArrayBuffer(der), EC_P256, true, [
    "sign",
  ]);
  const {
    d: _d,
    key_ops: _ops,
    ...publicJwk
  } = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, EC_P256, true, ["verify"]);
  return { privateKey, publicKey };
}

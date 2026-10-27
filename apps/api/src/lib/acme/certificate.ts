/**
 * Reading issued certificates: PEM chain splitting, the leaf's validity,
 * serial, issuer, SANs and authority key identifier, the RFC 9773 ARI
 * certificate identifier, and the renew-after computation.
 *
 * @module
 */

import { Oid } from "./csr";
import {
  type DerNode,
  DerTag,
  decodeDer,
  expectTag,
  readOid,
  readString,
  readTime,
  readUnsignedInteger,
} from "./der";
import {
  base64UrlEncode,
  fromHex,
  pemDecodeAll,
  pemEncode,
  toArrayBuffer,
  toHex,
  utf8,
} from "./encoding";

/** What the control plane needs to know about an issued leaf certificate. */
export interface CertificateInfo {
  /** Start of validity, ms since the epoch. */
  notBefore: number;
  /** End of validity, ms since the epoch. */
  notAfter: number;
  /** Serial number as lowercase hex, without DER sign padding. */
  serialHex: string;
  /** Issuer distinguished name in RFC 4514 order, e.g. `CN=R11,O=Let's Encrypt,C=US`. */
  issuer: string;
  /** dNSName (and iPAddress, as text) subjectAltName entries, in order. */
  subjectAltNames: string[];
  /** The authority key identifier's keyIdentifier as lowercase hex, if present. */
  authorityKeyId: string | null;
}

const ATTRIBUTE_NAMES: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "0.9.2342.19200300.100.1.25": "DC",
};

/**
 * Splits a PEM chain into canonical certificate blocks (64-column base64,
 * `\n` endings), dropping anything between blocks.
 *
 * @param pem - One or more `CERTIFICATE` PEM blocks.
 * @returns Each block, ending in a single `\n`, in input order.
 */
export function splitPemChain(pem: string): string[] {
  return pemDecodeAll(pem, "CERTIFICATE").map((der) => pemEncode("CERTIFICATE", der));
}

/**
 * Parses the first (leaf) certificate of a PEM chain.
 *
 * @param pem - A PEM chain, leaf first.
 * @returns The leaf's details.
 * @throws {Error} When there is no certificate or it is malformed.
 */
export function parseCertificateChain(pem: string): CertificateInfo {
  const [leaf] = pemDecodeAll(pem, "CERTIFICATE");
  if (!leaf) throw new Error("no certificate in PEM chain");
  return parseCertificateDer(leaf);
}

/**
 * Parses one DER X.509 certificate.
 *
 * @param der - The certificate's DER encoding.
 * @returns Its details.
 */
export function parseCertificateDer(der: Uint8Array): CertificateInfo {
  const cert = expectTag(decodeDer(der), DerTag.SEQUENCE, "Certificate");
  const tbs = expectTag(cert.children[0], DerTag.SEQUENCE, "TBSCertificate");
  const fields = [...tbs.children];
  if (fields[0]?.tag === 0xa0) fields.shift();
  const [serial, , issuer, validity, , , ...rest] = fields;
  const validityNode = expectTag(validity, DerTag.SEQUENCE, "Validity");
  const [notBefore, notAfter] = validityNode.children;
  if (!notBefore || !notAfter) throw new Error("DER: malformed Validity");

  let subjectAltNames: string[] = [];
  let authorityKeyId: string | null = null;
  const extensions = rest.find((node) => node.tag === 0xa3);
  if (extensions) {
    const list = expectTag(extensions.children[0], DerTag.SEQUENCE, "Extensions");
    for (const ext of list.children) {
      const extnId = readOid(expectTag(ext.children[0], DerTag.OID, "extnID"));
      const extnValue = expectTag(ext.children.at(-1), DerTag.OCTET_STRING, "extnValue");
      if (extnId === Oid.subjectAltName) subjectAltNames = readGeneralNames(extnValue.value);
      if (extnId === Oid.authorityKeyIdentifier)
        authorityKeyId = readKeyIdentifier(extnValue.value);
    }
  }

  return {
    notBefore: readTime(notBefore),
    notAfter: readTime(notAfter),
    serialHex: toHex(readUnsignedInteger(expectTag(serial, DerTag.INTEGER, "serialNumber"))),
    issuer: formatName(expectTag(issuer, DerTag.SEQUENCE, "issuer")),
    subjectAltNames,
    authorityKeyId,
  };
}

function readGeneralNames(bytes: Uint8Array): string[] {
  const names = expectTag(decodeDer(bytes), DerTag.SEQUENCE, "GeneralNames");
  const out: string[] = [];
  for (const name of names.children) {
    if (name.tag === 0x82) out.push(String.fromCharCode(...name.value));
    if (name.tag === 0x87) out.push(formatIp(name.value));
  }
  return out;
}

function formatIp(bytes: Uint8Array): string {
  if (bytes.length === 4) return [...bytes].join(".");
  const groups: string[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  }
  return groups.join(":");
}

function readKeyIdentifier(bytes: Uint8Array): string | null {
  const aki = expectTag(decodeDer(bytes), DerTag.SEQUENCE, "AuthorityKeyIdentifier");
  const keyId = aki.children.find((child) => child.tag === 0x80);
  return keyId ? toHex(keyId.value) : null;
}

function formatName(name: DerNode): string {
  const parts: string[] = [];
  for (const rdn of name.children) {
    const attrs = rdn.children.map((atv) => {
      const oid = readOid(expectTag(atv.children[0], DerTag.OID, "AttributeType"));
      const value = atv.children[1];
      let text: string;
      try {
        text = value ? readString(value) : "";
      } catch {
        text = `#${toHex(value?.raw ?? new Uint8Array())}`;
      }
      return `${ATTRIBUTE_NAMES[oid] ?? oid}=${escapeRdnValue(text)}`;
    });
    parts.push(attrs.join("+"));
  }
  return parts.reverse().join(",");
}

function escapeRdnValue(value: string): string {
  return value
    .replace(/[\\,+"<>;=]/g, "\\$&")
    .replace(/^[ #]/, "\\$&")
    .replace(/ $/, "\\ ");
}

/**
 * The RFC 9773 ARI certificate identifier:
 * `base64url(AKI keyIdentifier) "." base64url(serial DER content octets)`.
 *
 * @param leaf - The parsed leaf certificate.
 * @returns The identifier, or `null` when the certificate has no AKI keyIdentifier.
 * @example
 * // RFC 9773 §4.1: AKI 69:88:5B:6B:..., serial 0x87654321
 * ariCertId(leaf); // "aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE"
 */
export function ariCertId(
  leaf: Pick<CertificateInfo, "authorityKeyId" | "serialHex">,
): string | null {
  if (!leaf.authorityKeyId) return null;
  let serial = fromHex(leaf.serialHex.length % 2 ? `0${leaf.serialHex}` : leaf.serialHex);
  // The identifier uses the DER content octets, which carry a 0x00 sign byte
  // whenever the magnitude's top bit is set; serialHex has it stripped.
  if ((serial[0] ?? 0) & 0x80) serial = Uint8Array.of(0, ...serial);
  return `${base64UrlEncode(fromHex(leaf.authorityKeyId))}.${base64UrlEncode(serial)}`;
}

/**
 * Lowercase hex SHA-256 of UTF-8 text.
 *
 * @param text - The input, e.g. a normalised PEM chain.
 * @returns 64 hex characters.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(utf8(text)));
  return toHex(new Uint8Array(digest));
}

/**
 * When to renew a certificate, as a ms timestamp.
 *
 * With a valid ARI window (`end > start`) the result is a uniformly random
 * point inside it, as RFC 9773 §4.2 asks so that renewals spread out. Without
 * one it is the point where a third of the certificate's actual lifetime
 * remains, so 45-, 64- and 90-day certificates are all handled without
 * assuming a lifetime.
 *
 * @param leaf - The certificate's validity.
 * @param ari - The ARI suggested window, or `null`.
 * @param random - A `[0, 1)` source, injectable for tests.
 * @returns The renew-after timestamp in ms (an integer).
 * @example
 * computeRenewAfter({ notBefore: 0, notAfter: 90 * DAY }, null); // 60 * DAY
 */
export function computeRenewAfter(
  leaf: { notBefore: number; notAfter: number },
  ari: { start: number; end: number } | null,
  random: () => number = Math.random,
): number {
  if (ari && Number.isFinite(ari.start) && Number.isFinite(ari.end) && ari.end > ari.start) {
    return Math.floor(ari.start + random() * (ari.end - ari.start));
  }
  return Math.floor(leaf.notAfter - (leaf.notAfter - leaf.notBefore) / 3);
}

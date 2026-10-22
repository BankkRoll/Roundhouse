/**
 * Ed25519 envelopes that authenticate control → agent frames, plus the base64
 * helpers both sides use for keys and signatures.
 *
 * @module
 */
import { z } from "zod";
import { type ControlMessage, ControlMessageSchema } from "./messages";

/**
 * Signed wrapper for control → agent frames.
 *
 * The payload travels as a JSON *string* and the signature covers its exact
 * UTF-8 bytes, so neither side needs canonical JSON: the Go agent verifies
 * the bytes it received, then parses them.
 */
export const EnvelopeSchema = z.object({
  v: z.literal(1),
  /** Key ID, so the control plane can rotate signing keys. */
  kid: z.string(),
  payload: z.string(),
  /** Ed25519 signature over `payload`, base64. */
  sig: z.string(),
});

/** Signed wrapper for control → agent frames. */
export type Envelope = z.infer<typeof EnvelopeSchema>;

const ED25519 = { name: "Ed25519" } as const;
const ED25519_SIGNATURE_BYTES = 64;
const encoder = new TextEncoder();

/**
 * Encodes bytes as standard base64.
 *
 * @param bytes - Raw bytes.
 * @returns Padded base64 string.
 */
export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Decodes standard base64.
 *
 * @param value - Base64 string.
 * @returns Decoded bytes.
 */
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A control-plane signing keypair in portable form. */
export interface ExportedSigningKey {
  /** PKCS#8 private key, base64. Must be stored encrypted. */
  privateKey: string;
  /** Raw 32-byte public key, base64. Handed to agents at join. */
  publicKey: string;
}

/**
 * Generates a new Ed25519 signing keypair.
 *
 * @returns The keypair exported as base64 strings.
 */
export async function generateSigningKey(): Promise<ExportedSigningKey> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const [pkcs8, raw] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", pair.privateKey) as Promise<ArrayBuffer>,
    crypto.subtle.exportKey("raw", pair.publicKey) as Promise<ArrayBuffer>,
  ]);
  return { privateKey: toBase64(pkcs8), publicKey: toBase64(raw) };
}

/**
 * Imports a PKCS#8 private key for signing.
 *
 * @param pkcs8 - Base64 PKCS#8 bytes from {@link generateSigningKey}.
 * @returns A non-extractable signing key.
 */
export function importSigningKey(pkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", fromBase64(pkcs8), ED25519, false, ["sign"]);
}

/**
 * Serialises and signs a control message.
 *
 * @param message - Payload to send.
 * @param key - Private key from {@link importSigningKey}.
 * @param kid - Identifier of `key`.
 * @returns An envelope ready to `JSON.stringify` onto the socket.
 * @example
 * const env = await signEnvelope(welcome, key, "k1");
 * ws.send(JSON.stringify(env));
 */
export async function signEnvelope(
  message: ControlMessage,
  key: CryptoKey,
  kid: string,
): Promise<Envelope> {
  const payload = JSON.stringify(message);
  const sig = await crypto.subtle.sign(ED25519, key, encoder.encode(payload));
  return { v: 1, kid, payload, sig: toBase64(sig) };
}

/** Why an envelope was rejected. */
export type EnvelopeRejection = "bad_signature" | "malformed" | "expired" | "wrong_node";

/**
 * Verifies an envelope exactly as the Go agent does. Production verification
 * happens in the agent; this mirror exists for tests and fake agents.
 *
 * @param envelope - Envelope received off the wire.
 * @param publicKey - Raw control-plane public key, base64.
 * @param nodeId - The verifying node's ID.
 * @param now - Current time, unix ms.
 * @returns The parsed message, or why it was rejected.
 */
export async function verifyEnvelope(
  envelope: Envelope,
  publicKey: string,
  nodeId: string,
  now = Date.now(),
): Promise<{ ok: true; message: ControlMessage } | { ok: false; reason: EnvelopeRejection }> {
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = fromBase64(envelope.sig);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (sig.byteLength !== ED25519_SIGNATURE_BYTES) return { ok: false, reason: "bad_signature" };

  const key = await crypto.subtle.importKey("raw", fromBase64(publicKey), ED25519, false, [
    "verify",
  ]);
  const valid = await crypto.subtle.verify(ED25519, key, sig, encoder.encode(envelope.payload));
  if (!valid) return { ok: false, reason: "bad_signature" };

  let raw: unknown;
  try {
    raw = JSON.parse(envelope.payload);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = ControlMessageSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (parsed.data.node_id !== nodeId) return { ok: false, reason: "wrong_node" };
  if (parsed.data.exp < now) return { ok: false, reason: "expired" };
  return { ok: true, message: parsed.data };
}

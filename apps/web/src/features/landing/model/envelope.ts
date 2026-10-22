/**
 * Signed-envelope demo for the security section. It uses the real protocol fixture (a
 * desired-state message signed by the TypeScript control plane and verified by the Go
 * agent's tests) and verifies it with WebCrypto in the visitor's browser, the same way
 * the agent does: check the signature over the exact payload bytes, and only then parse.
 *
 * @module
 */

/** Signed wrapper for control → agent frames (see ADR 0002). */
export interface DemoEnvelope {
  v: 1;
  kid: string;
  payload: string;
  sig: string;
}

/**
 * Copy of `packages/protocol/fixtures/signed-envelope.json`. Duplicated rather than
 * imported so the dashboard does not depend on the protocol package for a demo.
 */
export const ENVELOPE_FIXTURE = {
  publicKey: "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
  nodeId: "node_fixture",
  envelope: {
    v: 1,
    kid: "fixture",
    payload:
      '{"type":"desired_state","id":"msg_fixture","node_id":"node_fixture","iat":1700000000000,"exp":4102444800000,"generation":7,"workloads":[{"id":"wl_1","image":"nginx:1.27"}]}',
    sig: "3spSQ/xAX9k4JGfXlRkZfU+gVYFGXW7qk4dI4ji7xMxLrlXCp3tDLwXxHmUciSJvoiLPvPOOEubHo3c0fyFQCQ==",
  } satisfies DemoEnvelope,
} as const;

/** What an attacker on the wire swaps the image for in the demo. */
export const TAMPERED_IMAGE = "xmrig/xmrig:latest";

/**
 * Returns the fixture envelope, optionally with its payload altered in transit. The
 * signature is left untouched, as it would be by anyone without the signing key.
 *
 * @param tampered - Whether to swap the workload image.
 * @returns The envelope the agent receives.
 */
export function demoEnvelope(tampered: boolean): DemoEnvelope {
  const { envelope } = ENVELOPE_FIXTURE;
  if (!tampered) return envelope;
  return { ...envelope, payload: envelope.payload.replace("nginx:1.27", TAMPERED_IMAGE) };
}

/** Outcome of verifying an envelope. */
export type VerifyResult =
  | { ok: true; generation: number; image: string }
  | { ok: false; reason: "bad_signature" | "malformed" | "wrong_node" | "expired" };

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Checks an envelope signature with WebCrypto Ed25519.
 *
 * @param envelope - Envelope as received.
 * @param publicKey - Raw control-plane public key, base64.
 * @returns `true` when the signature covers the exact payload bytes.
 * @throws When the runtime does not support Ed25519 in WebCrypto.
 */
export async function verifySignature(envelope: DemoEnvelope, publicKey: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    fromBase64(envelope.sig),
    new TextEncoder().encode(envelope.payload),
  );
}

/**
 * Verifies and then parses an envelope, in the agent's order: signature first, so a forged
 * payload is never handed to the JSON parser.
 *
 * @param envelope - Envelope as received.
 * @param options - Key, verifying node and current time. `verify` is injectable for
 *   runtimes without Ed25519.
 * @returns The accepted message summary, or why it was rejected.
 */
export async function verifyEnvelope(
  envelope: DemoEnvelope,
  options: {
    publicKey: string;
    nodeId: string;
    now: number;
    verify?: (envelope: DemoEnvelope, publicKey: string) => Promise<boolean>;
  },
): Promise<VerifyResult> {
  const verify = options.verify ?? verifySignature;
  if (!(await verify(envelope, options.publicKey))) return { ok: false, reason: "bad_signature" };
  let message: unknown;
  try {
    message = JSON.parse(envelope.payload);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = message as {
    node_id?: unknown;
    exp?: unknown;
    generation?: unknown;
    workloads?: { image?: unknown }[];
  };
  if (parsed.node_id !== options.nodeId) return { ok: false, reason: "wrong_node" };
  if (typeof parsed.exp !== "number" || parsed.exp < options.now) {
    return { ok: false, reason: "expired" };
  }
  return {
    ok: true,
    generation: typeof parsed.generation === "number" ? parsed.generation : 0,
    image: String(parsed.workloads?.[0]?.image ?? ""),
  };
}

/**
 * Offline stand-in for {@link verifySignature} when WebCrypto lacks Ed25519: the
 * fixture's signature is known to be valid for exactly the original payload.
 *
 * @param envelope - Envelope as received.
 * @returns `true` only for the untouched fixture.
 */
export async function fixtureVerify(envelope: DemoEnvelope): Promise<boolean> {
  const original = ENVELOPE_FIXTURE.envelope;
  return envelope.payload === original.payload && envelope.sig === original.sig;
}

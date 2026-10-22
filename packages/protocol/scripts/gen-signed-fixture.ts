/**
 * Writes `fixtures/signed-envelope.json`: an envelope signed in TypeScript
 * that the Go agent's tests must verify. Proves both sides agree on the
 * signing scheme byte-for-byte.
 *
 * The key comes from a fixed seed, so regenerating produces identical output
 * unless the message or scheme changes.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ControlMessage, importSigningKey, signEnvelope, toBase64 } from "../src/index";

// NOTE: PKCS#8 wrapping for a raw Ed25519 seed is a fixed 16-byte DER prefix.
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";
// RFC 8032 section 7.1 test vector 1: public and test-only.
const SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

const pkcs8 = Uint8Array.from(Buffer.from(PKCS8_ED25519_PREFIX + SEED_HEX, "hex"));
const key = await importSigningKey(toBase64(pkcs8));

const exportable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, [
  "sign",
]);
const jwk = await crypto.subtle.exportKey("jwk", exportable);
const publicKey = Buffer.from(jwk.x!, "base64url").toString("base64");

const message: ControlMessage = {
  type: "desired_state",
  id: "msg_fixture",
  node_id: "node_fixture",
  iat: 1_700_000_000_000,
  // Year 2100, so the fixture never expires during tests.
  exp: 4_102_444_800_000,
  generation: 7,
  workloads: [{ id: "wl_1", image: "nginx:1.27" }],
};

const envelope = await signEnvelope(message, key, "fixture");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "signed-envelope.json");
writeFileSync(
  out,
  `${JSON.stringify({ public_key: publicKey, node_id: message.node_id, envelope }, null, 2)}\n`,
);
console.log(`wrote ${out}`);

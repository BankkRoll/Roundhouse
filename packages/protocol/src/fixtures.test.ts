import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentMessageSchema,
  type ControlMessage,
  EnvelopeSchema,
  generateSigningKey,
  importSigningKey,
  JoinRequestSchema,
  JoinResponseSchema,
  signEnvelope,
  verifyEnvelope,
} from "./index";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8"));

describe("shared fixtures", () => {
  // The Go agent decodes these same files with DisallowUnknownFields; if either
  // side drifts, one of the two test suites fails.
  it.each([
    ["hello.json", AgentMessageSchema],
    ["heartbeat.json", AgentMessageSchema],
    ["join-request.json", JoinRequestSchema],
    ["join-response.json", JoinResponseSchema],
  ] as const)("%s matches its schema", (file, schema) => {
    expect(() => schema.parse(fixture(file))).not.toThrow();
  });

  it("verifies the checked-in signed envelope", async () => {
    const f = fixture("signed-envelope.json") as {
      public_key: string;
      node_id: string;
      envelope: unknown;
    };
    const result = await verifyEnvelope(EnvelopeSchema.parse(f.envelope), f.public_key, f.node_id);
    expect(result.ok).toBe(true);
  });
});

describe("envelopes", () => {
  const message = (overrides: Partial<ControlMessage> = {}): ControlMessage =>
    ({
      type: "welcome",
      id: "m1",
      node_id: "node_a",
      iat: 1000,
      exp: 2000,
      heartbeat_interval_ms: 10_000,
      ...overrides,
    }) as ControlMessage;

  async function setup() {
    const keys = await generateSigningKey();
    return { keys, key: await importSigningKey(keys.privateKey) };
  }

  it("round-trips", async () => {
    const { keys, key } = await setup();
    const env = await signEnvelope(message(), key, "k1");
    const result = await verifyEnvelope(env, keys.publicKey, "node_a", 1500);
    expect(result).toEqual({ ok: true, message: message() });
  });

  it("rejects tampered payloads", async () => {
    const { keys, key } = await setup();
    const env = await signEnvelope(message(), key, "k1");
    const tampered = { ...env, payload: env.payload.replace("10000", "1") };
    expect(await verifyEnvelope(tampered, keys.publicKey, "node_a", 1500)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it.each([
    ["malformed base64", "not base64!"],
    ["a truncated signature", btoa("x".repeat(63))],
    ["an overlong signature", btoa("x".repeat(65))],
  ])("rejects %s as bad_signature", async (_name, sig) => {
    const { keys, key } = await setup();
    const env = await signEnvelope(message(), key, "k1");
    expect(await verifyEnvelope({ ...env, sig }, keys.publicKey, "node_a", 1500)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects messages for another node", async () => {
    const { keys, key } = await setup();
    const env = await signEnvelope(message(), key, "k1");
    expect(await verifyEnvelope(env, keys.publicKey, "node_b", 1500)).toEqual({
      ok: false,
      reason: "wrong_node",
    });
  });

  it("rejects expired messages", async () => {
    const { keys, key } = await setup();
    const env = await signEnvelope(message(), key, "k1");
    expect(await verifyEnvelope(env, keys.publicKey, "node_a", 2001)).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentMessageSchema,
  type ControlMessage,
  computeSpecHash,
  EnvelopeSchema,
  environmentNetworkName,
  generateSigningKey,
  importSigningKey,
  JoinRequestSchema,
  JoinResponseSchema,
  signEnvelope,
  specHashInput,
  verifyEnvelope,
  WorkloadSpecSchema,
} from "./index";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8"));

describe("shared fixtures", () => {
  // The Go agent decodes these same files with DisallowUnknownFields; if either
  // side drifts, one of the two test suites fails.
  it.each([
    ["hello.json", AgentMessageSchema],
    ["heartbeat.json", AgentMessageSchema],
    ["hello-statuses.json", AgentMessageSchema],
    ["workload-status.json", AgentMessageSchema],
    ["logs-runtime.json", AgentMessageSchema],
    ["logs-build.json", AgentMessageSchema],
    ["build-result-ok.json", AgentMessageSchema],
    ["build-result-failed.json", AgentMessageSchema],
    ["build-result-cancelled.json", AgentMessageSchema],
    ["join-request.json", JoinRequestSchema],
    ["join-response.json", JoinResponseSchema],
  ] as const)("%s matches its schema", (file, schema) => {
    expect(() => schema.parse(fixture(file))).not.toThrow();
  });

  it.each([
    ["signed-envelope.json", "desired_state"],
    ["signed-desired-state.json", "desired_state"],
    ["signed-build-job.json", "build_job"],
    ["signed-build-cancel.json", "build_cancel"],
  ])("verifies the checked-in %s", async (file, type) => {
    const f = fixture(file) as SignedFixture;
    const result = await verifyEnvelope(
      EnvelopeSchema.parse(f.envelope),
      f.public_key,
      f.node_id,
      FIXTURE_IAT,
    );
    expect(result).toMatchObject({ ok: true, message: { type } });
  });

  it("signs workloads whose spec_hash matches their content", async () => {
    const f = fixture("signed-desired-state.json") as SignedFixture;
    const payload = JSON.parse(f.envelope.payload) as { workloads: unknown[] };
    expect(payload.workloads.length).toBeGreaterThan(0);
    for (const raw of payload.workloads) {
      const spec = WorkloadSpecSchema.parse(raw);
      expect(await computeSpecHash(spec)).toBe(spec.spec_hash);
    }
  });

  it("keeps every workload readable by a protocol v1 agent", () => {
    // Phase 0 agents decode each workload as { id, image } and ignore the rest.
    const v1Workload = z.object({ id: z.string(), image: z.string() });
    const f = fixture("signed-desired-state.json") as SignedFixture;
    const payload = JSON.parse(f.envelope.payload) as { workloads: unknown[] };
    for (const raw of payload.workloads) expect(() => v1Workload.parse(raw)).not.toThrow();
  });

  it("reproduces every environment network name", async () => {
    const { cases } = fixture("network-names.json") as {
      cases: { project_id: string; environment_id: string; network: string }[];
    };
    expect(cases.some((c) => c.network.startsWith("roundhouse-env-"))).toBe(true);
    for (const c of cases) {
      expect(await environmentNetworkName(c.project_id, c.environment_id)).toBe(c.network);
    }
  });

  it("puts every signed service workload on its environment network", async () => {
    const f = fixture("signed-desired-state.json") as SignedFixture;
    const payload = JSON.parse(f.envelope.payload) as { workloads: unknown[] };
    for (const raw of payload.workloads) {
      const w = WorkloadSpecSchema.parse(raw);
      expect(w.network).toBe(await environmentNetworkName(w.project_id!, w.environment_id!));
    }
  });

  it("reproduces every spec-hash case", async () => {
    const { cases } = fixture("spec-hash.json") as {
      cases: { name: string; spec: unknown; canonical: string; spec_hash: string }[];
    };
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const c of cases) {
      const spec = WorkloadSpecSchema.parse(c.spec);
      expect(specHashInput(spec), c.name).toBe(c.canonical);
      expect(await computeSpecHash(spec), c.name).toBe(c.spec_hash);
    }
  });
});

interface SignedFixture {
  public_key: string;
  node_id: string;
  envelope: { payload: string };
}

// Credential-bearing fixtures expire 60 s after this, so verification pins the clock to it.
const FIXTURE_IAT = 1_700_000_000_000;

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

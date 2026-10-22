import { describe, expect, it } from "vitest";
import {
  demoEnvelope,
  ENVELOPE_FIXTURE,
  fixtureVerify,
  TAMPERED_IMAGE,
  verifyEnvelope,
  verifySignature,
} from "./envelope";

const OPTIONS = {
  publicKey: ENVELOPE_FIXTURE.publicKey,
  nodeId: ENVELOPE_FIXTURE.nodeId,
  now: Date.UTC(2026, 9, 22),
};

describe("demoEnvelope", () => {
  it("returns the fixture untouched by default", () => {
    expect(demoEnvelope(false)).toBe(ENVELOPE_FIXTURE.envelope);
  });

  it("swaps the image but keeps the original signature when tampered", () => {
    const tampered = demoEnvelope(true);
    expect(tampered.payload).toContain(TAMPERED_IMAGE);
    expect(tampered.sig).toBe(ENVELOPE_FIXTURE.envelope.sig);
  });
});

describe("verifySignature (real Ed25519)", () => {
  it("accepts the fixture and rejects a tampered payload", async () => {
    await expect(verifySignature(demoEnvelope(false), OPTIONS.publicKey)).resolves.toBe(true);
    await expect(verifySignature(demoEnvelope(true), OPTIONS.publicKey)).resolves.toBe(false);
  });
});

describe("verifyEnvelope", () => {
  it("accepts the fixture and reports what it would run", async () => {
    await expect(verifyEnvelope(demoEnvelope(false), OPTIONS)).resolves.toEqual({
      ok: true,
      generation: 7,
      image: "nginx:1.27",
    });
  });

  it("rejects a tampered envelope before parsing it", async () => {
    await expect(verifyEnvelope(demoEnvelope(true), OPTIONS)).resolves.toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects messages for another node, past expiry, or unparseable", async () => {
    const verify = async () => true;
    await expect(
      verifyEnvelope(demoEnvelope(false), { ...OPTIONS, nodeId: "node_other", verify }),
    ).resolves.toEqual({ ok: false, reason: "wrong_node" });
    await expect(
      verifyEnvelope(demoEnvelope(false), { ...OPTIONS, now: 5_000_000_000_000, verify }),
    ).resolves.toEqual({ ok: false, reason: "expired" });
    await expect(
      verifyEnvelope({ ...demoEnvelope(false), payload: "{" }, { ...OPTIONS, verify }),
    ).resolves.toEqual({ ok: false, reason: "malformed" });
  });

  it("agrees with real verification when using the fixture fallback", async () => {
    const options = { ...OPTIONS, verify: fixtureVerify };
    await expect(verifyEnvelope(demoEnvelope(false), options)).resolves.toMatchObject({ ok: true });
    await expect(verifyEnvelope(demoEnvelope(true), options)).resolves.toMatchObject({ ok: false });
  });
});

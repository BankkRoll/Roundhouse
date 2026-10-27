import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentFrameSchema,
  ControlMessageSchema,
  CREDENTIAL_FRAME_TTL_MS,
  carriesCredentials,
  DEFAULT_EXEC_COMMAND,
  EXEC_PROTOCOL_VERSION,
  ExecExitSchema,
  ExecInputSchema,
  ExecOpenSchema,
  ExecOutputSchema,
  execInputAad,
  IMAGE_PUSH_PROTOCOL_VERSION,
  ImagePushResultSchema,
  ImagePushSchema,
  imagePushAad,
  isValidExecCommand,
  MAX_EXEC_ARGS,
  MAX_EXEC_COMMAND_BYTES,
  MAX_EXEC_OUTPUT_BYTES,
  openBox,
  PROTOCOL_VERSION,
  SealedExecInputSchema,
  SealedImagePushCredentialSchema,
} from "./index";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8"));

// biome-ignore lint/suspicious/noExplicitAny: fixture payloads are checked by the schema first.
const payload = (name: string): any => {
  const f = fixture(name) as { envelope: { payload: string } };
  return ControlMessageSchema.parse(JSON.parse(f.envelope.payload));
};

const IAT = 1_700_000_000_000;
const longLived = { exp: IAT + CREDENTIAL_FRAME_TTL_MS + 1 };

const nodeKey = () => {
  const box = fixture("sealed-box.json") as { node_id: string; node_private_key_hex: string };
  return { node: box.node_id, key: Uint8Array.from(Buffer.from(box.node_private_key_hex, "hex")) };
};

describe("Phase 4 version gates", () => {
  it("puts the web shell and image push at 7", () => {
    expect(EXEC_PROTOCOL_VERSION).toBe(7);
    expect(IMAGE_PUSH_PROTOCOL_VERSION).toBe(7);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(7);
  });
});

describe("exec frames (ADR 0012, ADR 0014 §15)", () => {
  it("gives every exec frame and image push the credential TTL", () => {
    for (const name of [
      "signed-exec-open.json",
      "signed-exec-input.json",
      "signed-exec-resize.json",
      "signed-exec-close.json",
      "signed-image-push.json",
    ]) {
      const m = payload(name);
      expect(carriesCredentials(m), name).toBe(true);
      expect(ControlMessageSchema.safeParse({ ...m, ...longLived }).success, name).toBe(false);
    }
  });

  it("bounds command as an argv array", () => {
    expect(isValidExecCommand(DEFAULT_EXEC_COMMAND)).toBe(true);
    expect(isValidExecCommand([])).toBe(false);
    expect(isValidExecCommand([""])).toBe(false);
    expect(isValidExecCommand(["ls", "a\0b"])).toBe(false);
    expect(isValidExecCommand(Array(MAX_EXEC_ARGS).fill("x"))).toBe(true);
    expect(isValidExecCommand(Array(MAX_EXEC_ARGS + 1).fill("x"))).toBe(false);
    expect(isValidExecCommand(["x".repeat(MAX_EXEC_COMMAND_BYTES)])).toBe(true);
    expect(isValidExecCommand(["x".repeat(MAX_EXEC_COMMAND_BYTES - 1), "é"])).toBe(false);
  });

  it("validates exec_open", () => {
    const m = payload("signed-exec-open.json");
    const ok = (x: unknown) => ExecOpenSchema.safeParse(x).success;
    expect(ok(m)).toBe(true);
    expect(ok({ ...m, command: "sh -c ls" })).toBe(false);
    expect(ok({ ...m, tty: false })).toBe(false);
    expect(ok({ ...m, cols: 0 })).toBe(false);
    expect(ok({ ...m, rows: 501 })).toBe(false);
    expect(ok({ ...m, env: { LD_PRELOAD: "/x.so" } })).toBe(false);
    expect(ok({ ...m, env: { PATH: "/tmp" } })).toBe(false);
    expect(ok({ ...m, env: {} })).toBe(true);
    expect(ok({ ...m, idle_timeout_s: 9 })).toBe(false);
    expect(ok({ ...m, max_duration_s: 28_801 })).toBe(false);
    // There is no user override: the container's own user always applies.
    expect(ExecOpenSchema.parse({ ...m, user: "root" })).not.toHaveProperty("user");
  });

  it("seals input under the session and sequence", async () => {
    const { node, key } = nodeKey();
    const m = ExecInputSchema.parse(payload("signed-exec-input.json"));
    const plain = SealedExecInputSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          await openBox(key, m.data_sealed, "exec-input", execInputAad(node, m.session_id, m.seq)),
        ),
      ),
    );
    expect(Buffer.from(plain.data, "base64").toString()).toBe("echo $RH_TEST\r");
    await expect(
      openBox(key, m.data_sealed, "exec-input", execInputAad(node, m.session_id, m.seq + 1)),
    ).rejects.toThrow();
  });

  it("validates agent exec frames", () => {
    const out = fixture("exec-output.json") as Record<string, unknown>;
    expect(ExecOutputSchema.safeParse({ ...out, data: "not base64!" }).success).toBe(false);
    expect(ExecOutputSchema.safeParse({ ...out, data: "" }).success).toBe(false);
    const big = Buffer.alloc(MAX_EXEC_OUTPUT_BYTES + 3).toString("base64");
    expect(ExecOutputSchema.safeParse({ ...out, data: big }).success).toBe(false);
    const exit = fixture("exec-exit.json") as Record<string, unknown>;
    expect(ExecExitSchema.safeParse({ ...exit, exit_code: null }).success).toBe(false);
    expect(AgentFrameSchema.safeParse(fixture("exec-exit-error.json")).success).toBe(true);
  });
});

describe("image push (ADR 0011)", () => {
  it("seals the registry login and pins the source", async () => {
    const { node, key } = nodeKey();
    const m = ImagePushSchema.parse(payload("signed-image-push.json"));
    const cred = SealedImagePushCredentialSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          await openBox(key, m.credential_sealed, "image-push", imagePushAad(node, m.push_id)),
        ),
      ),
    );
    expect(cred.username).toBe("v1");
    const ok = (x: unknown) => ImagePushSchema.safeParse(x).success;
    expect(ok({ ...m, source: `docker.io/library/nginx@sha256:${"a".repeat(64)}` })).toBe(false);
    expect(ok({ ...m, source: m.source.replace(/@sha256:.*/, ":latest") })).toBe(false);
    expect(ok({ ...m, target: `registry.cloudflare.com/acct/app@sha256:${"a".repeat(64)}` })).toBe(
      false,
    );
    expect(ok({ ...m, target: "127.0.0.1:5000/prj/svc:tag" })).toBe(false);
    expect(ok({ ...m, target: "app:tag" })).toBe(false);
    expect(ok({ ...m, target: "localhost:5001/rh-app:dep_1" })).toBe(true);
    expect(ok({ ...m, platform: "linux/arm64" })).toBe(false);
  });

  it("requires a digest on success and an error on failure", () => {
    const okResult = fixture("image-push-result-ok.json") as Record<string, unknown>;
    expect(ImagePushResultSchema.safeParse({ ...okResult, digest: undefined }).success).toBe(false);
    expect(ImagePushResultSchema.safeParse({ ...okResult, error: "x" }).success).toBe(false);
    const failed = fixture("image-push-result-failed.json") as Record<string, unknown>;
    expect(ImagePushResultSchema.safeParse({ ...failed, error: undefined }).success).toBe(false);
  });
});

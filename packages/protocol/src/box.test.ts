import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BoxPurpose,
  buildSecretsAad,
  NodeEncryptionKeySchema,
  nodeEncryptionKeyId,
  openBox,
  type SealedBox,
  SealedBoxSchema,
  SealedBuildSecretsSchema,
  SealedWorkloadEnvSchema,
  sealBox,
  verifyNodeEncryptionKey,
  workloadEnvAad,
  x25519PublicKey,
} from "./index";

interface BoxFixture {
  node_id: string;
  node_private_key_hex: string;
  node_public_key: string;
  node_kid: string;
  ephemeral_private_key_hex: string;
  x25519_shared_hex: string;
  cases: { name: string; purpose: BoxPurpose; aad: string; plaintext: string; box: SealedBox }[];
}

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8")) as T;

const vectors = fixture<BoxFixture>("sealed-box.json");
const hex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const nodeKey = hex(vectors.node_private_key_hex);
const decoder = new TextDecoder();

describe("sealed box vectors", () => {
  it("derives the RFC 7748 public key and key id", async () => {
    expect(await x25519PublicKey(nodeKey)).toBe(vectors.node_public_key);
    expect(await nodeEncryptionKeyId(vectors.node_public_key)).toBe(vectors.node_kid);
    expect(vectors.node_kid).toMatch(/^[a-f0-9]{16}$/);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))("opens %s", async (_, c) => {
    expect(SealedBoxSchema.parse(c.box)).toEqual(c.box);
    expect(decoder.decode(await openBox(nodeKey, c.box, c.purpose, c.aad))).toBe(c.plaintext);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))(
    "re-seals %s byte for byte",
    async (_, c) => {
      const box = await sealBox(vectors.node_public_key, c.plaintext, c.purpose, c.aad, {
        ephemeralPrivateKey: hex(vectors.ephemeral_private_key_hex),
      });
      expect(box).toEqual(c.box);
    },
  );

  it("carries plaintexts that match their schemas", () => {
    for (const c of vectors.cases) {
      const schema =
        c.purpose === "workload-env" ? SealedWorkloadEnvSchema : SealedBuildSecretsSchema;
      expect(() => schema.parse(JSON.parse(c.plaintext)), c.name).not.toThrow();
    }
  });
});

describe("sealBox / openBox", () => {
  const aad = workloadEnvAad("node_1", "wl_1", 3);

  it("round-trips with a fresh ephemeral key each time", async () => {
    const a = await sealBox(vectors.node_public_key, "hello", "workload-env", aad);
    const b = await sealBox(vectors.node_public_key, "hello", "workload-env", aad);
    expect(a.epk).not.toBe(b.epk);
    expect(a.ct).not.toBe(b.ct);
    expect(decoder.decode(await openBox(nodeKey, a, "workload-env", aad))).toBe("hello");
  });

  it("binds the AAD, the purpose and the key", async () => {
    const box = await sealBox(vectors.node_public_key, "x", "workload-env", aad);
    await expect(
      openBox(nodeKey, box, "workload-env", workloadEnvAad("node_1", "wl_1", 4)),
    ).rejects.toThrow();
    await expect(
      openBox(nodeKey, box, "workload-env", workloadEnvAad("node_2", "wl_1", 3)),
    ).rejects.toThrow();
    await expect(openBox(nodeKey, box, "build-secrets", aad)).rejects.toThrow();
    const other = crypto.getRandomValues(new Uint8Array(32));
    await expect(openBox(other, box, "workload-env", aad)).rejects.toThrow();
  });

  it("rejects tampered ciphertext and ephemeral keys", async () => {
    const box = await sealBox(vectors.node_public_key, "secret-value", "build-secrets", "a");
    const ct = Buffer.from(box.ct, "base64");
    ct[0]! ^= 1;
    await expect(
      openBox(nodeKey, { ...box, ct: ct.toString("base64") }, "build-secrets", "a"),
    ).rejects.toThrow();
    await expect(
      openBox(nodeKey, { ...box, epk: vectors.node_public_key }, "build-secrets", "a"),
    ).rejects.toThrow();
  });

  it("rejects a low-order recipient key", async () => {
    await expect(
      sealBox(Buffer.alloc(32).toString("base64"), "x", "workload-env", aad),
    ).rejects.toThrow();
  });

  it("formats AADs", () => {
    expect(workloadEnvAad("node_1", "wl_1", 42)).toBe(
      "roundhouse-box:v1:workload-env:node_1:wl_1:42",
    );
    expect(buildSecretsAad("node_1", "bld_1")).toBe("roundhouse-box:v1:build-secrets:node_1:bld_1");
  });
});

describe("plaintext schemas", () => {
  it("refuses a key that is both an env var and a file", () => {
    expect(SealedWorkloadEnvSchema.safeParse({ env: { A: "1" }, files: { A: "2" } }).success).toBe(
      false,
    );
  });

  it("enforces names and NUL-free values", () => {
    expect(SealedWorkloadEnvSchema.safeParse({ env: { "1A": "x" }, files: {} }).success).toBe(
      false,
    );
    expect(SealedWorkloadEnvSchema.safeParse({ env: { A: "x\0" }, files: {} }).success).toBe(false);
    expect(SealedBuildSecretsSchema.safeParse({ secrets: { A: "x\0" } }).success).toBe(false);
  });
});

describe("node encryption keys", () => {
  const f = fixture<{
    node_id: string;
    identity_public_key: string;
    encryption_key: { public_key: string; kid: string; sig: string };
  }>("encryption-key.json");

  it("verifies the fixture signature", async () => {
    expect(NodeEncryptionKeySchema.parse(f.encryption_key)).toEqual(f.encryption_key);
    expect(await verifyNodeEncryptionKey(f.identity_public_key, f.node_id, f.encryption_key)).toBe(
      true,
    );
  });

  it("rejects another node, a swapped key or a wrong kid", async () => {
    expect(
      await verifyNodeEncryptionKey(f.identity_public_key, "node_other", f.encryption_key),
    ).toBe(false);
    expect(
      await verifyNodeEncryptionKey(f.identity_public_key, f.node_id, {
        ...f.encryption_key,
        public_key: Buffer.alloc(32, 9).toString("base64"),
      }),
    ).toBe(false);
    expect(
      await verifyNodeEncryptionKey(f.identity_public_key, f.node_id, {
        ...f.encryption_key,
        kid: "0000000000000000",
      }),
    ).toBe(false);
  });
});

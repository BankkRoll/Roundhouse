/**
 * The format 2 building blocks: key IDs, keyring parsing, AAD strings and
 * fingerprints. Values are pinned so a change to any derivation fails here
 * before it strands data sealed with the old one.
 */
import { toBase64 } from "@roundhouse/protocol";
import { describe, expect, it } from "vitest";
import {
  dataKeyInfo,
  deriveKey,
  isCurrentKek,
  openDataKey,
  seal,
  sealDataKey,
  sealWith,
  signState,
  unseal,
  unsealWith,
  valueFingerprint,
  verifyState,
} from "../src/lib/crypto";
import { sealInstanceSecret, unsealInstanceSecret } from "../src/lib/instance-secrets";
import {
  dekId,
  deploymentBuildAadV2,
  deploymentEnvAadV2,
  deriveKeyV2,
  fingerprintKey,
  instanceSecretAadV2,
  keyByKid,
  masterKeyId,
  parseKeyring,
  projectKeyAadV2,
  variableAadV2,
  variableFingerprint,
} from "../src/lib/keyring";

const KEY_A = btoa("a".repeat(32));
const KEY_B = btoa("b".repeat(32));
const KEY_C = btoa("c".repeat(32));

describe("masterKeyId", () => {
  it("is 8 hex, stable, and differs per key", async () => {
    const a = await masterKeyId(KEY_A);
    expect(a).toBe("c67798f0");
    expect(await masterKeyId(` ${KEY_A}\n`)).toBe(a);
    expect(await masterKeyId(KEY_B)).not.toBe(a);
  });
});

describe("parseKeyring", () => {
  it("reads the current key and previous keys in order", async () => {
    const ring = (await parseKeyring({
      MASTER_KEY: KEY_A,
      MASTER_KEYS_PREVIOUS: ` ${KEY_B}, ${KEY_C},`,
    }))!;
    expect(ring.current.kid).toBe(await masterKeyId(KEY_A));
    expect(ring.previous.map((k) => k.kid)).toEqual([
      await masterKeyId(KEY_B),
      await masterKeyId(KEY_C),
    ]);
    expect(keyByKid(ring, ring.previous[1]!.kid)?.base64).toBe(KEY_C);
    expect(keyByKid(ring, "00000000")).toBeUndefined();
  });

  it("returns null without a usable MASTER_KEY and rejects bad previous keys", async () => {
    expect(await parseKeyring({})).toBeNull();
    expect(await parseKeyring({ MASTER_KEY: "short" })).toBeNull();
    await expect(
      parseKeyring({ MASTER_KEY: KEY_A, MASTER_KEYS_PREVIOUS: "nope" }),
    ).rejects.toThrow();
    await expect(
      parseKeyring({ MASTER_KEY: KEY_A, MASTER_KEYS_PREVIOUS: KEY_A }),
    ).rejects.toThrow();
  });
});

describe("deriveKeyV2", () => {
  it("derives independent 32-byte keys per purpose and per master key", async () => {
    const ring = (await parseKeyring({ MASTER_KEY: KEY_A, MASTER_KEYS_PREVIOUS: KEY_B }))!;
    const kek = new Uint8Array(await deriveKeyV2(ring.current, "kek"));
    const state = new Uint8Array(await deriveKeyV2(ring.current, "state-token"));
    const oldKek = new Uint8Array(await deriveKeyV2(ring.previous[0]!, "kek"));
    expect(kek.byteLength).toBe(32);
    expect(kek).not.toEqual(state);
    expect(kek).not.toEqual(oldKek);
  });
});

describe("format 2 AADs", () => {
  it("binds every coordinate of a variable", () => {
    expect(
      variableAadV2({
        workspaceId: "ws_1",
        projectId: "prj_1",
        environmentId: "env_1",
        scope: "service",
        serviceId: "svc_1",
        key: "API_KEY",
        rowId: "var_1",
        version: 3,
      }),
    ).toBe("variable:v2:ws_1:prj_1:env_1:service:svc_1:API_KEY:var_1:3");
    expect(
      variableAadV2({
        workspaceId: "ws_1",
        projectId: "prj_1",
        environmentId: "env_1",
        scope: "shared",
        serviceId: null,
        key: "REGION",
        rowId: "var_2",
        version: 1,
      }),
    ).toBe("variable:v2:ws_1:prj_1:env_1:shared:-:REGION:var_2:1");
  });

  it("formats the other AADs", () => {
    expect(projectKeyAadV2("ws_1", "prj_1")).toBe("project-key:v2:ws_1:prj_1");
    expect(deploymentEnvAadV2("ws_1", "prj_1", "dep_1")).toBe("deployment-env:v2:ws_1:prj_1:dep_1");
    expect(deploymentBuildAadV2("ws_1", "prj_1", "dep_1")).toBe(
      "deployment-build:v2:ws_1:prj_1:dep_1",
    );
    expect(instanceSecretAadV2("github_app", "private_key")).toBe(
      "setting:v2:github_app:private_key",
    );
    expect(instanceSecretAadV2("signing_key")).toBe("setting:v2:signing_key:-");
  });
});

describe("DEK ids and fingerprints", () => {
  const dek = new Uint8Array(32).fill(7);

  it("ids a DEK by hash", async () => {
    expect(await dekId(dek)).toBe("4bb06f8e");
    expect(await dekId(new Uint8Array(32).fill(8))).not.toBe(await dekId(dek));
  });

  it("fingerprints values per project, keyed", async () => {
    const k1 = await fingerprintKey(dek, "prj_1");
    const k2 = await fingerprintKey(dek, "prj_2");
    const fp = await variableFingerprint(k1, "hunter2");
    expect(fp).toBe("8702a7a8");
    expect(await variableFingerprint(k1, "hunter2")).toBe(fp);
    expect(await variableFingerprint(k1, "hunter3")).not.toBe(fp);
    expect(await variableFingerprint(k2, "hunter2")).not.toBe(fp);
    // Not a bare hash of the value.
    const bare = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hunter2"))),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 8);
    expect(fp).not.toBe(bare);
  });
});

describe("sealing through the keyring", () => {
  const ringA = { MASTER_KEY: KEY_A };
  const rotated = { MASTER_KEY: KEY_B, MASTER_KEYS_PREVIOUS: KEY_A };

  it("seals format 2 under the current key and opens by kid", async () => {
    const sealed = await seal(ringA, "s3cret", "aad");
    expect(sealed).toMatchObject({ v: 2, kid: "c67798f0" });
    expect(await unseal(ringA, sealed, "aad")).toBe("s3cret");
    expect(await unseal(rotated, sealed, "aad")).toBe("s3cret");
    await expect(unseal({ MASTER_KEY: KEY_B }, sealed, "aad")).rejects.toThrow(/c67798f0/);
    await expect(unseal(ringA, sealed, "other")).rejects.toThrow();
    expect(await isCurrentKek(ringA, sealed)).toBe(true);
    expect(await isCurrentKek(rotated, sealed)).toBe(false);
  });

  it("opens format 1 under any key of the keyring", async () => {
    const raw = await deriveKey(KEY_A, "kek");
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("aad") },
      key,
      new TextEncoder().encode("legacy"),
    );
    const v1 = { v: 1 as const, iv: toBase64(iv), ct: toBase64(ct) };
    expect(await unseal(rotated, v1, "aad")).toBe("legacy");
    await expect(unseal({ MASTER_KEY: KEY_B }, v1, "aad")).rejects.toThrow();
  });

  it("binds instance secrets to their setting and field", async () => {
    const sealed = await sealInstanceSecret(ringA, "pem", "github_app", "private_key");
    expect(await unseal(ringA, sealed, "setting:v2:github_app:private_key")).toBe("pem");
    expect(await unsealInstanceSecret(rotated, sealed, "github_app", "private_key")).toBe("pem");
    await expect(
      unsealInstanceSecret(ringA, sealed, "github_app", "client_secret"),
    ).rejects.toThrow();
  });

  it("verifies state tokens under every key, signs with the current one", async () => {
    const token = await signState(ringA, "p", { n: 1 }, 60_000);
    expect(await verifyState(rotated, "p", token)).toMatchObject({ n: 1 });
    expect(await verifyState({ MASTER_KEY: KEY_B }, "p", token)).toBeNull();
    expect(await verifyState(ringA, "other", token)).toBeNull();
  });

  it("ids DEKs and fingerprints with the key they were opened with", async () => {
    const raw = toBase64(new Uint8Array(32).fill(7));
    const { dekSealed, kekKid, dekId: id } = await sealDataKey(ringA, raw, "ws_1", "prj_1");
    expect(kekKid).toBe("c67798f0");
    expect(id).toBe("4bb06f8e");
    await expect(unseal(ringA, dekSealed, "project-key:v2:ws_1:prj_1")).resolves.toBe(raw);
    const key = await openDataKey(rotated, dekSealed, "ws_1", "prj_1");
    expect(dataKeyInfo(key)).toMatchObject({ dekId: "4bb06f8e", workspaceId: "ws_1" });
    expect(await valueFingerprint(key, "hunter2")).toBe("8702a7a8");
    const value = await sealWith(key, "v", "aad");
    expect(value).toMatchObject({ v: 2, kid: "4bb06f8e" });
    expect(await unsealWith(key, value, "aad")).toBe("v");
    await expect(unsealWith(key, { ...value, kid: "00000000" }, "aad")).rejects.toThrow();
    // Bound to its project and workspace.
    await expect(openDataKey(ringA, dekSealed, "ws_2", "prj_1")).rejects.toThrow();
  });
});

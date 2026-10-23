/**
 * The format 2 building blocks: key IDs, keyring parsing, AAD strings and
 * fingerprints. Values are pinned so a change to any derivation fails here
 * before it strands data sealed with the old one.
 */
import { describe, expect, it } from "vitest";
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
    expect(a).toBe("ce6bd2cb");
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
    expect(fp).toBe("34bd6384");
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

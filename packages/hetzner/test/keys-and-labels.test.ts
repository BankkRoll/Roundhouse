import { describe, expect, it } from "vitest";
import { ProvisionError } from "../src/errors";
import {
  isManaged,
  isValidLabelKey,
  isValidLabelValue,
  nodeSelector,
  validateExtraLabels,
} from "../src/labels";
import { ensureSshKey, normalizeSshPublicKey, sshKeyName } from "../src/ssh-keys";
import { apiError } from "./fake-hetzner";
import { SSH_KEY } from "./fixtures";
import { harness } from "./helpers";

describe("SSH keys", () => {
  it("normalises to type and body, dropping the comment and whitespace", () => {
    const [type, body] = SSH_KEY.split(" ");
    expect(normalizeSshPublicKey(`  ${SSH_KEY}  `)).toBe(`${type} ${body}`);
  });

  it("rejects malformed and multi-line keys", () => {
    for (const bad of [
      "",
      "ssh-ed25519",
      "ssh-dss AAAAB3NzaC1kc3MAAACBAP",
      `${SSH_KEY}\n${SSH_KEY}`,
      "ssh-ed25519 not*base64",
    ]) {
      expect(() => normalizeSshPublicKey(bad)).toThrow(ProvisionError);
    }
  });

  it("names keys deterministically", async () => {
    const a = await sshKeyName(normalizeSshPublicKey(SSH_KEY));
    expect(a).toMatch(/^roundhouse-[0-9a-f]{12}$/);
    expect(await sshKeyName(normalizeSshPublicKey(SSH_KEY.replace("ops@laptop", "x")))).toBe(a);
  });

  it("reuses a key uploaded earlier under any name", async () => {
    const { fake, client } = harness();
    fake.sshKeys.set(3, {
      id: 3,
      name: "my laptop",
      public_key: SSH_KEY.replace("ops@laptop", "me"),
      fingerprint: "",
      labels: {},
      created: "",
    });
    expect((await ensureSshKey(client, SSH_KEY)).id).toBe(3);
    expect(fake.mutations).toEqual([]);
  });

  it("recovers when a concurrent upload wins", async () => {
    const { fake, client } = harness();
    fake.intercept((r) => {
      if (r.method === "POST" && r.path === "/ssh_keys") {
        fake.sshKeys.set(8, {
          id: 8,
          name: "x",
          public_key: SSH_KEY,
          fingerprint: "",
          labels: {},
          created: "",
        });
        return apiError(409, "uniqueness_error");
      }
      return undefined;
    });
    expect((await ensureSshKey(client, SSH_KEY)).id).toBe(8);
  });
});

describe("labels", () => {
  it("validates keys per Hetzner's rules", () => {
    for (const ok of ["env", "example.com/my", "a.b-c_d", "x/y"])
      expect(isValidLabelKey(ok), ok).toBe(true);
    for (const bad of [
      "",
      "-a",
      "a-",
      "hetzner.cloud/x",
      "Bad_Prefix.com/x",
      "a".repeat(64),
      "has space",
    ]) {
      expect(isValidLabelKey(bad), bad).toBe(false);
    }
  });

  it("validates values per Hetzner's rules", () => {
    for (const ok of ["", "prod", "ws_01H", "a.b-c"]) expect(isValidLabelValue(ok), ok).toBe(true);
    for (const bad of ["-a", "a b", "a".repeat(64), "a,b", "a=b"])
      expect(isValidLabelValue(bad), bad).toBe(false);
  });

  it("reserves the managed prefix for this package", () => {
    expect(() => validateExtraLabels({ "roundhouse.managed": "true" })).toThrow(RangeError);
    expect(validateExtraLabels({ team: "web" })).toEqual({ team: "web" });
  });

  it("builds the node selector and recognises managed labels", () => {
    expect(nodeSelector("web-1")).toBe("roundhouse.managed=true,roundhouse.node=web-1");
    expect(isManaged({ "roundhouse.managed": "true" })).toBe(true);
    expect(isManaged({ "roundhouse.managed": "True" })).toBe(false);
    expect(isManaged(undefined)).toBe(false);
  });
});

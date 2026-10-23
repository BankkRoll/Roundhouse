import { describe, expect, it } from "vitest";
import {
  createTagCodec,
  isManaged,
  isValidLabelValue,
  LABEL_FIREWALL,
  LABEL_KEYS,
  LABEL_MANAGED,
  LABEL_NODE,
  LABEL_ROLE,
  LABEL_WORKSPACE,
  managedLabels,
  nodeSelector,
  readManagedIdentity,
} from "../src/naming";

describe("label keys", () => {
  it("keeps the exact keys @openrail/hetzner wrote to users' clouds", () => {
    expect([LABEL_MANAGED, LABEL_NODE, LABEL_ROLE, LABEL_WORKSPACE, LABEL_FIREWALL]).toEqual([
      "roundhouse.managed",
      "roundhouse.node",
      "roundhouse.role",
      "roundhouse.workspace",
      "roundhouse.firewall",
    ]);
  });

  it("builds managed labels and reads them back", () => {
    const labels = managedLabels({ node: "web-1", role: "builder", workspaceId: "ws_1" });
    expect(labels).toEqual({
      "roundhouse.managed": "true",
      "roundhouse.node": "web-1",
      "roundhouse.role": "builder",
      "roundhouse.workspace": "ws_1",
    });
    expect(readManagedIdentity(labels)).toEqual({
      node: "web-1",
      role: "builder",
      workspaceId: "ws_1",
    });
    expect(managedLabels({ node: "a", role: "node", workspaceId: null })).not.toHaveProperty(
      LABEL_WORKSPACE,
    );
  });

  it("recognises only the exact managed marker with a node name", () => {
    expect(isManaged({ "roundhouse.managed": "true" })).toBe(true);
    expect(isManaged({ "roundhouse.managed": "True" })).toBe(false);
    expect(isManaged(undefined)).toBe(false);
    expect(readManagedIdentity({ "roundhouse.managed": "true" })).toBeNull();
    expect(readManagedIdentity({ "roundhouse.node": "web-1" })).toBeNull();
  });

  it("builds the Hetzner node selector", () => {
    expect(nodeSelector("web-1")).toBe("roundhouse.managed=true,roundhouse.node=web-1");
  });

  it("validates label values with the strictest grammar", () => {
    for (const ok of ["", "prod", "ws_01H", "a.b-c"]) expect(isValidLabelValue(ok), ok).toBe(true);
    for (const bad of ["-a", "a b", "a".repeat(64), "a,b", "a=b", "a:b"]) {
      expect(isValidLabelValue(bad), bad).toBe(false);
    }
  });
});

describe("tag codecs", () => {
  const labels = managedLabels({ node: "web-1", role: "node", workspaceId: "ws_1" });

  it("writes key=value tags", () => {
    const kv = createTagCodec({ separator: "=" });
    expect(kv.encode(labels)).toEqual([
      "roundhouse.managed=true",
      "roundhouse.node=web-1",
      "roundhouse.role=node",
      "roundhouse.workspace=ws_1",
    ]);
    expect(kv.decode(kv.encode(labels))).toEqual(labels);
  });

  it("writes colon tags for providers that forbid . and =", () => {
    const colon = createTagCodec({ separator: ":", keyDot: ":" });
    const tags = colon.encode(labels);
    expect(tags).toContain("roundhouse:node:web-1");
    expect(tags.every((t) => /^[a-zA-Z0-9_:-]+$/.test(t))).toBe(true);
    expect(colon.decode(tags)).toEqual(labels);
  });

  it("ignores foreign tags and keeps values containing the separator", () => {
    const colon = createTagCodec({ separator: ":", keyDot: ":" });
    expect(colon.decode(["env:prod", "web", "roundhouse:node:a:b"])).toEqual({
      "roundhouse.node": "a:b",
    });
    expect(LABEL_KEYS).toHaveLength(5);
  });

  it("drops a key whose tags disagree, so the server reads as unmanaged", () => {
    const kv = createTagCodec({ separator: "=" });
    const decoded = kv.decode([...kv.encode(labels), "roundhouse.node=web-2"]);
    expect(decoded).not.toHaveProperty(LABEL_NODE);
    expect(readManagedIdentity(decoded)).toBeNull();
    const dup = kv.decode([...kv.encode(labels), "roundhouse.node=web-1"]);
    expect(readManagedIdentity(dup)?.node).toBe("web-1");
  });
});

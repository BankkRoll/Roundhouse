import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  computeSpecHash,
  SPEC_HASH_EXCLUDED_FIELDS,
  specHashInput,
  type WorkloadSpec,
} from "./index";

const spec: WorkloadSpec = {
  id: "wl_1",
  kind: "service",
  project_id: "prj_1",
  environment_id: "env_1",
  service_id: "svc_1",
  deployment_id: "dep_1",
  replica: 0,
  image: "nginx:1.27",
  env_sealed: {
    v: 1,
    kid: "0123456789abcdef",
    epk: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=",
    ct: "AAAA",
  },
  ports: [{ container_port: 80, protocol: "http" }],
  routes: [{ hostname: "a.example.com", container_port: 80 }],
  healthcheck: null,
  resources: { cpu_millis: 100, memory_mb: 64, pids: 64 },
  restart: { policy: "always", max_retries: 0 },
  network: "roundhouse-prj_1-env_1",
  labels: {},
  drain_s: 5,
  spec_hash: "0".repeat(64),
};

describe("canonicalJson", () => {
  it.each<[unknown, string]>([
    [null, "null"],
    [true, "true"],
    [0, "0"],
    [-0, "0"],
    [-42, "-42"],
    [Number.MAX_SAFE_INTEGER, "9007199254740991"],
    ["", '""'],
    [[], "[]"],
    [{}, "{}"],
    [[1, null, "a"], '[1,null,"a"]'],
    [{ b: 1, a: 2 }, '{"a":2,"b":1}'],
    [{ a: null, b: undefined, c: 1 }, '{"c":1}'],
    [{ Z: 1, a: 2, _: 3 }, '{"Z":1,"_":3,"a":2}'],
    [{ nested: { y: [{ b: 1, a: 0 }], x: {} } }, '{"nested":{"x":{},"y":[{"a":0,"b":1}]}}'],
  ])("%j → %s", (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it("escapes only quotes, backslashes and control characters", () => {
    expect(canonicalJson('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalJson("\u0000\u0008\t\n\u001f")).toBe('"\\u0000\\u0008\\u0009\\u000a\\u001f"');
    expect(canonicalJson("<&>\u007f  é🚀")).toBe('"<&>\u007f  é🚀"');
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])("rejects the number %s", (n) => {
    expect(() => canonicalJson(n)).toThrow(TypeError);
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalJson(1n)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });
});

describe("computeSpecHash", () => {
  it("is lowercase hex sha256", async () => {
    expect(await computeSpecHash(spec)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ignores key order and the existing hash", async () => {
    const reordered = Object.fromEntries(Object.entries(spec).reverse()) as WorkloadSpec;
    const hash = await computeSpecHash(spec);
    expect(await computeSpecHash(reordered)).toBe(hash);
    expect(await computeSpecHash({ ...spec, spec_hash: "f".repeat(64) })).toBe(hash);
  });

  it.each(SPEC_HASH_EXCLUDED_FIELDS)("does not change when %s changes", async (field) => {
    const changed = {
      spec_hash: "1".repeat(64),
      routes: [],
      registry_auth: { server: "ghcr.io", username: "u", password: "p" },
      drain_s: 600,
      env_sealed: {
        v: 1,
        kid: "fedcba9876543210",
        epk: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=",
        ct: "BBBB",
      },
    }[field];
    expect(await computeSpecHash({ ...spec, [field]: changed })).toBe(await computeSpecHash(spec));
    expect(specHashInput(spec)).not.toContain(`"${field}"`);
  });

  it.each<[string, Partial<WorkloadSpec>]>([
    ["image", { image: "nginx:1.28" }],
    ["network", { network: "roundhouse-prj_1-env_2" }],
    ["command", { command: ["sh"] }],
    ["ports", { ports: [{ container_port: 81, protocol: "http" }] }],
    ["resources", { resources: { cpu_millis: 101, memory_mb: 64, pids: 64 } }],
    ["restart", { restart: { policy: "never", max_retries: 0 } }],
    ["labels", { labels: { a: "b" } }],
    ["replica", { replica: 1 }],
  ])("changes when %s changes", async (_name, overrides) => {
    expect(await computeSpecHash({ ...spec, ...overrides })).not.toBe(await computeSpecHash(spec));
  });

  it("treats a null registry_auth like an absent one", async () => {
    expect(await computeSpecHash({ ...spec, registry_auth: null })).toBe(
      await computeSpecHash(spec),
    );
  });
});

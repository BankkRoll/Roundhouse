// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are variable references (`${{svc.VAR}}`), not template literals.
import { describe, expect, it } from "vitest";
import {
  affectedServices,
  configDiff,
  conflictingPointers,
  describeOp,
  MASKED_VALUE,
  MAX_STAGED_OPS,
  mergeConfigPatches,
  opAction,
  patchPointers,
  pointersOverlap,
  type StagedEntry,
  type StagedOp,
  serviceOfOp,
  stageOp,
  targetKeyOf,
} from "./changes";
import { defaultServiceConfig } from "./service-config";

const entry = (op: StagedOp): StagedEntry => ({ target_key: targetKeyOf(op), op });

const setVar = (service: string, key: string): StagedOp => ({
  type: "variable.set",
  scope: "service",
  service,
  key,
  confirm_write_only: false,
  acknowledge_public: false,
  fingerprint: "0123abcd",
  staged_tier: "plain",
});

describe("targetKeyOf", () => {
  it("keys ops by what they change", () => {
    expect(targetKeyOf({ type: "config.patch", service: "svc_1", patch: {} })).toBe("config:svc_1");
    expect(targetKeyOf(setVar("svc_1", "A"))).toBe("var:svc_1:A");
    expect(targetKeyOf({ type: "variable.delete", scope: "shared", key: "A" })).toBe(
      "var:shared:A",
    );
    expect(targetKeyOf({ type: "service.delete", service_id: "svc_1" })).toBe("service:svc_1");
  });
});

describe("stageOp", () => {
  it("merges config patches per field, newer winning", () => {
    const older = entry({
      type: "config.patch",
      service: "svc_1",
      patch: { deploy: { replicas: 2 }, resources: { memory_mb: 256 } },
    });
    const result = stageOp([older], {
      type: "config.patch",
      service: "svc_1",
      patch: { deploy: { replicas: 3, drain_s: 5 } },
    });
    expect(result).toMatchObject({
      ok: true,
      replaces: true,
      entry: {
        op: { patch: { deploy: { replicas: 3, drain_s: 5 }, resources: { memory_mb: 256 } } },
      },
    });
  });

  it("replaces a staged variable delete with a set of the same key", () => {
    const del = entry({ type: "variable.delete", scope: "service", service: "svc_1", key: "A" });
    const result = stageOp([del], setVar("svc_1", "A"));
    expect(result).toMatchObject({
      ok: true,
      replaces: true,
      entry: { op: { type: "variable.set" } },
    });
  });

  it("drops a service's other ops when it is deleted, and refuses new ones", () => {
    const ops = [
      entry(setVar("svc_1", "A")),
      entry({ type: "config.patch", service: "svc_1", patch: { deploy: { replicas: 2 } } }),
      entry(setVar("svc_2", "B")),
    ];
    const result = stageOp(ops, { type: "service.delete", service_id: "svc_1" });
    expect(result).toMatchObject({ ok: true, drop: ["var:svc_1:A", "config:svc_1"] });
    const after = [
      entry(setVar("svc_2", "B")),
      entry({ type: "service.delete", service_id: "svc_1" }),
    ];
    expect(stageOp(after, setVar("svc_1", "C"))).toMatchObject({
      ok: false,
      code: "service_deleted",
    });
  });

  it("needs a staged creation for new:<n> refs", () => {
    expect(stageOp([], setVar("new:1", "A"))).toMatchObject({ ok: false, code: "unknown_ref" });
    const create = entry({
      type: "service.create",
      ref: "new:1",
      name: "db",
      kind: "database",
      source: { type: "image", image: "postgres:17" },
    });
    expect(stageOp([create], setVar("new:1", "A"))).toMatchObject({ ok: true });
  });

  it("caps a set at MAX_STAGED_OPS, but still lets ops coalesce", () => {
    const full = Array.from({ length: MAX_STAGED_OPS }, (_, i) => entry(setVar("svc_1", `K${i}`)));
    expect(stageOp(full, setVar("svc_1", "NEW"))).toMatchObject({
      ok: false,
      code: "too_many_ops",
    });
    expect(stageOp(full, setVar("svc_1", "K0"))).toMatchObject({ ok: true, replaces: true });
  });
});

describe("config pointers", () => {
  it("lists pointers, whole for source and healthcheck", () => {
    expect(
      patchPointers({
        source: { type: "image", image: "nginx:1" },
        deploy: { replicas: 2, drain_s: 3 },
        healthcheck: null,
      }),
    ).toEqual(["/deploy/drain_s", "/deploy/replicas", "/healthcheck", "/source"]);
  });

  it("replaces whole parts when merging", () => {
    expect(
      mergeConfigPatches(
        { source: { type: "image", image: "a:1" }, deploy: { replicas: 1 } },
        { source: { type: "image", image: "b:1" }, deploy: { drain_s: 4 } },
      ),
    ).toEqual({ source: { type: "image", image: "b:1" }, deploy: { replicas: 1, drain_s: 4 } });
  });

  it("diffs field by field and masks secret build args", () => {
    const before = defaultServiceConfig({ type: "image", image: "nginx:1" });
    const after = {
      ...before,
      deploy: { ...before.deploy, replicas: 3 },
      build: {
        ...before.build,
        build_args: { NPM_TOKEN: "s3cret", MODE: "prod" },
        secret_build_args: ["NPM_TOKEN"],
      },
    };
    const diff = configDiff(before, after);
    expect(diff).toEqual([
      { path: "/build/build_args/MODE", before: null, after: "prod" },
      { path: "/build/build_args/NPM_TOKEN", before: null, after: MASKED_VALUE },
      { path: "/build/secret_build_args", before: null, after: ["NPM_TOKEN"] },
      { path: "/deploy/replicas", before: 1, after: 3 },
    ]);
    expect(JSON.stringify(diff)).not.toContain("s3cret");
  });

  it("merges disjoint pointers and conflicts on overlapping ones, always", () => {
    const fields = ["/deploy/replicas", "/deploy/drain_s", "/resources/memory_mb", "/source"];
    for (let mask = 1; mask < 1 << fields.length; mask++) {
      for (let other = 1; other < 1 << fields.length; other++) {
        const mine = fields.filter((_, i) => mask & (1 << i));
        const theirs = fields.filter((_, i) => other & (1 << i));
        const overlap = conflictingPointers(mine, theirs);
        expect(overlap.length > 0).toBe((mask & other) !== 0);
      }
    }
    expect(pointersOverlap("/source", "/source/image")).toBe(true);
    expect(pointersOverlap("/deploy/replicas", "/deploy/replica")).toBe(false);
  });
});

describe("affectedServices", () => {
  it("follows references transitively, through shared variables too", () => {
    expect(
      affectedServices({
        services: {
          db: { PASSWORD: "x" },
          api: { DATABASE_URL: "postgres://${{db.PASSWORD}}@h" },
          web: { API: "${{api.DATABASE_URL}}" },
          worker: { QUEUE: "${{shared.QUEUE_URL}}" },
          idle: { A: "1" },
        },
        shared: { QUEUE_URL: "amqp://q" },
        changedVariables: ["db.PASSWORD", "shared.QUEUE_URL"],
        changedServices: [],
      }),
    ).toEqual(["api", "db", "web", "worker"]);
  });

  it("includes changed configs and resolves unqualified references in their own namespace", () => {
    expect(
      affectedServices({
        services: { api: { A: "1", B: "${{A}}" }, web: {} },
        shared: {},
        changedVariables: ["api.A"],
        changedServices: ["web", "gone"],
      }),
    ).toEqual(["api", "web"]);
  });
});

describe("describeOp", () => {
  it("summarises without values", () => {
    expect(describeOp(setVar("svc_1", "TOKEN"), () => "api")).toBe("set api.TOKEN");
    expect(
      describeOp(
        { type: "config.patch", service: "svc_1", patch: { deploy: { replicas: 2 } } },
        () => "api",
      ),
    ).toBe("patch api config (deploy.replicas)");
  });
});

describe("volume and domain ops", () => {
  const volumeSet: StagedOp = { type: "volume.set", service: "svc_1", size_mb: 2048 };
  const domainAdd: StagedOp = {
    type: "domain.add",
    service: "svc_1",
    hostname: "shop.example.com",
  };
  const domainRemove: StagedOp = {
    type: "domain.remove",
    domain_id: "dom_1",
    hostname: "shop.example.com",
    service: "svc_1",
  };

  it("keys volumes by service and domains by hostname, all as services:manage", () => {
    expect(targetKeyOf(volumeSet)).toBe("volume:svc_1");
    expect(targetKeyOf({ type: "volume.delete", service: "svc_1" })).toBe("volume:svc_1");
    expect(targetKeyOf(domainAdd)).toBe(targetKeyOf(domainRemove));
    expect(opAction(volumeSet)).toBe("services:manage");
    expect(opAction(domainRemove)).toBe("services:manage");
    expect(serviceOfOp(domainRemove)).toBe("svc_1");
  });

  it("lets a volume delete replace a staged resize of the same service", () => {
    const result = stageOp([entry(volumeSet)], { type: "volume.delete", service: "svc_1" });
    expect(result).toMatchObject({ ok: true, replaces: true, drop: [] });
  });

  it("drops a service's volume and domain ops when the service is deleted", () => {
    const result = stageOp([entry(volumeSet), entry(domainAdd)], {
      type: "service.delete",
      service_id: "svc_1",
    });
    expect(result.ok && result.drop.sort()).toEqual(["domain:shop.example.com", "volume:svc_1"]);
  });

  it("summarises without anything beyond names and sizes", () => {
    const name = () => "api";
    expect(describeOp(volumeSet, name)).toBe("set api volume to 2048 MiB");
    expect(describeOp({ type: "volume.delete", service: "svc_1" }, name)).toBe("delete api volume");
    expect(describeOp(domainAdd, name)).toBe("add domain shop.example.com to api");
    expect(describeOp(domainRemove, name)).toBe("remove domain shop.example.com from api");
  });
});

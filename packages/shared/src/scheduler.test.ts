import { describe, expect, it } from "vitest";
import type { NodeStatus } from "./constants";
import {
  CPU_OVERCOMMIT_RATIO,
  SCHEDULE_FAILURE_REASONS,
  type ScheduleRequest,
  type SchedulerNode,
  schedule,
} from "./scheduler";
import { int, pick, seeded, shuffle } from "./test-random";

function node(id: string, overrides: Partial<SchedulerNode> = {}): SchedulerNode {
  return {
    id,
    status: "online",
    docker: true,
    labels: {},
    cpuMillis: 4000,
    memoryMb: 8192,
    allocatedCpuMillis: 0,
    allocatedMemoryMb: 0,
    serviceReplicas: {},
    reachesRegistry: true,
    ...overrides,
  };
}

function request(overrides: Partial<ScheduleRequest> = {}): ScheduleRequest {
  return {
    serviceId: "svc_1",
    replicas: 1,
    cpuMillis: 500,
    memoryMb: 512,
    nodeSelector: {},
    requiresRegistry: false,
    ...overrides,
  };
}

describe("schedule", () => {
  it("fails with no_nodes on an empty cluster", () => {
    expect(schedule(request(), [])).toEqual({
      ok: false,
      reason: "no_nodes",
      replica: 0,
      rejected: [],
    });
  });

  it("places nothing for zero replicas", () => {
    expect(schedule(request({ replicas: 0 }), [node("a")])).toEqual({ ok: true, placements: [] });
  });

  it.each<[string, Partial<SchedulerNode>, Partial<ScheduleRequest>, string]>([
    ["offline", { status: "offline" }, {}, "offline"],
    ["draining", { status: "draining" }, {}, "offline"],
    ["no docker", { docker: false }, {}, "no_docker"],
    [
      "selector",
      { labels: { region: "us" } },
      { nodeSelector: { region: "eu" } },
      "selector_mismatch",
    ],
    ["missing label", {}, { nodeSelector: { gpu: "true" } }, "selector_mismatch"],
    ["registry", { reachesRegistry: false }, { requiresRegistry: true }, "registry_unreachable"],
    ["memory", { allocatedMemoryMb: 8000 }, {}, "insufficient_memory"],
    ["cpu", { allocatedCpuMillis: 7800 }, {}, "insufficient_cpu"],
  ])("rejects a node for %s", (_name, nodeOverrides, reqOverrides, reason) => {
    expect(schedule(request(reqOverrides), [node("a", nodeOverrides)])).toEqual({
      ok: false,
      reason,
      replica: 0,
      rejected: [{ nodeId: "a", reason }],
    });
  });

  it("reports the most specific reason across nodes", () => {
    const result = schedule(request(), [
      node("a", { status: "offline" }),
      node("b", { allocatedMemoryMb: 8000 }),
      node("c", { docker: false }),
    ]);
    expect(result).toMatchObject({ ok: false, reason: "insufficient_memory" });
  });

  it("overcommits CPU up to the ratio but never memory", () => {
    const n = node("a", { cpuMillis: 1000, memoryMb: 1024 });
    expect(
      schedule(request({ cpuMillis: 1000 * CPU_OVERCOMMIT_RATIO, memoryMb: 1024 }), [n]).ok,
    ).toBe(true);
    expect(schedule(request({ cpuMillis: 1000 * CPU_OVERCOMMIT_RATIO + 1 }), [n]).ok).toBe(false);
    expect(schedule(request({ memoryMb: 1025 }), [n]).ok).toBe(false);
  });

  it("packs onto the most allocated node", () => {
    const result = schedule(request(), [
      node("empty"),
      node("busy", { allocatedMemoryMb: 4096, allocatedCpuMillis: 2000 }),
    ]);
    expect(result).toEqual({ ok: true, placements: [{ replica: 0, nodeId: "busy" }] });
  });

  it("spreads replicas before packing", () => {
    const result = schedule(request({ replicas: 3 }), [
      node("a", { allocatedMemoryMb: 6000 }),
      node("b"),
      node("c"),
    ]);
    expect(result).toEqual({
      ok: true,
      placements: [
        { replica: 0, nodeId: "a" },
        { replica: 1, nodeId: "b" },
        { replica: 2, nodeId: "c" },
      ],
    });
  });

  it("counts replicas of the same service already running", () => {
    const result = schedule(request(), [
      node("a", { allocatedMemoryMb: 6000, serviceReplicas: { svc_1: 1 } }),
      node("b"),
    ]);
    expect(result).toMatchObject({ ok: true, placements: [{ nodeId: "b" }] });
  });

  it("co-locates replicas when only one node fits", () => {
    const result = schedule(request({ replicas: 2 }), [node("a"), node("b", { docker: false })]);
    expect(result).toEqual({
      ok: true,
      placements: [
        { replica: 0, nodeId: "a" },
        { replica: 1, nodeId: "a" },
      ],
    });
  });

  it("fails at the first replica that does not fit", () => {
    const result = schedule(request({ replicas: 3, memoryMb: 4096 }), [node("a")]);
    expect(result).toMatchObject({ ok: false, reason: "insufficient_memory", replica: 2 });
  });

  it("breaks ties by node ID regardless of input order", () => {
    const nodes = [node("c"), node("a"), node("b")];
    expect(schedule(request(), nodes)).toMatchObject({ placements: [{ nodeId: "a" }] });
  });

  it("does not mutate its inputs", () => {
    const nodes = [node("a"), node("b")];
    const before = JSON.stringify(nodes);
    schedule(request({ replicas: 4 }), nodes);
    expect(JSON.stringify(nodes)).toBe(before);
  });
});

// -----------------------------------------------------------------------------
// Properties over random clusters
// -----------------------------------------------------------------------------

const STATUSES: NodeStatus[] = ["online", "online", "online", "offline", "degraded", "draining"];
const REGIONS = ["eu", "us"];

function randomCluster(random: () => number): { req: ScheduleRequest; nodes: SchedulerNode[] } {
  const nodes = Array.from({ length: int(random, 0, 8) }, (_, i) => {
    const cpuMillis = pick(random, [1000, 2000, 4000, 8000]);
    const memoryMb = pick(random, [1024, 2048, 4096, 8192]);
    return node(`node_${i}`, {
      status: pick(random, STATUSES),
      docker: random() > 0.1,
      labels: random() > 0.3 ? { region: pick(random, REGIONS) } : {},
      cpuMillis,
      memoryMb,
      allocatedCpuMillis: int(random, 0, cpuMillis * CPU_OVERCOMMIT_RATIO),
      allocatedMemoryMb: int(random, 0, memoryMb),
      serviceReplicas: random() > 0.5 ? { svc_1: int(random, 0, 2) } : {},
      reachesRegistry: random() > 0.3,
    });
  });
  const req = request({
    replicas: int(random, 0, 6),
    cpuMillis: pick(random, [100, 250, 500, 1000, 2000]),
    memoryMb: pick(random, [128, 256, 512, 1024, 2048]),
    nodeSelector: random() > 0.6 ? { region: pick(random, REGIONS) } : {},
    requiresRegistry: random() > 0.5,
  });
  return { req, nodes };
}

/** Could `n` take one more replica, ignoring scoring? Written independently of the scheduler. */
function fits(n: SchedulerNode, req: ScheduleRequest, cpu: number, mem: number): boolean {
  return (
    n.status === "online" &&
    n.docker &&
    Object.entries(req.nodeSelector).every(([k, v]) => n.labels[k] === v) &&
    (!req.requiresRegistry || n.reachesRegistry) &&
    mem + req.memoryMb <= n.memoryMb &&
    cpu + req.cpuMillis <= n.cpuMillis * CPU_OVERCOMMIT_RATIO
  );
}

describe("schedule properties", () => {
  const CASES = 2000;

  it("only places replicas where they fit, and fails only when nothing fits", () => {
    for (let seed = 0; seed < CASES; seed++) {
      const random = seeded(seed);
      const { req, nodes } = randomCluster(random);
      const result = schedule(req, nodes);
      const cpu = new Map(nodes.map((n) => [n.id, n.allocatedCpuMillis]));
      const mem = new Map(nodes.map((n) => [n.id, n.allocatedMemoryMb]));
      const byId = new Map(nodes.map((n) => [n.id, n]));

      const placed = result.ok ? result.placements : [];
      if (result.ok)
        expect(
          placed.map((p) => p.replica),
          `seed ${seed}`,
        ).toEqual([...Array(req.replicas).keys()]);
      for (const p of placed) {
        const n = byId.get(p.nodeId)!;
        expect(fits(n, req, cpu.get(n.id)!, mem.get(n.id)!), `seed ${seed}`).toBe(true);
        cpu.set(n.id, cpu.get(n.id)! + req.cpuMillis);
        mem.set(n.id, mem.get(n.id)! + req.memoryMb);
      }

      if (!result.ok) {
        expect(SCHEDULE_FAILURE_REASONS).toContain(result.reason);
        if (nodes.length === 0) {
          expect(result.reason).toBe("no_nodes");
          continue;
        }
        // Replay the replicas that did fit, then confirm no node takes the next one.
        const replay = schedule({ ...req, replicas: result.replica }, nodes);
        expect(replay.ok, `seed ${seed}`).toBe(true);
        for (const p of replay.ok ? replay.placements : []) {
          cpu.set(p.nodeId, cpu.get(p.nodeId)! + req.cpuMillis);
          mem.set(p.nodeId, mem.get(p.nodeId)! + req.memoryMb);
        }
        for (const n of nodes) {
          expect(fits(n, req, cpu.get(n.id)!, mem.get(n.id)!), `seed ${seed}`).toBe(false);
        }
        expect(result.rejected.map((r) => r.nodeId)).toEqual(nodes.map((n) => n.id).sort());
      }
    }
  });

  it("is deterministic and independent of node order", () => {
    for (let seed = 0; seed < CASES; seed++) {
      const random = seeded(seed);
      const { req, nodes } = randomCluster(random);
      const expected = schedule(req, nodes);
      expect(schedule(req, nodes), `seed ${seed}`).toEqual(expected);
      expect(schedule(req, shuffle(random, nodes)), `seed ${seed}`).toEqual(expected);
    }
  });

  it("never stacks a replica while an eligible node has fewer of the service", () => {
    for (let seed = 0; seed < CASES; seed++) {
      const random = seeded(seed);
      const { req, nodes } = randomCluster(random);
      const result = schedule(req, nodes);
      if (!result.ok) continue;
      const state = new Map(
        nodes.map((n) => [
          n.id,
          {
            cpu: n.allocatedCpuMillis,
            mem: n.allocatedMemoryMb,
            same: n.serviceReplicas.svc_1 ?? 0,
          },
        ]),
      );
      for (const p of result.placements) {
        const chosen = state.get(p.nodeId)!;
        for (const n of nodes) {
          const s = state.get(n.id)!;
          if (fits(n, req, s.cpu, s.mem))
            expect(chosen.same, `seed ${seed}`).toBeLessThanOrEqual(s.same);
        }
        chosen.cpu += req.cpuMillis;
        chosen.mem += req.memoryMb;
        chosen.same += 1;
      }
    }
  });

  it("is monotonic: more capacity never turns a success into a failure", () => {
    for (let seed = 0; seed < CASES; seed++) {
      const random = seeded(seed);
      const { req, nodes } = randomCluster(random);
      if (!schedule(req, nodes).ok) continue;
      const bigger = nodes.map((n) => ({
        ...n,
        memoryMb: n.memoryMb * 2,
        cpuMillis: n.cpuMillis * 2,
      }));
      expect(schedule(req, bigger).ok, `seed ${seed}`).toBe(true);
    }
  });
});

describe("schedule with volumes (ADR 0004)", () => {
  it("places a pinned replica only on its node", () => {
    const result = schedule(request({ pinnedNodeId: "node_b" }), [node("node_a"), node("node_b")]);
    expect(result).toEqual({ ok: true, placements: [{ replica: 0, nodeId: "node_b" }] });
  });

  it("fails with pinned_elsewhere when the pinned node is offline", () => {
    const result = schedule(request({ pinnedNodeId: "node_b" }), [
      node("node_a"),
      node("node_b", { status: "offline" }),
    ]);
    expect(result).toMatchObject({
      ok: false,
      reason: "pinned_elsewhere",
      rejected: [
        { nodeId: "node_a", reason: "pinned_elsewhere" },
        { nodeId: "node_b", reason: "offline" },
      ],
    });
  });

  it("keeps volume services off agents below the minimum protocol", () => {
    const nodes = [node("node_a", { protocolVersion: 4 }), node("node_b", { protocolVersion: 5 })];
    expect(schedule(request({ minProtocolVersion: 5 }), nodes)).toEqual({
      ok: true,
      placements: [{ replica: 0, nodeId: "node_b" }],
    });
    expect(schedule(request({ minProtocolVersion: 6 }), nodes)).toMatchObject({
      ok: false,
      reason: "agent_outdated",
    });
  });

  it("checks the new volume's quota against the node's disk", () => {
    const nodes = [node("node_a", { diskMb: 10_000, allocatedDiskMb: 8000 })];
    expect(schedule(request({ diskMb: 2000 }), nodes).ok).toBe(true);
    expect(schedule(request({ diskMb: 2001 }), nodes)).toMatchObject({
      ok: false,
      reason: "insufficient_disk",
    });
  });
});

describe("schedule across the mesh (ADR 0005)", () => {
  it("keeps an environment on its node when the mesh isn't ready", () => {
    const result = schedule(request({ replicas: 2, environmentNodeIds: ["b"] }), [
      node("a"),
      node("b"),
    ]);
    expect(result).toEqual({
      ok: true,
      placements: [
        { replica: 0, nodeId: "b" },
        { replica: 1, nodeId: "b" },
      ],
    });
  });

  it("spreads an environment over nodes that are all mesh-ready", () => {
    const result = schedule(request({ replicas: 2, environmentNodeIds: ["b"] }), [
      node("a", { meshReady: true }),
      node("b", { meshReady: true }),
    ]);
    expect(result.ok && result.placements.map((p) => p.nodeId).sort()).toEqual(["a", "b"]);
  });

  it("refuses a ready node when the environment lives on an unready one", () => {
    const result = schedule(request({ environmentNodeIds: ["b"], nodeSelector: { pick: "a" } }), [
      node("a", { meshReady: true, labels: { pick: "a" } }),
      node("b", { meshReady: false }),
    ]);
    expect(result).toMatchObject({ ok: false, reason: "mesh_unready" });
  });

  it("counts the replicas it places itself", () => {
    // A brand-new environment lands on one node unless the mesh is ready.
    const result = schedule(request({ replicas: 2, environmentNodeIds: [] }), [
      node("a"),
      node("b"),
    ]);
    expect(result.ok && new Set(result.placements.map((p) => p.nodeId)).size).toBe(1);
  });

  it("ignores hosts it doesn't know, such as removed nodes", () => {
    const result = schedule(request({ environmentNodeIds: ["gone"] }), [
      node("a", { meshReady: true }),
    ]);
    expect(result).toEqual({ ok: true, placements: [{ replica: 0, nodeId: "a" }] });
  });

  it("is unchanged when the request names no environment nodes", () => {
    const result = schedule(request({ replicas: 2 }), [node("a"), node("b")]);
    expect(result.ok && result.placements.map((p) => p.nodeId).sort()).toEqual(["a", "b"]);
  });
});

describe("schedule while draining and across zones (ADR 0005)", () => {
  it("never places on an excluded node, and says so", () => {
    const result = schedule(request({ excludeNodeIds: ["a"] }), [node("a"), node("b")]);
    expect(result.ok && result.placements).toEqual([{ replica: 0, nodeId: "b" }]);
    const only = schedule(request({ excludeNodeIds: ["a"] }), [node("a")]);
    expect(only).toMatchObject({ ok: false, reason: "excluded" });
  });

  it("orders excluded right after offline, so a dead excluded node reads offline", () => {
    expect(SCHEDULE_FAILURE_REASONS.indexOf("excluded")).toBe(
      SCHEDULE_FAILURE_REASONS.indexOf("offline") + 1,
    );
    const result = schedule(request({ excludeNodeIds: ["a"] }), [
      node("a"),
      node("b", { status: "offline" }),
    ]);
    expect(result).toMatchObject({
      ok: false,
      reason: "excluded",
      rejected: [
        { nodeId: "a", reason: "excluded" },
        { nodeId: "b", reason: "offline" },
      ],
    });
  });

  it("spreads replicas across zones before doubling up inside one", () => {
    const zoned = (id: string, zone: string, replicas = 0) =>
      node(id, { zone, serviceReplicas: replicas ? { svc_1: replicas } : {} });
    // a and b share zone-1, which already runs one replica on a.
    const result = schedule(request(), [
      zoned("a", "zone-1", 1),
      zoned("b", "zone-1"),
      zoned("c", "zone-2"),
    ]);
    expect(result.ok && result.placements).toEqual([{ replica: 0, nodeId: "c" }]);
  });

  it("counts the zone's replicas it places itself", () => {
    const nodes = [
      node("a", { zone: "z1" }),
      node("b", { zone: "z1" }),
      node("c", { zone: "z2" }),
      node("d", { zone: "z2" }),
    ];
    const result = schedule(request({ replicas: 2 }), nodes);
    const zones = result.ok ? result.placements.map((p) => (p.nodeId < "c" ? "z1" : "z2")) : [];
    expect(zones.sort()).toEqual(["z1", "z2"]);
  });

  it("treats nodes without a zone as before", () => {
    const result = schedule(request({ replicas: 2 }), [node("a"), node("b", { zone: null })]);
    expect(result.ok && result.placements.map((p) => p.nodeId).sort()).toEqual(["a", "b"]);
  });

  it("is deterministic with zones and exclusions in any node order", () => {
    const rand = seeded(7);
    for (let run = 0; run < 50; run++) {
      const nodes = Array.from({ length: int(rand, 2, 6) }, (_, i) =>
        node(`n${i}`, {
          zone: pick(rand, ["z1", "z2", null]),
          serviceReplicas: { svc_1: int(rand, 0, 2) },
        }),
      );
      const req = request({ replicas: int(rand, 1, 3), excludeNodeIds: [nodes[0]!.id] });
      expect(schedule(req, shuffle(rand, nodes))).toEqual(schedule(req, nodes));
    }
  });
});

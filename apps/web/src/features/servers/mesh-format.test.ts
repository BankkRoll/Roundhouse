import { describe, expect, it } from "vitest";
import type { Mesh, MeshNode } from "../../lib/api/mesh-client";
import { MESH_SEED, seededMesh, unjoinedMeshNode } from "../../mocks/mesh-db";
import {
  DIAGRAM_SIZE,
  DOCKER_FWMARK_SETTING,
  formatHandshake,
  handshakeHealth,
  meshChecks,
  meshNodeState,
  meshRoutedNodes,
  pairsOf,
  ringLayout,
} from "./mesh-format";

const NOW = 1_800_000_000_000;

function meshNode(id: string, fields: Partial<MeshNode> = {}): MeshNode {
  const state = seededMesh(NOW).nodes[id] ?? unjoinedMeshNode({ agent_version: "0.5.0" });
  return { ...state, id, name: id, status: "online", ...fields };
}

function mesh(fields: Partial<Mesh> = {}): Mesh {
  const seeded = seededMesh(NOW);
  return {
    enabled: true,
    supernet: "10.200.0.0/16",
    nodes: Object.keys(seeded.nodes).map((id) => meshNode(id)),
    pairs: seeded.pairs,
    ...fields,
  };
}

const check = (node: MeshNode, id: string) => meshChecks(node).find((c) => c.id === id);

describe("meshNodeState", () => {
  it("goes from the most specific state to ready", () => {
    expect(meshNodeState(meshNode("x", { supported: false }))).toBe("unsupported");
    expect(meshNodeState(meshNode("x"))).toBe("not_joined");
    expect(meshNodeState(meshNode(MESH_SEED.hel, { rotating: true }))).toBe("rotating");
    expect(meshNodeState(meshNode(MESH_SEED.office))).toBe("error");
    expect(
      meshNodeState(meshNode(MESH_SEED.hel, { ready: false, status_at: null, error: null })),
    ).toBe("waiting");
    expect(meshNodeState(meshNode(MESH_SEED.hel))).toBe("ready");
  });
});

describe("meshChecks", () => {
  it("stops at the agent when it predates the mesh", () => {
    const checks = meshChecks(meshNode("x", { supported: false }));
    expect(checks).toEqual([expect.objectContaining({ id: "agent", state: "failed" })]);
  });

  it("asks nftables hosts for the daemon.json fwmark setting", () => {
    const firewall = check(meshNode(MESH_SEED.office), "firewall");
    expect(firewall).toMatchObject({ state: "failed", snippet: DOCKER_FWMARK_SETTING });
    expect(firewall?.fix).toContain("/etc/docker/daemon.json");
    expect(DOCKER_FWMARK_SETTING).toBe(`"bridge-accept-fwmark": "0x2000000/0x2000000"`);
  });

  it("leaves the iptables rule to the agent", () => {
    const firewall = check(meshNode(MESH_SEED.hel, { accept_fwmark: false }), "firewall");
    expect(firewall).toMatchObject({ state: "failed" });
    expect(firewall).not.toHaveProperty("snippet");
    expect(firewall?.fix).toMatch(/agent adds this rule itself/);
  });

  it("names the port to open or forward", () => {
    expect(check(meshNode(MESH_SEED.hel), "reachability")?.fix).toMatch(
      /UDP 51820 must stay open in the host firewall and in the cloud provider's firewall/,
    );
    expect(check(meshNode(MESH_SEED.home, { listen_port: 51999 }), "reachability")).toMatchObject({
      state: "warning",
      fix: expect.stringContaining("forward UDP 51999"),
    });
  });

  it("explains a missing WireGuard and a userspace fallback", () => {
    expect(check(meshNode(MESH_SEED.hel, { mode: "unavailable" }), "interface")).toMatchObject({
      state: "failed",
      snippet: "modprobe wireguard",
    });
    expect(check(meshNode(MESH_SEED.nbg), "interface")?.detail).toMatch(/wireguard-go/);
  });

  it("reports pending checks before the agent's first report", () => {
    const checks = meshChecks(meshNode("x"));
    expect(checks.map((c) => c.state)).toEqual(["ok", "pending", "pending", "pending", "pending"]);
  });
});

describe("handshakes", () => {
  it("is stale past three minutes", () => {
    expect(handshakeHealth(null, NOW)).toBe("never");
    expect(handshakeHealth(NOW - 179_000, NOW)).toBe("fresh");
    expect(handshakeHealth(NOW - 181_000, NOW)).toBe("stale");
    expect(formatHandshake(null, NOW)).toBe("never");
    expect(formatHandshake(NOW - 42_000, NOW)).toBe("42s ago");
  });
});

describe("pairsOf", () => {
  it("lists a server's pairs with the other side", () => {
    const peers = pairsOf(mesh(), MESH_SEED.home).map((p) => p.peerId);
    expect(peers.sort()).toEqual(
      [MESH_SEED.hel, MESH_SEED.nbg, MESH_SEED.lab, MESH_SEED.office].sort(),
    );
  });
});

describe("meshRoutedNodes", () => {
  it("counts ready servers with a working pair to a ready replica", () => {
    expect([...meshRoutedNodes(mesh(), [MESH_SEED.hel])].sort()).toEqual(
      [MESH_SEED.home, MESH_SEED.lab, MESH_SEED.nbg].sort(),
    );
    // nbg-1 ↔ lab-1 is down, so lab-1 can't reach a replica that only runs on nbg-1.
    expect([...meshRoutedNodes(mesh(), [MESH_SEED.nbg])].sort()).toEqual(
      [MESH_SEED.hel, MESH_SEED.home].sort(),
    );
  });

  it("routes nothing while the mesh is off or from a broken server", () => {
    expect(meshRoutedNodes(mesh({ enabled: false }), [MESH_SEED.hel]).size).toBe(0);
    expect(meshRoutedNodes(mesh(), [MESH_SEED.office]).size).toBe(0);
  });
});

describe("ringLayout", () => {
  it("starts at the top and keeps every server inside the drawing", () => {
    const points = ringLayout(["a", "b", "c", "d"]);
    expect(points[0]).toMatchObject({ id: "a", x: DIAGRAM_SIZE / 2 });
    expect(points[0]!.y).toBeLessThan(DIAGRAM_SIZE / 2);
    for (const point of points) {
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(DIAGRAM_SIZE);
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(DIAGRAM_SIZE);
    }
    expect(ringLayout(["solo"])).toEqual([{ id: "solo", x: 200, y: 200 }]);
  });
});

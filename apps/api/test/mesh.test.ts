/**
 * The WireGuard mesh on the control plane (ADR 0005): the pure path and
 * peer planning, nodes joining through `hello.mesh`, sealed preshared keys,
 * mesh IPs and private names in desired state, route-only workloads,
 * `mesh_status` health, key rotation, the scheduler's view, the routes and
 * their RBAC.
 */
import { env } from "cloudflare:test";
import {
  createDb,
  deployments,
  domains,
  environments,
  meshPaths,
  meshPsks,
  nodes,
  placements,
} from "@roundhouse/db";
import {
  CREDENTIAL_FRAME_TTL_MS,
  type DesiredState,
  type JoinResponse,
  PROTOCOL_VERSION,
} from "@roundhouse/protocol";
import { ACTIONS, AUDIT_ACTIONS, newId } from "@roundhouse/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MESH_ROUTES, policyOf } from "../src/contracts";
import { buildDesiredState, routeWorkloadId, sealDeploymentEnv } from "../src/lib/desired-state";
import {
  choosePaths,
  MESH_ACTIVATE_AFTER_MS,
  MESH_DIRECT_GRACE_MS,
  MESH_KEY_MAX_AGE_MS,
  meshEndpoint,
  type PeerNode,
  pairKey,
  peerEntries,
  progressRotations,
} from "../src/lib/mesh";
import { schedulerSnapshot } from "../src/lib/scheduling";
import { projectKey } from "../src/lib/variables";
import { addMember, type Client, eventually, install, joinNode } from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  createService,
  type FakeWorkloadAgent,
} from "./pipeline-helpers";

// Test-only WireGuard public keys (32 bytes each, never real keys).
const KEY_A = btoa(String.fromCharCode(...new Uint8Array(32).fill(0xa1)));
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(0xb2)));
const KEY_C = btoa(String.fromCharCode(...new Uint8Array(32).fill(0xc3)));
const KEY_NEXT = btoa(String.fromCharCode(...new Uint8Array(32).fill(0xd4)));

// -----------------------------------------------------------------------------
// Pure planning
// -----------------------------------------------------------------------------

describe("mesh path planning", () => {
  const n = (id: string, endpoint: string | null, labels: Record<string, string> = {}) => ({
    id,
    endpoint,
    labels,
  });

  it.each([
    ["both public", "1.1.1.1:51820", "2.2.2.2:51820", "direct"],
    ["one public", "1.1.1.1:51820", null, "direct"],
    ["both behind NAT, no relay", null, null, "down"],
  ])("%s: %s", (_name, ea, eb, path) => {
    const chosen = choosePaths([n("a", ea), n("b", eb)], new Map());
    expect(chosen.get(pairKey("a", "b"))).toEqual({ path, relay: null });
  });

  it("relays two NAT nodes through a public one, preferring the relay label", () => {
    const nodes = [
      n("a", null),
      n("b", null),
      n("c", "3.3.3.3:51820"),
      n("d", "4.4.4.4:51820", { "roundhouse.io/mesh-relay": "true" }),
    ];
    const chosen = choosePaths(nodes, new Map());
    expect(chosen.get("a|b")).toEqual({ path: "relayed", relay: "d" });
    // Without the label the lowest ID wins.
    const unlabelled = choosePaths(nodes.slice(0, 3), new Map());
    expect(unlabelled.get("a|b")).toEqual({ path: "relayed", relay: "c" });
  });

  it("keeps a stored relayed fallback of a direct pair while a relay exists", () => {
    const nodes = [n("a", "1.1.1.1:51820"), n("b", null), n("c", "3.3.3.3:51820")];
    const stored = new Map([["a|b", { path: "relayed" as const, relayNodeId: "c" }]]);
    expect(choosePaths(nodes, stored).get("a|b")).toEqual({ path: "relayed", relay: "c" });
    expect(choosePaths(nodes.slice(0, 2), stored).get("a|b")).toEqual({
      path: "direct",
      relay: null,
    });
  });

  it("is deterministic in any input order", () => {
    const nodes = [n("c", "3.3.3.3:51820"), n("a", null), n("b", null)];
    const one = [...choosePaths(nodes, new Map())];
    const two = [...choosePaths([...nodes].reverse(), new Map())];
    expect(one.sort()).toEqual(two.sort());
  });

  it("gives each side the right endpoint, keepalive and allowed IPs", () => {
    const peer = (
      id: string,
      meshIndex: number,
      endpoint: string | null,
      publicKey: string,
    ): PeerNode => ({ id, meshIndex, endpoint, labels: {}, publicKey });
    const a = peer("a", 1, null, KEY_A);
    const b = peer("b", 2, null, KEY_B);
    const c = peer("c", 3, "3.3.3.3:51820", KEY_C);
    const all = [a, b, c];
    const paths = choosePaths(all, new Map());
    const supernet = "10.200.0.0/16";

    const forA = peerEntries(a, all, paths, supernet);
    expect(forA.peers).toEqual([
      {
        node_id: "c",
        public_key: KEY_C,
        endpoint: "3.3.3.3:51820",
        allowed_ips: ["10.200.3.0/24", "10.200.2.0/24"],
        keepalive_s: 25,
      },
    ]);
    expect(forA.forwardPairs).toEqual([]);

    const forC = peerEntries(c, all, paths, supernet);
    expect(forC.peers).toEqual([
      {
        node_id: "a",
        public_key: KEY_A,
        endpoint: null,
        allowed_ips: ["10.200.1.0/24"],
        keepalive_s: 0,
      },
      {
        node_id: "b",
        public_key: KEY_B,
        endpoint: null,
        allowed_ips: ["10.200.2.0/24"],
        keepalive_s: 0,
      },
    ]);
    expect(forC.forwardPairs).toEqual([["10.200.1.0/24", "10.200.2.0/24"]]);
  });

  it("derives the endpoint from the override, else the observed address of a public node", () => {
    const report = { nat: "public" as const, endpoint_override: null, listen_port: 51820 };
    expect(meshEndpoint(report, "203.0.113.4")).toBe("203.0.113.4:51820");
    expect(meshEndpoint(report, "2001:db8::4")).toBe("[2001:db8::4]:51820");
    expect(meshEndpoint(report, null)).toBeNull();
    expect(meshEndpoint({ ...report, nat: "nat" }, "203.0.113.4")).toBeNull();
    expect(
      meshEndpoint({ ...report, nat: "nat", endpoint_override: "vpn.example.com:4500" }, null),
    ).toBe("vpn.example.com:4500");
  });
});

// -----------------------------------------------------------------------------
// Joining and desired state
// -----------------------------------------------------------------------------

/** `hello.mesh` of a test agent. */
function meshHello(publicKey: string, endpoint: string | null) {
  return {
    protocol_version: PROTOCOL_VERSION,
    mesh: {
      public_key: publicKey,
      listen_port: 51820,
      mode: "kernel",
      nat: endpoint ? "public" : "nat",
      endpoint_override: endpoint,
      docker_firewall: "iptables",
      accept_fwmark: true,
    },
  };
}

async function enableMesh(owner: Client) {
  const res = await owner.json<{ mesh_enabled: boolean }>("/v1/instance/settings", {
    method: "PATCH",
    json: { mesh_enabled: true },
  });
  expect(res.status).toBe(200);
  expect(res.body.mesh_enabled).toBe(true);
}

/** Latest desired state whose mesh lists `count` peers. */
function meshWithPeers(agent: FakeWorkloadAgent, count: number): Promise<DesiredState> {
  return eventually(async () => {
    const d = agent.desired();
    return d?.mesh && d.mesh.peers.length === count ? d : undefined;
  });
}

interface MeshStage {
  owner: Client;
  workspaceId: string;
  a: { joined: JoinResponse; agent: FakeWorkloadAgent };
  b: { joined: JoinResponse; agent: FakeWorkloadAgent };
}

/** Two meshed nodes: `a` public, `b` behind NAT. */
async function meshStage(): Promise<MeshStage> {
  const { owner, workspaceId } = await install();
  await enableMesh(owner);
  const ja = await joinNode(owner, workspaceId, { name: "a", hostname: "a" });
  const aa = await connectWorkloadAgent(ja, {}, meshHello(KEY_A, "198.51.100.1:51820"));
  const jb = await joinNode(owner, workspaceId, { name: "b", hostname: "b" });
  const ab = await connectWorkloadAgent(jb, {}, meshHello(KEY_B, null));
  return { owner, workspaceId, a: { joined: ja, agent: aa }, b: { joined: jb, agent: ab } };
}

describe("joining the mesh", () => {
  it("gives each node a /24 and the other as a peer, with one sealed preshared key per pair", async () => {
    const s = await meshStage();
    const da = await meshWithPeers(s.a.agent, 1);
    const db = await meshWithPeers(s.b.agent, 1);

    expect(da.mesh).toMatchObject({
      supernet: "10.200.0.0/16",
      node_index: 1,
      address: "10.200.1.1",
      dns_address: "10.200.1.2",
      listen_port: 51820,
      mtu: 1420,
      accept_fwmark: 0x2000000,
      rotate_key: false,
      activate_epoch: null,
      forward_pairs: [],
      node_addresses: ["10.200.1.1", "10.200.2.1"],
    });
    // The public side learns the NAT side's address by roaming.
    expect(da.mesh!.peers).toEqual([
      {
        node_id: s.b.joined.node_id,
        public_key: KEY_B,
        endpoint: null,
        allowed_ips: ["10.200.2.0/24"],
        keepalive_s: 0,
      },
    ]);
    expect(db.mesh!.peers).toEqual([
      {
        node_id: s.a.joined.node_id,
        public_key: KEY_A,
        endpoint: "198.51.100.1:51820",
        allowed_ips: ["10.200.1.0/24"],
        keepalive_s: 25,
      },
    ]);

    // Credential-bearing: 60 s TTL, and both sides open the same key.
    expect(da.exp - da.iat).toBe(CREDENTIAL_FRAME_TTL_MS);
    const pa = s.a.agent.psks(da.generation)!;
    const pb = s.b.agent.psks(db.generation)!;
    expect(pa[s.b.joined.node_id]).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(pa[s.b.joined.node_id]).toBe(pb[s.a.joined.node_id]);
    expect(s.a.agent.rejected).toEqual([]);
    expect(s.b.agent.rejected).toEqual([]);

    // At rest the key is sealed under the KEK, never stored in the clear.
    const stored = await createDb(env.DB).select().from(meshPsks);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0]!.pskSealed)).not.toContain(pa[s.b.joined.node_id]!);

    const audit = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE action = 'node.mesh_joined'",
    ).all();
    expect(audit.results).toHaveLength(2);
  });

  it("sends mesh null while the mesh is off, and refuses a new supernet once a node joined", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectWorkloadAgent(joined, {}, meshHello(KEY_A, null));
    expect(agent.desired()!.mesh).toBeNull();

    const supernet = await owner.json("/v1/instance/settings", {
      method: "PATCH",
      json: { mesh_supernet: "10.77.0.0/16" },
    });
    expect(supernet.status).toBe(200);
    const docker = await owner.json("/v1/instance/settings", {
      method: "PATCH",
      json: { mesh_supernet: "172.17.0.0/16" },
    });
    expect(docker.status).toBe(400);

    await enableMesh(owner);
    const meshed = await eventually(async () => agent.desired()?.mesh ?? undefined);
    expect(meshed.address).toBe("10.77.1.1");
    const locked = await owner.json<{ error: { code: string } }>("/v1/instance/settings", {
      method: "PATCH",
      json: { mesh_supernet: "10.78.0.0/16" },
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("mesh_supernet_locked");
  });

  it("never meshes an agent that reports wg0 unavailable", async () => {
    const { owner, workspaceId } = await install();
    await enableMesh(owner);
    const joined = await joinNode(owner, workspaceId);
    const hello = meshHello(KEY_A, null);
    const agent = await connectWorkloadAgent(
      joined,
      {},
      {
        ...hello,
        mesh: { ...hello.mesh, mode: "unavailable" },
      },
    );
    expect(agent.desired()!.mesh).toBeNull();
    const [row] = await createDb(env.DB).select().from(nodes).where(eq(nodes.id, joined.node_id));
    expect(row!.meshIndex).toBeNull();
    expect(row!.wgPubkey).toBe(KEY_A);
  });
});

// -----------------------------------------------------------------------------
// Workloads across nodes
// -----------------------------------------------------------------------------

/** Inserts a live deployment of `serviceId` with replicas on the given nodes. */
async function liveDeployment(
  projectId: string,
  workspaceId: string,
  serviceId: string,
  environmentId: string,
  nodeIds: string[],
  state: "healthy" | "crashed" = "healthy",
) {
  const db = createDb(env.DB);
  const id = newId("deployment");
  const key = await projectKey(db, env, projectId);
  await db.insert(deployments).values({
    id,
    serviceId,
    environmentId,
    configVersion: 1,
    image: "nginx:1.27",
    status: "active",
    trigger: "manual",
    envSealed: await sealDeploymentEnv(
      key,
      { workspaceId, projectId, deploymentId: id },
      { env: { GREETING: "hi" }, files: {} },
    ),
  });
  const workloadIds: string[] = [];
  for (const [replica, nodeId] of nodeIds.entries()) {
    const workloadId = newId("workload");
    workloadIds.push(workloadId);
    await db.insert(placements).values({
      id: newId("placement"),
      deploymentId: id,
      replica,
      nodeId,
      workloadId,
      state,
    });
  }
  return { id, workloadIds };
}

describe("workloads on a meshed cluster", () => {
  async function clusterStage() {
    const s = await meshStage();
    await meshWithPeers(s.a.agent, 1);
    const project = await createProject(s.owner, s.workspaceId);
    const prod = project.environments[0]!.id;
    const staging = await s.owner.json<{ id: string }>(`/v1/projects/${project.id}/environments`, {
      method: "POST",
      json: { name: "staging", kind: "staging" },
    });
    const web = await createService(s.owner, project.id, {
      name: "web",
      source: { type: "image", image: "nginx:1.27" },
      config: { networking: { port: 8080 } },
    });
    const dbService = await createService(s.owner, project.id, {
      name: "db",
      source: { type: "image", image: "postgres:18" },
      config: { networking: { port: 5432 } },
    });
    const a = s.a.joined.node_id;
    const b = s.b.joined.node_id;
    // production: web on a, db on b; staging: web on b.
    const prodWeb = await liveDeployment(project.id, s.workspaceId, web.service.id, prod, [a]);
    const prodDb = await liveDeployment(project.id, s.workspaceId, dbService.service.id, prod, [b]);
    const stagingWeb = await liveDeployment(
      project.id,
      s.workspaceId,
      web.service.id,
      staging.body.id,
      [b],
    );
    await createDb(env.DB)
      .insert(domains)
      .values({
        id: newId("domain"),
        serviceId: web.service.id,
        environmentId: prod,
        hostname: "shop.example.com",
        type: "custom",
        targetPort: 8080,
        verificationStatus: "verified",
      });
    return {
      ...s,
      project,
      prod,
      staging: staging.body.id,
      web,
      dbService,
      prodWeb,
      prodDb,
      stagingWeb,
    };
  }

  it("gives replicas mesh IPs and lists only the environments each node runs", async () => {
    const c = await clusterStage();
    const db = createDb(env.DB);
    const forA = (await buildDesiredState(db, env, c.a.joined.node_id))!;
    const forB = (await buildDesiredState(db, env, c.b.joined.node_id))!;

    const webOnA = forA.workloads.find((w) => w.id === c.prodWeb.workloadIds[0])!;
    expect(webOnA).toMatchObject({ kind: "service", mesh_ip: "10.200.1.10", private_dns: true });
    const tags = await db
      .select({ id: environments.id, tag: environments.netTag })
      .from(environments);
    const tagOf = new Map(tags.map((t) => [t.id, t.tag]));
    expect(tagOf.get(c.prod)).not.toBe(tagOf.get(c.staging));

    // a runs production only: it learns b's production db, never staging.
    const slug = c.project.slug;
    expect(forA.mesh!.addresses).toEqual([
      {
        ip: "10.200.1.10",
        env_tag: tagOf.get(c.prod),
        node_id: c.a.joined.node_id,
        routed_ports: [8080],
        private_domain: `web.production.${slug}.internal`,
        healthy: true,
      },
      {
        ip: "10.200.2.10",
        env_tag: tagOf.get(c.prod),
        node_id: c.b.joined.node_id,
        routed_ports: [],
        private_domain: `db.production.${slug}.internal`,
        healthy: true,
      },
    ]);
    // b runs both: production's db and web, and staging's web.
    expect(forB.mesh!.addresses.map((x) => [x.private_domain, x.env_tag]).sort()).toEqual(
      [
        [`db.production.${slug}.internal`, tagOf.get(c.prod)],
        [`web.production.${slug}.internal`, tagOf.get(c.prod)],
        [`web.staging.${slug}.internal`, tagOf.get(c.staging)],
      ].sort(),
    );
  });

  it("routes a hostname on an ingress node without a replica through the mesh", async () => {
    const c = await clusterStage();
    const db = createDb(env.DB);
    const forB = (await buildDesiredState(db, env, c.b.joined.node_id))!;
    const route = forB.workloads.find((w) => w.kind === "route")!;
    expect(route).toMatchObject({
      id: routeWorkloadId(c.web.service.id, c.prod),
      environment_id: c.prod,
      service_id: c.web.service.id,
      env_sealed: null,
      routes: [expect.objectContaining({ hostname: "shop.example.com", container_port: 8080 })],
      upstreams: [{ ip: "10.200.1.10", port: 8080 }],
    });
    // a routes it from its own replica, as before.
    const forA = (await buildDesiredState(db, env, c.a.joined.node_id))!;
    expect(forA.workloads.some((w) => w.kind === "route")).toBe(false);
    expect(forA.workloads.find((w) => w.id === c.prodWeb.workloadIds[0])!.routes).toMatchObject([
      { hostname: "shop.example.com", container_port: 8080 },
    ]);
  });

  it("gives a node with a local replica its remote replicas as failover upstreams", async () => {
    const c = await clusterStage();
    const db = createDb(env.DB);
    // A second production web replica on b.
    const both = await liveDeployment(c.project.id, c.workspaceId, c.web.service.id, c.prod, [
      c.a.joined.node_id,
      c.b.joined.node_id,
    ]);
    await db.update(deployments).set({ status: "removed" }).where(eq(deployments.id, c.prodWeb.id));
    const forA = (await buildDesiredState(db, env, c.a.joined.node_id))!;
    const local = forA.workloads.find((w) => w.id === both.workloadIds[0])!;
    const route = forA.workloads.find((w) => w.kind === "route")!;
    expect(local.routes.map((r) => r.hostname)).toEqual(["shop.example.com"]);
    // Only the other node's replica: the agent prefers the local one.
    expect(route.upstreams).toEqual([{ ip: "10.200.2.12", port: 8080 }]);
    expect(route.upstreams!.some((u) => u.ip === local.mesh_ip)).toBe(false);
  });

  it("frees a mesh IP when its deployment stops being live", async () => {
    const c = await clusterStage();
    const db = createDb(env.DB);
    await buildDesiredState(db, env, c.a.joined.node_id);
    await db.update(deployments).set({ status: "removed" }).where(eq(deployments.id, c.prodWeb.id));
    const next = await liveDeployment(c.project.id, c.workspaceId, c.web.service.id, c.prod, [
      c.a.joined.node_id,
    ]);
    const forA = (await buildDesiredState(db, env, c.a.joined.node_id))!;
    expect(forA.workloads.find((w) => w.id === next.workloadIds[0])!.mesh_ip).toBe("10.200.1.10");
    const [old] = await db
      .select({ meshIp: placements.meshIp })
      .from(placements)
      .where(eq(placements.deploymentId, c.prodWeb.id));
    expect(old!.meshIp).toBeNull();
  });

  it("offers ready meshed nodes to the scheduler", async () => {
    const c = await clusterStage();
    const db = createDb(env.DB);
    const before = await schedulerSnapshot(db, {
      workspaceId: c.workspaceId,
      registryNodeId: null,
    });
    expect(before.nodes.every((n) => n.meshReady === false)).toBe(true);
    await db.update(nodes).set({ meshReady: true }).where(eq(nodes.workspaceId, c.workspaceId));
    const after = await schedulerSnapshot(db, { workspaceId: c.workspaceId, registryNodeId: null });
    expect(after.nodes.every((n) => n.meshReady === true)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Health and rotation
// -----------------------------------------------------------------------------

describe("mesh health", () => {
  it("records readiness and handshakes, and shows the pair as direct", async () => {
    const s = await meshStage();
    await meshWithPeers(s.b.agent, 1);
    const a = s.a.joined.node_id;
    const b = s.b.joined.node_id;
    const now = Date.now();
    s.a.agent.send({
      type: "mesh_status",
      epoch: 0,
      ready: true,
      peers: [
        {
          node_id: b,
          last_handshake_ms: now - 1000,
          endpoint: "192.0.2.9:40000",
          rx_bytes: 10,
          tx_bytes: 20,
        },
      ],
    });
    s.b.agent.send({
      type: "mesh_status",
      epoch: 0,
      ready: true,
      peers: [
        {
          node_id: a,
          last_handshake_ms: now - 500,
          endpoint: "198.51.100.1:51820",
          rx_bytes: 20,
          tx_bytes: 10,
        },
      ],
    });
    const mesh = await eventually(async () => {
      const res = await s.owner.json<{
        nodes: { id: string; ready: boolean }[];
        pairs: { path: string; sides: unknown[]; last_handshake_at: number | null }[];
      }>(`/v1/workspaces/${s.workspaceId}/mesh`);
      return res.body.pairs[0]?.sides.length === 2 ? res.body : undefined;
    });
    expect(mesh.nodes.every((n) => n.ready)).toBe(true);
    expect(mesh.pairs[0]).toMatchObject({ path: "direct", last_handshake_at: now - 500 });
  });

  it("falls back to a relay when a direct pair never handshakes", async () => {
    const { owner, workspaceId } = await install();
    await enableMesh(owner);
    const agents: Record<string, { joined: JoinResponse; agent: FakeWorkloadAgent }> = {};
    for (const [name, key, endpoint] of [
      ["a", KEY_A, "198.51.100.1:51820"],
      ["b", KEY_B, null],
      ["c", KEY_C, "198.51.100.3:51820"],
    ] as const) {
      const joined = await joinNode(owner, workspaceId, { name, hostname: name });
      agents[name] = {
        joined,
        agent: await connectWorkloadAgent(joined, {}, meshHello(key, endpoint)),
      };
    }
    const a = agents.a!.joined.node_id;
    const b = agents.b!.joined.node_id;
    const c = agents.c!.joined.node_id;
    await meshWithPeers(agents.b!.agent, 2);
    const db = createDb(env.DB);
    await db.update(nodes).set({ meshReady: true }).where(eq(nodes.workspaceId, workspaceId));
    // The a–b pair was configured long enough ago to have handshaken.
    await db
      .update(meshPaths)
      .set({ configuredAt: new Date(Date.now() - MESH_DIRECT_GRACE_MS - 1000) })
      .where(eq(meshPaths.pairKey, pairKey(a, b)));
    agents.a!.agent.send({ type: "mesh_status", epoch: 0, ready: true, peers: [] });
    const relayed = await eventually(async () => {
      const d = agents.b!.agent.desired();
      const viaC = d?.mesh?.peers.find((p) => p.node_id === c);
      return viaC && viaC.allowed_ips.length === 2 ? d : undefined;
    });
    expect(relayed.mesh!.peers.map((p) => p.node_id)).toEqual([c]);
    expect(relayed.mesh!.peers[0]!.allowed_ips.sort()).toEqual(["10.200.1.0/24", "10.200.3.0/24"]);
    const forC = await eventually(async () => {
      const d = agents.c!.agent.desired();
      return d?.mesh?.forward_pairs.length ? d : undefined;
    });
    expect(forC.mesh!.forward_pairs).toEqual([["10.200.1.0/24", "10.200.2.0/24"]]);
  });
});

describe("key rotation", () => {
  it("rotates a node's key through mesh_key and activation", async () => {
    const s = await meshStage();
    await meshWithPeers(s.b.agent, 1);
    const a = s.a.joined.node_id;
    const db = createDb(env.DB);
    const before = s.b.agent.psks(s.b.agent.desired()!.generation)![a];

    const started = await s.owner.json<{ rotating: boolean }>(
      `/v1/workspaces/${s.workspaceId}/nodes/${a}/mesh/rotate-key`,
      { method: "POST" },
    );
    expect(started.status).toBe(202);
    expect(started.body.rotating).toBe(true);
    const busy = await s.owner.json<{ error: { code: string } }>(
      `/v1/workspaces/${s.workspaceId}/nodes/${s.b.joined.node_id}/mesh/rotate-key`,
      { method: "POST" },
    );
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("mesh_rotation_in_progress");

    await eventually(async () => s.a.agent.desired()?.mesh?.rotate_key || undefined);
    s.a.agent.send({ type: "mesh_key", public_key: KEY_NEXT, epoch: 1 });
    // Peers switch to the new key, with a new preshared key.
    const switched = await eventually(async () => {
      const d = s.b.agent.desired();
      return d?.mesh?.peers[0]?.public_key === KEY_NEXT ? d : undefined;
    });
    expect(s.b.agent.psks(switched.generation)![a]).not.toBe(before);
    await eventually(async () =>
      s.a.agent.desired()?.mesh?.rotate_key === false ? true : undefined,
    );

    // Activation once the peers had their time.
    await db
      .update(nodes)
      .set({ meshRotateAnnouncedAt: new Date(Date.now() - MESH_ACTIVATE_AFTER_MS - 1) })
      .where(eq(nodes.id, a));
    await progressRotations(db, async () => {}, {});
    const [row] = await db.select().from(nodes).where(eq(nodes.id, a));
    expect(row!.meshActivateEpoch).toBe(1);

    s.a.agent.send({ type: "mesh_status", epoch: 1, ready: true, peers: [] });
    const done = await eventually(async () => {
      const [r] = await db.select().from(nodes).where(eq(nodes.id, a));
      return r!.wgPubkeyNext === null && r!.wgKeyEpoch === 1 ? r : undefined;
    });
    expect(done).toMatchObject({ wgPubkey: KEY_NEXT, meshRotateRequestedAt: null });
  });

  it("ignores a mesh_key nobody asked for", async () => {
    const s = await meshStage();
    await meshWithPeers(s.a.agent, 1);
    s.a.agent.send({ type: "mesh_key", public_key: KEY_NEXT, epoch: 1 });
    // A heartbeat after it proves the frame was handled.
    const db = createDb(env.DB);
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await db.select().from(nodes).where(eq(nodes.id, s.a.joined.node_id));
    expect(row!.wgPubkeyNext).toBeNull();
    expect(row!.wgPubkey).toBe(KEY_A);
  });

  it("starts the 90-day rotation, one node of a workspace at a time", async () => {
    const s = await meshStage();
    await meshWithPeers(s.a.agent, 1);
    const db = createDb(env.DB);
    await db
      .update(nodes)
      .set({ wgKeyRotatedAt: new Date(Date.now() - MESH_KEY_MAX_AGE_MS - 1) })
      .where(eq(nodes.workspaceId, s.workspaceId));
    const refreshed: string[] = [];
    await progressRotations(db, async (ids) => void refreshed.push(...ids), { scheduled: true });
    const rotating = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, s.workspaceId)));
    const started = (
      await db.select().from(nodes).where(eq(nodes.workspaceId, s.workspaceId))
    ).filter((n) => n.meshRotateRequestedAt !== null);
    expect(rotating).toHaveLength(2);
    expect(started).toHaveLength(1);
    expect(refreshed).toEqual([started[0]!.id]);
  });
});

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

describe("mesh routes", () => {
  it("declares known actions and audits", () => {
    for (const [name, r] of Object.entries(MESH_ROUTES)) {
      const p = policyOf(r);
      expect(ACTIONS, name).toContain(p.action);
      for (const a of p.audit) expect(AUDIT_ACTIONS, name).toContain(a);
    }
    expect(policyOf(MESH_ROUTES.getMesh).action).toBe("nodes:read");
    expect(policyOf(MESH_ROUTES.rotateMeshKey).action).toBe("nodes:manage");
  });

  it("lets viewers read the mesh, only managers rotate keys", async () => {
    const s = await meshStage();
    await meshWithPeers(s.a.agent, 1);
    const viewer = await addMember(s.owner, s.workspaceId, "vi@example.com", "viewer");
    const member = await addMember(s.owner, s.workspaceId, "me@example.com", "member");
    const read = await viewer.json<{ enabled: boolean; nodes: unknown[]; pairs: unknown[] }>(
      `/v1/workspaces/${s.workspaceId}/mesh`,
    );
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ enabled: true, supernet: "10.200.0.0/16" });
    expect(read.body.nodes).toHaveLength(2);
    expect(read.body.pairs).toHaveLength(1);
    const path = `/v1/workspaces/${s.workspaceId}/nodes/${s.a.joined.node_id}/mesh/rotate-key`;
    expect((await member.json(path, { method: "POST" })).status).toBe(403);
    expect((await viewer.json(path, { method: "POST" })).status).toBe(403);
  });

  it("refuses to rotate a server outside the mesh", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    await connectWorkloadAgent(joined);
    const res = await owner.json<{ error: { code: string } }>(
      `/v1/workspaces/${workspaceId}/nodes/${joined.node_id}/mesh/rotate-key`,
      { method: "POST" },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("mesh_not_joined");
  });

  it("hides another workspace's servers", async () => {
    const s = await meshStage();
    const res = await s.owner.json(`/v1/workspaces/ws_missing/mesh`);
    expect(res.status).toBe(404);
    const rotate = await s.owner.json(
      `/v1/workspaces/${s.workspaceId}/nodes/node_missing/mesh/rotate-key`,
      { method: "POST" },
    );
    expect(rotate.status).toBe(404);
  });
});

/**
 * Meshed test clusters for the drain, registry and Cloudflare for SaaS
 * suites: nodes that report a WireGuard key and join the mesh, made ready
 * the way their `mesh_status` would.
 */
import { env } from "cloudflare:test";
import { createDb, meshPaths, nodes } from "@roundhouse/db";
import { type JoinResponse, PROTOCOL_VERSION } from "@roundhouse/protocol";
import { eq, inArray } from "drizzle-orm";
import { expect } from "vitest";
import { pairKey } from "../src/lib/mesh";
import { type Client, eventually, install, joinNode } from "./helpers";
import { connectWorkloadAgent, type FakeWorkloadAgent } from "./pipeline-helpers";

/**
 * A test-only WireGuard public key filled with one byte.
 *
 * @param byte - The fill byte.
 * @returns Standard base64 of 32 bytes.
 */
export const wgKey = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));

/**
 * `hello` fields of a mesh-capable agent.
 *
 * @param publicKey - Its WireGuard key.
 * @param endpoint - `mesh.endpoint` (public), or `null` behind NAT.
 * @returns Overrides for `connectWorkloadAgent`.
 */
export function meshHello(publicKey: string, endpoint: string | null) {
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

/**
 * Turns the mesh on as the owner.
 *
 * @param owner - The instance owner.
 */
export async function enableMesh(owner: Client): Promise<void> {
  const res = await owner.json("/v1/instance/settings", {
    method: "PATCH",
    json: { mesh_enabled: true },
  });
  expect(res.status).toBe(200);
}

/** A joined, connected, meshed node. */
export interface MeshMember {
  joined: JoinResponse;
  agent: FakeWorkloadAgent;
  id: string;
}

/** An install with meshed nodes. */
export interface MeshCluster {
  owner: Client;
  workspaceId: string;
  members: MeshMember[];
}

/**
 * Installs, turns the mesh on and connects `count` public meshed nodes,
 * oldest first; the first `builders` of them (all by default, the join
 * default) are builders.
 *
 * @param count - How many nodes.
 * @param options - `ready`: mark them ready with fresh handshakes; `labels`
 *   per node; `builders`: how many of the first nodes build.
 * @returns The cluster.
 */
export async function meshCluster(
  count: number,
  options: { ready?: boolean; labels?: Record<string, string>[]; builders?: number } = {},
): Promise<MeshCluster> {
  const { owner, workspaceId } = await install();
  await enableMesh(owner);
  const members: MeshMember[] = [];
  for (let i = 0; i < count; i++) {
    const joined = await joinNode(owner, workspaceId, { name: `n${i + 1}`, hostname: `n${i + 1}` });
    const builder = i < (options.builders ?? count);
    const agent = await connectWorkloadAgent(
      joined,
      {},
      {
        ...meshHello(wgKey(0xa0 + i), `198.51.100.${i + 1}:51820`),
        capabilities: { docker: true, gvisor: false, builder },
      },
    );
    members.push({ joined, agent, id: joined.node_id });
  }
  const db = createDb(env.DB);
  // Each node's own frame lists every other one once all have joined.
  await eventually(async () => {
    const d = members[0]!.agent.desired();
    return d?.mesh && d.mesh.peers.length === count - 1 ? d : undefined;
  });
  for (const [i, labels] of (options.labels ?? []).entries()) {
    if (members[i]) await db.update(nodes).set({ labels }).where(eq(nodes.id, members[i]!.id));
  }
  if (options.ready) await markReady(members.map((m) => m.id));
  return { owner, workspaceId, members };
}

/**
 * Marks nodes mesh-ready with fresh handshakes between every pair, as
 * their `mesh_status` reports would.
 *
 * @param ids - The nodes.
 * @param now - Handshake time.
 */
export async function markReady(ids: readonly string[], now = Date.now()): Promise<void> {
  const db = createDb(env.DB);
  await db
    .update(nodes)
    .set({ meshReady: true })
    .where(inArray(nodes.id, [...ids]));
  for (const a of ids) {
    for (const b of ids) {
      if (a >= b) continue;
      await db
        .insert(meshPaths)
        .values({
          pairKey: pairKey(a, b),
          path: "direct",
          configuredAt: new Date(now),
          lastHandshakeAt: new Date(now),
        })
        .onConflictDoUpdate({
          target: meshPaths.pairKey,
          set: { path: "direct", lastHandshakeAt: new Date(now), relayNodeId: null },
        });
    }
  }
}

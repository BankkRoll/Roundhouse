/**
 * Which nodes answer for a service's hostnames.
 *
 * - Without the mesh, a node routes a hostname only while it runs a live
 *   replica of the service; DNS pointed at any other node gets `no route`.
 * - With the mesh (ADR 0005, "Cross-node ingress"), every meshed, ready
 *   ingress node of the workspace also routes services whose replicas run
 *   on meshed nodes, through the replicas' mesh IPs, so DNS may point at
 *   any or all of them.
 *
 * These helpers say which nodes those are, so DNS guidance and TLS state
 * only ever name nodes that really serve the domain.
 *
 * @module
 */
import { type Db, deployments, nodes, placements } from "@roundhouse/db";
import { CERTS_PROTOCOL_VERSION } from "@roundhouse/protocol";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { LIVE_DEPLOYMENT_STATUSES } from "../desired-state";
import { meshedNodes, meshServing } from "../mesh";
import { getMeshSettings } from "../settings";

/** A node as the domain code sees it. */
export interface ServingNode {
  id: string;
  name: string;
  publicIp: string | null;
  protocolVersion: number;
}

/** A service in one environment. */
export interface ServicePair {
  serviceId: string;
  environmentId: string;
}

/**
 * Key of a {@link ServicePair} in the maps below.
 *
 * @param p - The pair.
 * @returns `<serviceId>:<environmentId>`.
 */
export const pairKey = (p: ServicePair) => `${p.serviceId}:${p.environmentId}`;

/**
 * Whether a node takes ingress traffic: `capabilities.ingress` absent means
 * `true` (ADR 0005).
 *
 * @param capabilities - The node's reported capabilities.
 * @returns `false` only for nodes that opted out.
 */
export function isIngressNode(capabilities: { ingress?: boolean } | null): boolean {
  return capabilities?.ingress !== false;
}

/** Which nodes count as taking ingress traffic. */
export interface IngressOptions {
  /**
   * `managed` TLS mode: agents older than `CERTS_PROTOCOL_VERSION` get no
   * routes there (ADR 0009, "Gates"), so they don't count.
   */
  managed?: boolean;
}

const routes = (n: { protocolVersion: number }, options: IngressOptions) =>
  !options.managed || n.protocolVersion >= CERTS_PROTOCOL_VERSION;

/**
 * The live nodes holding a replica of a live deployment of each pair.
 *
 * @param db - Database client.
 * @param pairs - Services in environments.
 * @param options - Whether the install is in `managed` TLS mode.
 * @returns Nodes per {@link pairKey}, sorted by name; pairs without any map to `[]`.
 */
export async function servingNodes(
  db: Db,
  pairs: readonly ServicePair[],
  options: IngressOptions = {},
): Promise<Map<string, ServingNode[]>> {
  const out = new Map(pairs.map((p) => [pairKey(p), [] as ServingNode[]]));
  if (!pairs.length) return out;
  const rows = await db
    .selectDistinct({
      serviceId: deployments.serviceId,
      environmentId: deployments.environmentId,
      id: nodes.id,
      name: nodes.name,
      publicIp: nodes.publicIp,
      protocolVersion: nodes.protocolVersion,
      capabilities: nodes.capabilities,
      workspaceId: nodes.workspaceId,
      meshIp: placements.meshIp,
    })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .innerJoin(nodes, eq(nodes.id, placements.nodeId))
    .where(
      and(
        inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
        isNull(nodes.deletedAt),
        or(
          ...pairs.map((p) =>
            and(
              eq(deployments.serviceId, p.serviceId),
              eq(deployments.environmentId, p.environmentId),
            ),
          ),
        ),
      ),
    );
  const add = (key: string, n: ServingNode) => {
    const list = out.get(key);
    if (!list || list.some((m) => m.id === n.id)) return;
    list.push({ id: n.id, name: n.name, publicIp: n.publicIp, protocolVersion: n.protocolVersion });
  };
  for (const r of rows) {
    if (!isIngressNode(r.capabilities) || !routes(r, options)) continue;
    add(pairKey(r), r);
  }
  const mesh = await getMeshSettings(db);
  const meshedPairs = rows.filter((r) => r.meshIp !== null);
  if (mesh.enabled && meshedPairs.length) {
    const now = Date.now();
    const ingressOf = new Map<string, ServingNode[]>();
    const ready = new Set<string>();
    for (const ws of new Set(meshedPairs.map((r) => r.workspaceId))) {
      const meshed = (await meshedNodes(db, ws, mesh)).filter((n) => meshServing(n, mesh, now));
      for (const n of meshed) ready.add(n.id);
      ingressOf.set(
        ws,
        meshed.filter((n) => isIngressNode(n.capabilities) && routes(n, options)),
      );
    }
    for (const r of meshedPairs) {
      // A replica is reachable over the mesh only while its own node is ready.
      if (!ready.has(r.id)) continue;
      for (const n of ingressOf.get(r.workspaceId) ?? []) add(pairKey(r), n);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Every live ingress node of a workspace.
 *
 * @param db - Database client.
 * @param workspaceId - The workspace.
 * @param options - Whether the install is in `managed` TLS mode.
 * @returns Its nodes, sorted by name.
 */
export async function workspaceIngressNodes(
  db: Db,
  workspaceId: string,
  options: IngressOptions = {},
): Promise<ServingNode[]> {
  const rows = await db
    .select({
      id: nodes.id,
      name: nodes.name,
      publicIp: nodes.publicIp,
      protocolVersion: nodes.protocolVersion,
      capabilities: nodes.capabilities,
    })
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), isNull(nodes.deletedAt)));
  return rows
    .filter((r) => isIngressNode(r.capabilities) && routes(r, options))
    .map(({ capabilities: _, ...n }) => n)
    .sort((a, b) => a.name.localeCompare(b.name));
}

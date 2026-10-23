/**
 * Which nodes answer for a service's hostnames.
 *
 * Until the mesh lets one node's Caddy reach another node's replicas (ADR
 * 0005, "Cross-node ingress"), a node routes a hostname only while it runs a
 * live replica of the service; DNS pointed at any other node gets
 * `no route`. These helpers say which nodes those are, so DNS guidance and
 * TLS state only ever name nodes that really serve the domain.
 *
 * @module
 */
import { type Db, deployments, nodes, placements } from "@roundhouse/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { LIVE_DEPLOYMENT_STATUSES } from "../desired-state";

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

/**
 * The live nodes holding a replica of a live deployment of each pair.
 *
 * @param db - Database client.
 * @param pairs - Services in environments.
 * @returns Nodes per {@link pairKey}, sorted by name; pairs without any map to `[]`.
 */
export async function servingNodes(
  db: Db,
  pairs: readonly ServicePair[],
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
  for (const r of rows) {
    if (!isIngressNode(r.capabilities)) continue;
    const list = out.get(pairKey(r));
    if (!list || list.some((n) => n.id === r.id)) continue;
    list.push({ id: r.id, name: r.name, publicIp: r.publicIp, protocolVersion: r.protocolVersion });
  }
  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Every live ingress node of a workspace.
 *
 * @param db - Database client.
 * @param workspaceId - The workspace.
 * @returns Its nodes, sorted by name.
 */
export async function workspaceIngressNodes(db: Db, workspaceId: string): Promise<ServingNode[]> {
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
    .filter((r) => isIngressNode(r.capabilities))
    .map(({ capabilities: _, ...n }) => n)
    .sort((a, b) => a.name.localeCompare(b.name));
}

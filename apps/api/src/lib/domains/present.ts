/**
 * Domain rows → the `Domain` wire shape: each custom domain's DNS records
 * from its service's routing targets, the servers DNS may point at, and
 * every domain's per-node certificate state.
 *
 * @module
 */
import type { Db, domains } from "@roundhouse/db";
import { toApiDomain } from "../serialize";
import { getIngressSettings } from "../settings";
import { expectedRecords, type RoutingTargets, routingTargets } from "./records";
import { tlsNodeStates } from "./tls";

type DomainRow = typeof domains.$inferSelect;

/**
 * Serialises domains of one workspace, looking up routing targets once per
 * service and environment.
 *
 * @param db - Database client.
 * @param workspaceId - The workspace that owns every row.
 * @param rows - Domain rows.
 * @returns Wire domains, in the order given.
 */
export async function presentDomains(db: Db, workspaceId: string, rows: readonly DomainRow[]) {
  const { tlsMode, appsDomain } = await getIngressSettings(db);
  const targets = new Map<string, Promise<RoutingTargets>>();
  const tlsNodes = await tlsNodeStates(db, rows, tlsMode);
  return Promise.all(
    rows.map(async (d) => {
      const key = `${d.serviceId}:${d.environmentId}`;
      let t = targets.get(key);
      if (!t) {
        t = routingTargets(
          db,
          { workspaceId, serviceId: d.serviceId, environmentId: d.environmentId },
          appsDomain,
        );
        targets.set(key, t);
      }
      const resolved = await t;
      return toApiDomain(d, tlsMode, {
        records: expectedRecords(d, resolved),
        tlsNodes: tlsNodes.get(d.id) ?? [],
        routingNodes: resolved.nodes,
      });
    }),
  );
}

/**
 * Domain rows → the `Domain` wire shape, with each custom domain's DNS
 * records filled in from its service's routing targets.
 *
 * @module
 */
import type { Db, domains } from "@roundhouse/db";
import { toApiDomain } from "../serialize";
import { getIngressSettings } from "../settings";
import { expectedRecords, type RoutingTargets, routingTargets } from "./records";

type DomainRow = typeof domains.$inferSelect;

/**
 * Serialises domains of one workspace, looking up routing targets once per
 * service and environment, and only when a custom domain needs them.
 *
 * @param db - Database client.
 * @param workspaceId - The workspace that owns every row.
 * @param rows - Domain rows.
 * @returns Wire domains, in the order given.
 */
export async function presentDomains(db: Db, workspaceId: string, rows: readonly DomainRow[]) {
  const { tlsMode, appsDomain } = await getIngressSettings(db);
  const targets = new Map<string, Promise<RoutingTargets>>();
  return Promise.all(
    rows.map(async (d) => {
      if (d.type !== "custom") return toApiDomain(d, tlsMode);
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
      return toApiDomain(d, tlsMode, expectedRecords(d, await t));
    }),
  );
}

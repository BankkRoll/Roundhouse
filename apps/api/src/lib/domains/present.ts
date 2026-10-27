/**
 * Domain rows → the `Domain` wire shape: each custom domain's DNS records
 * from its service's routing targets (a SaaS domain's CNAME to the SaaS
 * zone and Cloudflare's validation records instead), the servers DNS may
 * point at, and every domain's per-node certificate state.
 *
 * @module
 */
import { type Db, domains } from "@roundhouse/db";
import { and, asc, eq } from "drizzle-orm";
import { toApiDomain } from "../serialize";
import { getIngressSettings } from "../settings";
import { expectedRecords, type RoutingTargets, routingTargets } from "./records";
import { getSaasView, saasRecords } from "./saas";
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
  const saas = rows.some((d) => d.mode === "cloudflare_saas") ? await getSaasView(db) : null;
  return Promise.all(
    rows.map(async (d) => {
      const key = `${d.serviceId}:${d.environmentId}`;
      let t = targets.get(key);
      if (!t) {
        t = routingTargets(
          db,
          { workspaceId, serviceId: d.serviceId, environmentId: d.environmentId },
          appsDomain,
          { managed: tlsMode === "managed" },
        );
        targets.set(key, t);
      }
      const resolved = await t;
      const direct = expectedRecords(d, resolved);
      const ownership = direct.find((r) => r.purpose === "ownership");
      return toApiDomain(d, tlsMode, {
        records:
          d.mode === "cloudflare_saas" && saas && ownership
            ? saasRecords(d, saas.cname_target, ownership)
            : direct,
        tlsNodes: tlsNodes.get(d.id) ?? [],
        routingNodes: resolved.nodes,
      });
    }),
  );
}

/**
 * A service's domains, in one environment or all, by hostname: what the
 * REST listing and the MCP `list_domains` tool both serialise.
 *
 * @param db - Database client.
 * @param serviceId - The service, already authorized.
 * @param environmentId - Only this environment when set.
 * @returns Domain rows.
 */
export function serviceDomains(db: Db, serviceId: string, environmentId?: string) {
  return db
    .select()
    .from(domains)
    .where(
      and(
        eq(domains.serviceId, serviceId),
        ...(environmentId ? [eq(domains.environmentId, environmentId)] : []),
      ),
    )
    .orderBy(asc(domains.hostname));
}

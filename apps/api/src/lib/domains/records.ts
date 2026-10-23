/**
 * The DNS records a custom domain needs and how a check's answers are
 * judged against them (ADR 0009 "Custom domains: direct mode").
 *
 * - **Routing**: a CNAME to the install's ingress hostname (or, without one,
 *   to the service's generated hostname), or at a zone apex A/AAAA records
 *   to the workspace's servers. Correct when the CNAME chain reaches a name
 *   the install serves, or every address is one of those servers.
 * - **Ownership**: `TXT _roundhouse.<host> = "rh-verify=<token>"`, always
 *   required, so a dangling CNAME left by someone else can't be claimed.
 *
 * @module
 */
import { type Db, domains, nodes } from "@roundhouse/db";
import {
  type DnsRecordPurpose,
  type DnsRecordState,
  type DnsRecordType,
  type DomainDnsObservation,
  ownershipRecordName,
  ownershipRecordValue,
} from "@roundhouse/shared";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getSetting } from "../settings";

/**
 * Instance setting with the hostname customers CNAME to, kept by the
 * operator as A/AAAA records to the ingress servers. Optional: without it
 * customers CNAME to the service's generated hostname.
 */
export const INGRESS_HOSTNAME_SETTING = "ingress_hostname";

/** Where a custom domain must point, for one service in one environment. */
export interface RoutingTargets {
  /** The CNAME value to ask for; `null` when there is none to offer. */
  cname: string | null;
  /** Names a CNAME chain may end in: the apps domain and everything under it. */
  appsDomain: string | null;
  ingressHostname: string | null;
  /** Public IPs of the workspace's servers, which an apex may point at. */
  addresses: string[];
}

/** One record on the wire. */
export interface DnsRecord {
  type: DnsRecordType;
  name: string;
  value: string;
  purpose: DnsRecordPurpose;
  state: DnsRecordState;
  /** Extra instructions, e.g. for apex names. */
  note: string | null;
}

type DomainRow = typeof domains.$inferSelect;

/**
 * Collects the routing targets of a service in an environment.
 *
 * @param db - Database client.
 * @param scope - Workspace, service and environment.
 * @param appsDomain - The instance's apps domain.
 * @returns The targets, shared by every custom domain of that service and environment.
 */
export async function routingTargets(
  db: Db,
  scope: { workspaceId: string; serviceId: string; environmentId: string },
  appsDomain: string | null,
): Promise<RoutingTargets> {
  const [ingress, generated, servers] = await Promise.all([
    getSetting<unknown>(db, INGRESS_HOSTNAME_SETTING),
    db
      .select({ hostname: domains.hostname })
      .from(domains)
      .where(
        and(
          eq(domains.serviceId, scope.serviceId),
          eq(domains.environmentId, scope.environmentId),
          eq(domains.type, "generated"),
        ),
      )
      .limit(1),
    db
      .select({ ip: nodes.publicIp })
      .from(nodes)
      .where(
        and(
          eq(nodes.workspaceId, scope.workspaceId),
          isNull(nodes.deletedAt),
          isNotNull(nodes.publicIp),
        ),
      ),
  ]);
  const ingressHostname = typeof ingress === "string" && ingress ? ingress.toLowerCase() : null;
  return {
    cname: ingressHostname ?? generated[0]?.hostname ?? null,
    appsDomain: appsDomain?.toLowerCase() ?? null,
    ingressHostname,
    addresses: [...new Set(servers.map((s) => s.ip!.toLowerCase()))].sort(),
  };
}

const isV6 = (ip: string) => ip.includes(":");

/**
 * The records a custom domain's owner must create, each with its last
 * observed state.
 *
 * @param d - The domain.
 * @param targets - Its routing targets.
 * @returns Routing record(s) first, then the ownership TXT. Empty for generated domains.
 */
export function expectedRecords(d: DomainRow, targets: RoutingTargets): DnsRecord[] {
  if (d.type !== "custom" || !d.verificationToken) return [];
  const routing: DnsRecord[] = [];
  const state = d.dnsStatus;
  if (d.apex && targets.addresses.length) {
    for (const ip of targets.addresses) {
      routing.push({
        type: isV6(ip) ? "AAAA" : "A",
        name: d.hostname,
        value: ip,
        purpose: "routing",
        state,
        note: targets.cname
          ? `An apex can't hold a CNAME. Use these addresses, or your DNS provider's ALIAS or CNAME flattening to ${targets.cname}.`
          : null,
      });
    }
  } else if (targets.cname) {
    routing.push({
      type: "CNAME",
      name: d.hostname,
      value: targets.cname,
      purpose: "routing",
      state,
      note: d.apex
        ? "An apex can't hold a plain CNAME; use your DNS provider's ALIAS or CNAME flattening."
        : null,
    });
  } else {
    for (const ip of targets.addresses) {
      routing.push({
        type: isV6(ip) ? "AAAA" : "A",
        name: d.hostname,
        value: ip,
        purpose: "routing",
        state,
        note: null,
      });
    }
  }
  return [
    ...routing,
    {
      type: "TXT",
      name: ownershipRecordName(d.hostname),
      value: ownershipRecordValue(d.verificationToken),
      purpose: "ownership",
      state: d.ownershipStatus,
      note: null,
    },
  ];
}

const servedBy = (name: string, targets: RoutingTargets) =>
  name === targets.cname ||
  name === targets.ingressHostname ||
  (targets.appsDomain !== null &&
    (name === targets.appsDomain || name.endsWith(`.${targets.appsDomain}`)));

/**
 * Judges the routing record: `ok` when the CNAME chain reaches a name the
 * install serves, or there are addresses and every one is a workspace
 * server; `missing` when nothing resolves; `wrong` otherwise.
 *
 * @param seen - The check's answers.
 * @param targets - Where the domain should point.
 * @returns The routing state.
 */
export function evaluateRouting(
  seen: DomainDnsObservation,
  targets: RoutingTargets,
): DnsRecordState {
  if (seen.cname.some((name) => servedBy(name, targets))) return "ok";
  if (!seen.cname.length && !seen.addresses.length) return "missing";
  const known = new Set(targets.addresses);
  if (seen.addresses.length && seen.addresses.every((ip) => known.has(ip))) return "ok";
  return "wrong";
}

/**
 * Judges the ownership TXT.
 *
 * @param seen - The check's answers.
 * @param token - The domain's verification token.
 * @returns `ok` when a TXT value matches exactly, `wrong` when there are
 *   others only, `missing` when there is none.
 */
export function evaluateOwnership(seen: DomainDnsObservation, token: string): DnsRecordState {
  if (!seen.txt.length) return "missing";
  const want = ownershipRecordValue(token);
  return seen.txt.some((v) => v.trim() === want) ? "ok" : "wrong";
}

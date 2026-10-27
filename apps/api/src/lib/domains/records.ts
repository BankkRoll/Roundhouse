/**
 * The DNS records a custom domain needs and how a check's answers are
 * judged against them (ADR 0009 "Custom domains: direct mode").
 *
 * - **Routing**: a CNAME to the install's ingress hostname (or, without one,
 *   to the service's generated hostname), or A/AAAA records: at a zone apex,
 *   and whenever some of the workspace's ingress servers don't run the
 *   service, since until the mesh (ADR 0005) only servers with a replica
 *   answer for it, so the records name exactly those. Correct when the CNAME
 *   chain reaches a name the install serves, or every address is one of the
 *   workspace's servers.
 * - **Ownership**: `TXT _roundhouse.<host> = "rh-verify=<token>"`, always
 *   required, so a dangling CNAME left by someone else can't be claimed. A
 *   wildcard proves it at its base name.
 * - **ACME delegation** (wildcards): `CNAME _acme-challenge.<base>` to a
 *   name in the apps domain's zone, where the control plane answers DNS-01.
 *
 * @module
 */
import { type Db, domains } from "@roundhouse/db";
import {
  acmeDelegationName,
  acmeDelegationTarget,
  type DnsRecordPurpose,
  type DnsRecordState,
  type DnsRecordType,
  type DomainDnsObservation,
  isWildcardHostname,
  ownershipRecordName,
  ownershipRecordValue,
} from "@roundhouse/shared";
import { and, eq } from "drizzle-orm";
import { getSetting } from "../settings";
import { type IngressOptions, pairKey, servingNodes, workspaceIngressNodes } from "./serving";

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
  /** Public IPs of the workspace's ingress servers; addresses outside them are `wrong`. */
  addresses: string[];
  /** Public IPs of the servers running a live replica of the service. */
  servingAddresses: string[];
  /** The workspace's ingress servers, and whether each runs the service. */
  nodes: { id: string; name: string; publicIp: string | null; serves: boolean }[];
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
 * @param options - Whether the install is in `managed` TLS mode.
 * @returns The targets, shared by every custom domain of that service and environment.
 */
export async function routingTargets(
  db: Db,
  scope: { workspaceId: string; serviceId: string; environmentId: string },
  appsDomain: string | null,
  options: IngressOptions = {},
): Promise<RoutingTargets> {
  const [ingress, generated, servers, serving] = await Promise.all([
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
    workspaceIngressNodes(db, scope.workspaceId, options),
    servingNodes(db, [scope], options),
  ]);
  const ingressHostname = typeof ingress === "string" && ingress ? ingress.toLowerCase() : null;
  const serves = new Set((serving.get(pairKey(scope)) ?? []).map((n) => n.id));
  const ips = (list: { publicIp: string | null }[]) =>
    [...new Set(list.flatMap((n) => (n.publicIp ? [n.publicIp.toLowerCase()] : [])))].sort();
  return {
    cname: ingressHostname ?? generated[0]?.hostname ?? null,
    appsDomain: appsDomain?.toLowerCase() ?? null,
    ingressHostname,
    addresses: ips(servers),
    servingAddresses: ips(servers.filter((n) => serves.has(n.id))),
    nodes: servers.map((n) => ({
      id: n.id,
      name: n.name,
      publicIp: n.publicIp,
      serves: serves.has(n.id),
    })),
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
  const serving = targets.servingAddresses;
  // Some ingress servers don't run the service, so a CNAME to a name that
  // resolves to every server would send part of the traffic to `no route`.
  const partial = serving.length > 0 && serving.length < targets.addresses.length;
  if (partial) {
    const names = targets.nodes.filter((n) => n.serves).map((n) => n.name);
    const note =
      `This service runs on ${names.length} of ${targets.nodes.length} servers (${names.join(", ")}); ` +
      "until servers route to each other's replicas only those answer for it. Point DNS at these " +
      "addresses and update the records if the service moves to other servers.";
    for (const ip of serving) {
      routing.push({
        type: isV6(ip) ? "AAAA" : "A",
        name: d.hostname,
        value: ip,
        purpose: "routing",
        state,
        note,
      });
    }
  } else if (d.apex && targets.addresses.length) {
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
  const records: DnsRecord[] = [
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
  if (isWildcardHostname(d.hostname) && targets.appsDomain) {
    const target = acmeDelegationTarget(d.id, targets.appsDomain);
    records.push({
      type: "CNAME",
      name: acmeDelegationName(d.hostname),
      value: target,
      purpose: "acme_delegation",
      state: evaluateDelegation(d.dnsObserved, target),
      note: "Lets this install answer the DNS-01 challenges of the wildcard certificate.",
    });
  }
  return records;
}

/**
 * Judges a wildcard's `_acme-challenge` delegation.
 *
 * @param seen - The last check's answers, if any.
 * @param target - Where the CNAME must point.
 * @returns `unknown` before a check, then `ok`, `missing` or `wrong`.
 */
export function evaluateDelegation(
  seen: DomainDnsObservation | null,
  target: string,
): DnsRecordState {
  if (!seen?.acme_delegation) return "unknown";
  if (!seen.acme_delegation.length) return "missing";
  return seen.acme_delegation.includes(target) ? "ok" : "wrong";
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

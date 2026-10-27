/**
 * A domain's certificate state (ADR 0009), kept in `domains.tls_*`:
 *
 * - **`acme` mode** (and hosts not yet managed in `managed` mode): each
 *   serving node's Caddy issues its own certificate and the agent reports it
 *   in `cert_status` ({@link recordCertStatus}). The domain is `issued` once
 *   every serving node reported a certificate, `failed` while any reports a
 *   failure, and moves from `issuing` to `active` with the first full set.
 * - **`managed` mode**: the control plane issued the certificate; the domain
 *   is `issued` once every serving node acknowledged loading the current
 *   chain ({@link recomputeManagedTls}).
 *
 * SECURITY: a node's report only counts for hostnames it serves (it holds a
 * live replica of the domain's service), so one node can't paint another
 * tenant's domain as failed or issued.
 *
 * @module
 */
import { certificateDeployments, type Db, domains, domainTlsReports } from "@roundhouse/db";
import { CERTS_PROTOCOL_VERSION, type CertStatus } from "@roundhouse/protocol";
import type { TlsMode } from "@roundhouse/shared";
import { and, eq, inArray } from "drizzle-orm";
import { type CertificateRow, certificatesForDomains, servable } from "../certificates/coverage";
import { pairKey, type ServingNode, servingNodes } from "./serving";

type DomainRow = typeof domains.$inferSelect;
type ReportRow = typeof domainTlsReports.$inferSelect;

/** Longest stored report error; Caddy's can be verbose. */
const MAX_ERROR_CHARS = 500;

/** One node's view of a domain's certificate. */
export interface TlsNodeState {
  node_id: string;
  name: string;
  state: "pending" | "issued" | "failed";
  error: string | null;
}

/** The domain-level summary of the nodes' states. */
export interface TlsSummary {
  status: "pending" | "issued" | "failed";
  issuer: string | null;
  notBefore: number | null;
  notAfter: number | null;
  error: string | null;
  nodes: TlsNodeState[];
}

/**
 * Summarises `acme`-mode reports over the nodes serving a domain.
 *
 * @param serving - Nodes serving the domain.
 * @param reports - The latest report of each node (others are ignored).
 * @returns `failed` if any serving node failed, `issued` once all issued,
 *   else `pending`; expiry is the earliest reported.
 */
export function summarizeReports(
  serving: readonly Pick<ServingNode, "id" | "name">[],
  reports: readonly ReportRow[],
): TlsSummary {
  const byNode = new Map(reports.map((r) => [r.nodeId, r]));
  const states: TlsNodeState[] = serving.map((n) => {
    const r = byNode.get(n.id);
    return { node_id: n.id, name: n.name, state: r?.state ?? "pending", error: r?.error ?? null };
  });
  const issued = serving.map((n) => byNode.get(n.id)).filter((r) => r?.state === "issued");
  const failed = states.find((s) => s.state === "failed");
  const expiries = issued.flatMap((r) => (r?.notAfter ? [+r.notAfter] : []));
  return {
    status: failed
      ? "failed"
      : serving.length > 0 && issued.length === serving.length
        ? "issued"
        : "pending",
    issuer: issued.find((r) => r?.issuer)?.issuer ?? null,
    notBefore: null,
    notAfter: expiries.length ? Math.min(...expiries) : null,
    error: failed ? `${failed.name}: ${failed.error}` : null,
    nodes: states,
  };
}

/**
 * Summarises `managed`-mode delivery of a certificate over the serving nodes.
 *
 * @param cert - The certificate serving the domain, if any.
 * @param serving - Nodes serving the domain that take control-plane certificates.
 * @param acked - Nodes that acknowledged the certificate's current chain.
 * @returns `issued` once every serving node holds the current chain.
 */
export function summarizeDeployments(
  cert: CertificateRow | undefined,
  serving: readonly Pick<ServingNode, "id" | "name">[],
  acked: ReadonlySet<string>,
): TlsSummary {
  const nodeStates: TlsNodeState[] = serving.map((n) => ({
    node_id: n.id,
    name: n.name,
    state: cert && servable(cert) && acked.has(n.id) ? "issued" : "pending",
    error: null,
  }));
  if (!cert || !servable(cert)) {
    return {
      status: cert?.status === "failed" ? "failed" : "pending",
      issuer: null,
      notBefore: null,
      notAfter: null,
      error: cert?.error ?? null,
      nodes: nodeStates,
    };
  }
  const waiting = nodeStates.filter((s) => s.state !== "issued");
  return {
    status: waiting.length ? "pending" : "issued",
    issuer: cert.issuer,
    notBefore: cert.notBefore ? +cert.notBefore : null,
    notAfter: cert.notAfter ? +cert.notAfter : null,
    // A failed renewal still serves the old chain; its error is worth showing.
    error: waiting.length
      ? `Waiting for ${waiting.map((s) => s.name).join(", ")} to load the certificate.`
      : (cert.error ?? null),
    nodes: nodeStates,
  };
}

function tlsPatch(d: DomainRow, summary: TlsSummary, now: number): Partial<DomainRow> {
  const patch: Partial<DomainRow> = {
    tlsStatus: summary.status,
    tlsIssuer: summary.issuer,
    tlsNotBefore: summary.notBefore === null ? null : new Date(summary.notBefore),
    tlsNotAfter: summary.notAfter === null ? null : new Date(summary.notAfter),
    tlsError: summary.error,
    tlsUpdatedAt: new Date(now),
  };
  if (summary.status === "issued" && d.status === "issuing") {
    patch.status = "active";
    patch.error = null;
  }
  return patch;
}

/**
 * Records one node's `cert_status` and recomputes the domain's TLS state.
 *
 * @param db - Database client.
 * @param nodeId - The reporting node.
 * @param status - The report.
 * @param now - Current time, unix ms.
 * @returns Whether the report was about a domain the node serves (and so was kept).
 */
export async function recordCertStatus(
  db: Db,
  nodeId: string,
  status: Pick<CertStatus, "hostname" | "state" | "issuer" | "not_after" | "error">,
  now = Date.now(),
): Promise<boolean> {
  const d = await db.query.domains.findFirst({
    where: and(eq(domains.hostname, status.hostname), eq(domains.verificationStatus, "verified")),
  });
  if (!d) return false;
  const serving = (await servingNodes(db, [d])).get(pairKey(d)) ?? [];
  if (!serving.some((n) => n.id === nodeId)) return false;
  await db
    .insert(domainTlsReports)
    .values({
      domainId: d.id,
      nodeId,
      state: status.state,
      issuer: status.issuer ?? null,
      notAfter: status.not_after === undefined ? null : new Date(status.not_after),
      error: status.error?.slice(0, MAX_ERROR_CHARS) ?? null,
      reportedAt: new Date(now),
    })
    .onConflictDoUpdate({
      target: [domainTlsReports.domainId, domainTlsReports.nodeId],
      set: {
        state: status.state,
        issuer: status.issuer ?? null,
        notAfter: status.not_after === undefined ? null : new Date(status.not_after),
        error: status.error?.slice(0, MAX_ERROR_CHARS) ?? null,
        reportedAt: new Date(now),
      },
    });
  const reports = await db
    .select()
    .from(domainTlsReports)
    .where(eq(domainTlsReports.domainId, d.id));
  await db
    .update(domains)
    .set(tlsPatch(d, summarizeReports(serving, reports), now))
    .where(eq(domains.id, d.id));
  return true;
}

/**
 * Nodes that take control-plane certificates, of those serving a domain.
 * Older agents get no routes in `managed` mode, so they don't count.
 */
const takesCertificates = (n: ServingNode) => n.protocolVersion >= CERTS_PROTOCOL_VERSION;

/**
 * Recomputes the TLS state of domains in `managed` mode from their
 * certificates and the nodes' acknowledgements.
 *
 * @param db - Database client.
 * @param domainIds - Domains to recompute; unknown or unverified ones are skipped.
 * @param now - Current time, unix ms.
 */
export async function recomputeManagedTls(
  db: Db,
  domainIds: readonly string[],
  now = Date.now(),
): Promise<void> {
  if (!domainIds.length) return;
  const rows = await db
    .select()
    .from(domains)
    .where(
      and(inArray(domains.id, [...new Set(domainIds)]), eq(domains.verificationStatus, "verified")),
    );
  if (!rows.length) return;
  const [serving, certs] = await Promise.all([
    servingNodes(db, rows),
    certificatesForDomains(db, rows),
  ]);
  const certIds = [...new Set([...certs.values()].map((c) => c.id))];
  const deployments = certIds.length
    ? await db
        .select()
        .from(certificateDeployments)
        .where(inArray(certificateDeployments.certificateId, certIds))
    : [];
  for (const d of rows) {
    const cert = certs.get(d.id);
    const acked = new Set(
      deployments
        .filter((x) => x.certificateId === cert?.id && x.ackedAt && x.sha256 === cert?.sha256)
        .map((x) => x.nodeId),
    );
    const nodesOf = (serving.get(pairKey(d)) ?? []).filter(takesCertificates);
    await db
      .update(domains)
      .set(tlsPatch(d, summarizeDeployments(cert, nodesOf, acked), now))
      .where(eq(domains.id, d.id));
  }
}

/**
 * Per-node TLS states of domains, for the API's `tls.nodes`.
 *
 * @param db - Database client.
 * @param rows - Domains of one workspace.
 * @param tlsMode - The install's TLS mode.
 * @returns States per domain ID; empty lists in `internal` and `off` modes.
 */
export async function tlsNodeStates(
  db: Db,
  rows: readonly DomainRow[],
  tlsMode: TlsMode,
): Promise<Map<string, TlsNodeState[]>> {
  const out = new Map<string, TlsNodeState[]>();
  if (!rows.length || (tlsMode !== "acme" && tlsMode !== "managed")) return out;
  const serving = await servingNodes(db, rows);
  const reports = await db
    .select()
    .from(domainTlsReports)
    .where(
      inArray(
        domainTlsReports.domainId,
        rows.map((d) => d.id),
      ),
    );
  const certs = tlsMode === "managed" ? await certificatesForDomains(db, rows) : new Map();
  const certIds = [...new Set([...certs.values()].map((c: CertificateRow) => c.id))];
  const deployments = certIds.length
    ? await db
        .select()
        .from(certificateDeployments)
        .where(inArray(certificateDeployments.certificateId, certIds))
    : [];
  for (const d of rows) {
    const nodesOf = serving.get(pairKey(d)) ?? [];
    const cert = certs.get(d.id) as CertificateRow | undefined;
    if (tlsMode === "managed" && cert && servable(cert)) {
      const acked = new Set(
        deployments
          .filter((x) => x.certificateId === cert.id && x.ackedAt && x.sha256 === cert.sha256)
          .map((x) => x.nodeId),
      );
      out.set(d.id, summarizeDeployments(cert, nodesOf.filter(takesCertificates), acked).nodes);
    } else {
      out.set(
        d.id,
        summarizeReports(
          nodesOf,
          reports.filter((r) => r.domainId === d.id),
        ).nodes,
      );
    }
  }
  return out;
}

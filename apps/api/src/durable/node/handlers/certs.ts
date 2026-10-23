/**
 * The node Durable Object's certificate frames (ADR 0009, from
 * `CERTS_PROTOCOL_VERSION`):
 *
 * - `cert_request`: the agent's manifest check found certificates it lacks
 *   or holds with another digest. Answered with `cert_sync` frames (at most
 *   `MAX_CERT_UPSERTS_PER_FRAME` bodies each), every private key sealed to
 *   the node with AAD `cert-key:<node>:<certificate>:<sha256>`.
 * - `cert_ack`: the agent wrote and loaded certificates; recorded per node,
 *   then the TLS state of the domains they serve is recomputed.
 * - `cert_status`: Caddy's on-demand outcome for a hostname (`acme` mode,
 *   and hosts not yet managed in `managed` mode); see `lib/domains/tls.ts`.
 *
 * SECURITY: a node is sent only certificates in its own manifest, recomputed
 * from D1 for every request, so a node can't fetch another node's keys by
 * naming their IDs. Keys are unsealed from the KEK only to be resealed to the
 * node, and never leave this function in the clear.
 *
 * @module
 */
import {
  certificateDeployments,
  certificates,
  type Db,
  deployments,
  domains,
  nodes,
  placements,
} from "@roundhouse/db";
import {
  type CertAck,
  type CertRequest,
  type CertStatus,
  type CertSync,
  type CertUpsert,
  certKeyAad,
  MAX_CERT_UPSERTS_PER_FRAME,
  sealBox,
} from "@roundhouse/protocol";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Env } from "../../../env";
import { openCertificateKey } from "../../../lib/certificates/config";
import type { Sealed } from "../../../lib/crypto";
import { buildDesiredState, LIVE_DEPLOYMENT_STATUSES } from "../../../lib/desired-state";
import { recomputeManagedTls, recordCertStatus } from "../../../lib/domains/tls";
import { getIngressSettings } from "../../../lib/settings";

/** D1 binds at most 100 parameters per statement. */
const MAX_IDS_PER_LOOKUP = 90;

/** What a certificate frame handler needs from the Durable Object. */
export interface CertFrameContext {
  db: Db;
  env: Env;
  nodeId: string;
  /** Signs and sends a credential-bearing control frame to this node's agent. */
  reply(body: Omit<CertSync, "id" | "node_id" | "iat" | "exp">): Promise<void>;
  now?: number;
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Handles one certificate frame.
 *
 * @param ctx - Database, bindings, node and the reply channel.
 * @param frame - The validated frame.
 * @returns How many certificates (or, for `cert_status`, reports) were handled.
 */
export async function onCertFrame(
  ctx: CertFrameContext,
  frame: CertRequest | CertAck | CertStatus,
): Promise<number> {
  switch (frame.type) {
    case "cert_request":
      return answerCertRequest(ctx, frame.ids);
    case "cert_ack":
      return recordCertAck(ctx, frame.ids);
    case "cert_status":
      return (await recordCertStatus(ctx.db, ctx.nodeId, frame, ctx.now)) ? 1 : 0;
  }
}

/**
 * Sends the requested certificates that are in the node's manifest.
 *
 * @param ctx - Handler context.
 * @param ids - Requested certificate IDs.
 * @returns How many bodies were sent.
 */
export async function answerCertRequest(
  ctx: CertFrameContext,
  ids: readonly string[],
): Promise<number> {
  const { db, env, nodeId } = ctx;
  const now = ctx.now ?? Date.now();
  const [node] = await db
    .select({ key: nodes.encryptionPublicKey })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), isNull(nodes.deletedAt)))
    .limit(1);
  if (!node?.key) return 0;
  const state = await buildDesiredState(db, env, nodeId);
  const manifest = new Map((state?.certificates ?? []).map((c) => [c.id, c]));
  const wanted = [...new Set(ids)].filter((id) => manifest.has(id));
  let sent = 0;
  for (const batch of chunks(wanted, MAX_CERT_UPSERTS_PER_FRAME)) {
    const rows = await db.select().from(certificates).where(inArray(certificates.id, batch));
    const upserts: CertUpsert[] = [];
    for (const c of rows) {
      // The manifest digest is what the agent compares against; a renewal
      // landing between the two reads is sent with the next request.
      if (!c.chainPem || !c.keySealed || c.sha256 !== manifest.get(c.id)?.sha256) continue;
      const keyPem = await openCertificateKey(env, c.id, c.keySealed as Sealed);
      upserts.push({
        id: c.id,
        hostnames: c.hostnames,
        cert_pem: c.chainPem,
        sha256: c.sha256,
        key_sealed: await sealBox(
          node.key,
          JSON.stringify({ key_pem: keyPem }),
          "cert-key",
          certKeyAad(nodeId, c.id, c.sha256),
        ),
        not_after: +c.notAfter!,
      });
    }
    if (!upserts.length) continue;
    await ctx.reply({ type: "cert_sync", upserts, removes: [] });
    for (const u of upserts) {
      await db
        .insert(certificateDeployments)
        .values({ certificateId: u.id, nodeId, sha256: u.sha256, sentAt: new Date(now) })
        .onConflictDoUpdate({
          target: [certificateDeployments.certificateId, certificateDeployments.nodeId],
          set: {
            sha256: u.sha256,
            sentAt: new Date(now),
            // A new chain is unconfirmed until acked; a resend of the same keeps its ack.
            ackedAt: sql`CASE WHEN ${certificateDeployments.sha256} = ${u.sha256} THEN ${certificateDeployments.ackedAt} ELSE NULL END`,
          },
        });
    }
    sent += upserts.length;
  }
  return sent;
}

/**
 * Records a `cert_ack` and recomputes the TLS state of the domains the
 * acknowledged certificates serve on this node.
 *
 * @param ctx - Handler context.
 * @param ids - Acknowledged certificate IDs.
 * @returns How many deployments were confirmed.
 */
export async function recordCertAck(ctx: CertFrameContext, ids: readonly string[]): Promise<number> {
  const { db, nodeId } = ctx;
  const now = ctx.now ?? Date.now();
  let confirmed = 0;
  const domainIds = new Set<string>();
  let wildcard = false;
  for (const batch of chunks([...new Set(ids)], MAX_IDS_PER_LOOKUP)) {
    const done = await db
      .update(certificateDeployments)
      .set({ ackedAt: new Date(now) })
      .where(
        and(
          eq(certificateDeployments.nodeId, nodeId),
          inArray(certificateDeployments.certificateId, batch),
          // Only the chain the certificate holds now: an ack racing a
          // renewal confirms the old one, which no longer counts.
          sql`${certificateDeployments.sha256} = (SELECT ${certificates.sha256} FROM ${certificates} WHERE ${certificates.id} = ${certificateDeployments.certificateId})`,
        ),
      )
      .returning({ id: certificateDeployments.certificateId });
    confirmed += done.length;
    if (!done.length) continue;
    const certs = await db
      .select({ domainId: certificates.domainId, kind: certificates.kind })
      .from(certificates)
      .where(
        inArray(
          certificates.id,
          done.map((d) => d.id),
        ),
      );
    for (const c of certs) {
      if (c.domainId) domainIds.add(c.domainId);
      if (c.kind === "apps_wildcard") wildcard = true;
    }
  }
  if (wildcard) {
    for (const id of await generatedDomainsOnNode(db, nodeId)) domainIds.add(id);
  }
  if ((await getIngressSettings(db)).tlsMode === "managed") {
    await recomputeManagedTls(db, [...domainIds], now);
  }
  return confirmed;
}

/**
 * Verified generated domains of services with a live replica on a node: the
 * ones the apps wildcard serves there.
 *
 * @param db - Database client.
 * @param nodeId - The node.
 * @returns Domain IDs.
 */
async function generatedDomainsOnNode(db: Db, nodeId: string): Promise<string[]> {
  const pairs = await db
    .selectDistinct({ serviceId: deployments.serviceId, environmentId: deployments.environmentId })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .where(
      and(
        eq(placements.nodeId, nodeId),
        inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
      ),
    );
  const out: string[] = [];
  for (const batch of chunks(pairs, Math.floor(MAX_IDS_PER_LOOKUP / 2))) {
    const rows = await db
      .select({ id: domains.id })
      .from(domains)
      .where(
        and(
          eq(domains.type, "generated"),
          eq(domains.verificationStatus, "verified"),
          or(
            ...batch.map((p) =>
              and(eq(domains.serviceId, p.serviceId), eq(domains.environmentId, p.environmentId)),
            ),
          ),
        ),
      );
    out.push(...rows.map((r) => r.id));
  }
  return out;
}

/**
 * Install-wide settings: ingress (`apps_domain`, `tls_mode`), log
 * retention, and whether the MCP endpoint is enabled (`mcp_enabled`). Only
 * instance admins may read or change them, and only from a browser session.
 * An ingress change re-sends desired state to every node so Caddy picks it up.
 *
 * - `managed` (control-plane certificates, ADR 0009) is refused with 422
 *   `managed_tls_unavailable` while its prerequisites aren't met (an
 *   https `PUBLIC_ORIGIN` for the HTTP-01 challenge proxy). Switching to
 *   it creates the certificates and starts their orders at once; hostnames
 *   keep Caddy's on-demand certificates until theirs is on the nodes.
 * - Switching to `acme` with more than one ingress node is refused (409
 *   `acme_mode_single_ingress_only`): each node's Caddy would order its own
 *   certificates, and a validation reaching another node fails.
 *
 * A change is recorded as an instance-level audit entry (no workspace; see
 * `INSTANCE_AUDIT_ACTIONS`), visible to instance admins only.
 *
 * @module
 */
import { type Db, domains, nodes } from "@roundhouse/db";
import type { InstanceAction } from "@roundhouse/shared";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { clientIp, createRouter, requireInstanceAction } from "../context";
import { getInstanceSettings, policyOf, updateInstanceSettings } from "../contracts";
import { recordAudit } from "../lib/audit";
import { claimDueCertificates, syncCertificates } from "../lib/certificates/schedule";
import { managedTlsProblems } from "../lib/certificates/settings";
import { refreshAllNodes } from "../lib/desired-state";
import { isIngressNode } from "../lib/domains/serving";
import { ApiError } from "../lib/errors";
import {
  getIngressSettings,
  getLogRetentionDays,
  getMcpEnabled,
  putSetting,
  SettingKey,
} from "../lib/settings";

/**
 * Live ingress nodes across the install.
 *
 * @param db - Database client.
 * @returns How many there are.
 */
export async function countIngressNodes(db: Db): Promise<number> {
  const rows = await db
    .select({ capabilities: nodes.capabilities })
    .from(nodes)
    .where(isNull(nodes.deletedAt));
  return rows.filter((r) => isIngressNode(r.capabilities)).length;
}

async function readSettings(db: Db) {
  const [ingress, logRetentionDays, mcpEnabled, ingressNodes] = await Promise.all([
    getIngressSettings(db),
    getLogRetentionDays(db),
    getMcpEnabled(db),
    countIngressNodes(db),
  ]);
  return {
    apps_domain: ingress.appsDomain,
    tls_mode: ingress.tlsMode,
    log_retention_days: logRetentionDays,
    mcp_enabled: mcpEnabled,
    ingress_nodes: ingressNodes,
  };
}

/** Instance settings routes. */
export const instanceRoutes = createRouter()
  .openapi(getInstanceSettings, async (c) => {
    await requireInstanceAction(c, policyOf(getInstanceSettings).action as InstanceAction);
    return c.json(await readSettings(c.get("db")), 200);
  })
  .openapi(updateInstanceSettings, async (c) => {
    const user = await requireInstanceAction(
      c,
      policyOf(updateInstanceSettings).action as InstanceAction,
    );
    const body = c.req.valid("json");
    const db = c.get("db");
    const before = await readSettings(db);
    const statements = [];
    if (body.tls_mode === "managed" && before.tls_mode !== "managed") {
      const problems = managedTlsProblems(c.env);
      if (problems.length) {
        throw new ApiError(422, "managed_tls_unavailable", problems.join(" "));
      }
    }
    if (body.tls_mode === "acme" && before.tls_mode !== "acme" && before.ingress_nodes > 1) {
      throw new ApiError(
        409,
        "acme_mode_single_ingress_only",
        `This install has ${before.ingress_nodes} ingress servers. With acme each one orders its own ` +
          "certificates and a validation reaching another server fails; use managed instead.",
      );
    }
    if (body.apps_domain !== undefined) {
      statements.push(putSetting(db, SettingKey.appsDomain, body.apps_domain));
    }
    if (body.log_retention_days !== undefined) {
      statements.push(putSetting(db, SettingKey.logRetentionDays, body.log_retention_days));
    }
    if (body.mcp_enabled !== undefined) {
      statements.push(putSetting(db, SettingKey.mcpEnabled, body.mcp_enabled));
    }
    if (body.tls_mode !== undefined) {
      statements.push(putSetting(db, SettingKey.tlsMode, body.tls_mode));
      if (body.tls_mode === "off") {
        statements.push(db.update(domains).set({ tlsStatus: "disabled" }));
      } else if (before.tls_mode === "off") {
        statements.push(
          db
            .update(domains)
            .set({ tlsStatus: "pending" })
            .where(and(eq(domains.tlsStatus, "disabled"), ne(domains.type, "custom"))),
        );
      }
      if (
        body.tls_mode !== before.tls_mode &&
        (body.tls_mode === "acme" || body.tls_mode === "managed")
      ) {
        // Certificates come from somewhere else now; the old mode's states
        // no longer describe them.
        statements.push(
          db
            .update(domains)
            .set({ tlsStatus: "pending", tlsError: null })
            .where(
              and(
                eq(domains.verificationStatus, "verified"),
                inArray(domains.tlsStatus, ["issued", "failed"]),
              ),
            ),
        );
      }
    }
    await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
    const after = await readSettings(db);
    if (after.apps_domain !== before.apps_domain || after.tls_mode !== before.tls_mode) {
      if (after.tls_mode === "managed") {
        await syncCertificates(db);
        await claimDueCertificates(c.env, db);
      }
      await refreshAllNodes(c.env, db);
    }
    const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
      (k) => k !== "ingress_nodes" && after[k] !== before[k],
    );
    if (changed.length) {
      await recordAudit(db, {
        workspaceId: null,
        actorType: "user",
        actorId: user.id,
        action: "instance.settings_updated",
        targetType: "instance",
        metadata: {
          changed,
          before: Object.fromEntries(changed.map((k) => [k, before[k]])),
          after: Object.fromEntries(changed.map((k) => [k, after[k]])),
        },
        ip: clientIp(c),
      });
    }
    return c.json(after, 200);
  });

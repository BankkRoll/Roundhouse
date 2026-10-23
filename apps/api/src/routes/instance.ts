/**
 * Install-wide settings: ingress (`apps_domain`, `tls_mode`) and log
 * retention. Only instance admins may read or change them, and only from a
 * browser session. An ingress change re-sends desired state to every node so
 * Caddy picks it up.
 *
 * A change is recorded as an instance-level audit entry (no workspace; see
 * `INSTANCE_AUDIT_ACTIONS`), visible to instance admins only.
 *
 * @module
 */
import { type Db, domains } from "@roundhouse/db";
import type { InstanceAction } from "@roundhouse/shared";
import { and, eq, ne } from "drizzle-orm";
import { clientIp, createRouter, requireInstanceAction } from "../context";
import { getInstanceSettings, policyOf, updateInstanceSettings } from "../contracts";
import { recordAudit } from "../lib/audit";
import { refreshAllNodes } from "../lib/desired-state";
import { getIngressSettings, getLogRetentionDays, putSetting, SettingKey } from "../lib/settings";

async function readSettings(db: Db) {
  const [ingress, logRetentionDays] = await Promise.all([
    getIngressSettings(db),
    getLogRetentionDays(db),
  ]);
  return {
    apps_domain: ingress.appsDomain,
    tls_mode: ingress.tlsMode,
    log_retention_days: logRetentionDays,
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
    if (body.apps_domain !== undefined) {
      statements.push(putSetting(db, SettingKey.appsDomain, body.apps_domain));
    }
    if (body.log_retention_days !== undefined) {
      statements.push(putSetting(db, SettingKey.logRetentionDays, body.log_retention_days));
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
    }
    await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
    const after = await readSettings(db);
    if (after.apps_domain !== before.apps_domain || after.tls_mode !== before.tls_mode) {
      await refreshAllNodes(c.env, db);
    }
    const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
      (k) => after[k] !== before[k],
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

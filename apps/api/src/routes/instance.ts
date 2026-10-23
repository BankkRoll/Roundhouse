/**
 * Install-wide ingress settings (`apps_domain`, `tls_mode`). Only instance admins may
 * read or change them; a change re-sends desired state to every node so
 * Caddy picks it up.
 *
 * @module
 */
import { domains } from "@roundhouse/db";
import type { InstanceAction } from "@roundhouse/shared";
import { and, eq, ne } from "drizzle-orm";
import { clientIp, createRouter, requireInstanceAction } from "../context";
import { getInstanceSettings, policyOf, updateInstanceSettings } from "../contracts";
import { recordAudit } from "../lib/audit";
import { refreshAllNodes } from "../lib/desired-state";
import { getIngressSettings, putSetting, SettingKey } from "../lib/settings";

/** Instance settings routes. */
export const instanceRoutes = createRouter()
  .openapi(getInstanceSettings, async (c) => {
    await requireInstanceAction(c, policyOf(getInstanceSettings).action as InstanceAction);
    const s = await getIngressSettings(c.get("db"));
    return c.json({ apps_domain: s.appsDomain, tls_mode: s.tlsMode }, 200);
  })
  .openapi(updateInstanceSettings, async (c) => {
    const user = await requireInstanceAction(
      c,
      policyOf(updateInstanceSettings).action as InstanceAction,
    );
    const body = c.req.valid("json");
    const db = c.get("db");
    const before = await getIngressSettings(db);
    const statements = [];
    if (body.apps_domain !== undefined) {
      statements.push(putSetting(db, SettingKey.appsDomain, body.apps_domain));
    }
    if (body.tls_mode !== undefined) {
      statements.push(putSetting(db, SettingKey.tlsMode, body.tls_mode));
      if (body.tls_mode === "off") {
        statements.push(db.update(domains).set({ tlsStatus: "disabled" }));
      } else if (before.tlsMode === "off") {
        statements.push(
          db
            .update(domains)
            .set({ tlsStatus: "pending" })
            .where(and(eq(domains.tlsStatus, "disabled"), ne(domains.type, "custom"))),
        );
      }
    }
    await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
    const after = await getIngressSettings(db);
    await refreshAllNodes(c.env, db);
    await recordAudit(db, {
      workspaceId: null,
      actorType: "user",
      actorId: user.id,
      action: "instance.settings_updated",
      targetType: "instance",
      metadata: {
        before: { apps_domain: before.appsDomain, tls_mode: before.tlsMode },
        after: { apps_domain: after.appsDomain, tls_mode: after.tlsMode },
      },
      ip: clientIp(c),
    });
    return c.json({ apps_domain: after.appsDomain, tls_mode: after.tlsMode }, 200);
  });

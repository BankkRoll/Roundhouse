/**
 * ADR 0014 instance administration routes: `INSTANCE_ROUTES` in
 * `../contracts/instance`.
 *
 * - Instance admins: list, grant and revoke the `users.instance_admin` flag
 *   (never the last one).
 * - The instance audit log: entries with no workspace, for instance admins
 *   only, filtered and paginated newest first.
 * - Audit chain verification: seals what is pending, then recomputes the
 *   chain against the `AuditChain` Durable Object's checkpoints.
 *
 * @module
 */
import { apiTokens, auditLogs, nodes, users } from "@roundhouse/db";
import type { InstanceAction } from "@roundhouse/shared";
import { and, asc, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { clientIp, createRouter, requireInstanceAction } from "../context";
import {
  listInstanceAdmins,
  listInstanceAuditLogs,
  policyOf,
  putInstanceAdmin,
  verifyAuditChain,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { AUDIT_CHAIN_NAME, verifyAuditChain as verifyChain } from "../lib/audit-chain";
import { ApiError, notFound } from "../lib/errors";

const actionOf = (route: Parameters<typeof policyOf>[0]) =>
  policyOf(route).action as InstanceAction;

function toApiAdmin(
  u: Pick<typeof users.$inferSelect, "id" | "name" | "email" | "twoFactorEnabled" | "createdAt">,
) {
  return {
    user_id: u.id,
    name: u.name,
    email: u.email,
    two_factor_enabled: u.twoFactorEnabled,
    created_at: +u.createdAt,
  };
}

/** Instance administration route handlers. */
export const instanceAdminRoutes = createRouter()
  .openapi(listInstanceAdmins, async (c) => {
    await requireInstanceAction(c, actionOf(listInstanceAdmins));
    const rows = await c
      .get("db")
      .select()
      .from(users)
      .where(eq(users.instanceAdmin, true))
      .orderBy(asc(users.createdAt));
    return c.json({ admins: rows.map(toApiAdmin) }, 200);
  })
  .openapi(putInstanceAdmin, async (c) => {
    const actor = await requireInstanceAction(c, actionOf(putInstanceAdmin));
    const { userId } = c.req.valid("param");
    const { instance_admin } = c.req.valid("json");
    const db = c.get("db");
    const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!target) throw notFound("User");
    if (target.instanceAdmin === instance_admin) return c.json(toApiAdmin(target), 200);
    // The guard sits inside the write, so two admins revoking each other at
    // once can't leave the instance without one.
    const keepsAnAdmin = sql`(SELECT count(*) FROM users WHERE instance_admin = 1) > 1`;
    const [updated] = await db
      .update(users)
      .set({ instanceAdmin: instance_admin })
      .where(and(eq(users.id, userId), instance_admin ? undefined : keepsAnAdmin))
      .returning();
    if (!updated) {
      throw new ApiError(409, "last_owner", "The instance must keep at least one instance admin");
    }
    await recordAudit(db, {
      workspaceId: null,
      actorType: "user",
      actorId: actor.id,
      action: instance_admin ? "instance.admin_granted" : "instance.admin_revoked",
      targetType: "user",
      targetId: userId,
      metadata: { email: target.email },
      ip: clientIp(c),
    });
    return c.json(toApiAdmin(updated), 200);
  })
  .openapi(listInstanceAuditLogs, async (c) => {
    await requireInstanceAction(c, actionOf(listInstanceAuditLogs));
    const q = c.req.valid("query");
    const rows = await c
      .get("db")
      .select({
        log: auditLogs,
        actorName: sql<string | null>`coalesce(${users.name}, ${nodes.name}, ${apiTokens.name})`,
      })
      .from(auditLogs)
      .leftJoin(users, and(eq(auditLogs.actorType, "user"), eq(users.id, auditLogs.actorId)))
      .leftJoin(nodes, and(eq(auditLogs.actorType, "node"), eq(nodes.id, auditLogs.actorId)))
      .leftJoin(
        apiTokens,
        and(eq(auditLogs.actorType, "token"), eq(apiTokens.id, auditLogs.actorId)),
      )
      .where(
        and(
          isNull(auditLogs.workspaceId),
          q.cursor ? lt(auditLogs.id, q.cursor) : undefined,
          q.action ? eq(auditLogs.action, q.action) : undefined,
          q.actor_id ? eq(auditLogs.actorId, q.actor_id) : undefined,
          q.since !== undefined ? gte(auditLogs.createdAt, new Date(q.since)) : undefined,
          q.until !== undefined ? lt(auditLogs.createdAt, new Date(q.until)) : undefined,
        ),
      )
      // Audit IDs are monotonic ULIDs, so ID order is creation order.
      .orderBy(desc(auditLogs.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return c.json(
      {
        entries: page.map(({ log, actorName }) => ({
          id: log.id,
          seq: log.seq,
          workspace_id: log.workspaceId,
          actor_type: log.actorType,
          actor_id: log.actorId,
          actor_name: actorName,
          action: log.action,
          target_type: log.targetType,
          target_id: log.targetId,
          metadata: log.metadata,
          ip: log.ip,
          created_at: +log.createdAt,
          prev_hash: log.prevHash,
          hash: log.hash,
        })),
        next_cursor: rows.length > q.limit ? page.at(-1)!.log.id : null,
      },
      200,
    );
  })
  .openapi(verifyAuditChain, async (c) => {
    await requireInstanceAction(c, actionOf(verifyAuditChain));
    const chain = c.env.AUDIT_CHAIN.get(c.env.AUDIT_CHAIN.idFromName(AUDIT_CHAIN_NAME));
    await chain.seal();
    return c.json(await verifyChain(c.env.DB, await chain.state()), 200);
  });

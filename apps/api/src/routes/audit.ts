/**
 * The workspace audit log: a newest-first, cursor-paginated read of every
 * recorded action, with actor names resolved for display.
 *
 * @module
 */
import { createRoute, z } from "@hono/zod-openapi";
import { auditLogs, nodes, users } from "@roundhouse/db";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { createRouter, requireWorkspace } from "../context";
import { AuditLogSchema, errors, json, sessionAuth, WorkspaceParams } from "../schemas";

const list = createRoute({
  method: "get",
  path: "/v1/workspaces/{workspaceId}/audit-logs",
  tags: ["audit"],
  summary: "List audit log entries, newest first",
  security: sessionAuth,
  request: {
    params: WorkspaceParams,
    query: z.object({
      /** ID of the last item from the previous page. */
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: json(z.object({ items: z.array(AuditLogSchema), next_cursor: z.string().nullable() })),
    ...errors(400, 401, 403, 404),
  },
});

/** Routes for `/v1/workspaces/:id/audit-logs`. */
export const auditRoutes = createRouter().openapi(list, async (c) => {
  const { workspaceId } = c.req.valid("param");
  const { cursor, limit } = c.req.valid("query");
  await requireWorkspace(c, workspaceId, "audit:read");

  // Audit IDs are monotonic ULIDs, so ID order is creation order.
  const rows = await c
    .get("db")
    .select({
      log: auditLogs,
      actorName: sql<string | null>`coalesce(${users.name}, ${nodes.name})`,
    })
    .from(auditLogs)
    .leftJoin(users, and(eq(auditLogs.actorType, "user"), eq(users.id, auditLogs.actorId)))
    .leftJoin(nodes, and(eq(auditLogs.actorType, "node"), eq(nodes.id, auditLogs.actorId)))
    .where(
      and(eq(auditLogs.workspaceId, workspaceId), cursor ? lt(auditLogs.id, cursor) : undefined),
    )
    .orderBy(desc(auditLogs.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return c.json(
    {
      items: page.map(({ log, actorName }) => ({
        id: log.id,
        actor_type: log.actorType,
        actor_id: log.actorId,
        actor_name: actorName,
        action: log.action,
        target_type: log.targetType,
        target_id: log.targetId,
        metadata: log.metadata,
        ip: log.ip,
        created_at: +log.createdAt,
      })),
      next_cursor: rows.length > limit ? page.at(-1)!.log.id : null,
    },
    200,
  );
});

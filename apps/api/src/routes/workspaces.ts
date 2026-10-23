/**
 * The signed-in user, their workspaces, and workspace membership management.
 *
 * @module
 */
import { createRoute, z } from "@hono/zod-openapi";
import { type Db, users, workspaceMembers, workspaces } from "@openrail/db";
import type { Role } from "@openrail/shared";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { clientIp, createRouter, requireUser, requireWorkspace } from "../context";
import { recordAudit } from "../lib/audit";
import { ApiError, notFound } from "../lib/errors";
import { createWorkspace } from "../lib/workspaces";
import {
  body,
  errors,
  json,
  MemberSchema,
  RoleSchema,
  sessionAuth,
  WorkspaceParams,
  WorkspaceSchema,
} from "../schemas";

const WorkspaceName = z.object({ name: z.string().trim().min(1).max(100) });
const MemberParams = WorkspaceParams.extend({ memberId: z.string() });

const me = createRoute({
  method: "get",
  path: "/v1/me",
  tags: ["me"],
  summary: "Current user and their workspaces",
  security: sessionAuth,
  responses: {
    200: json(
      z.object({
        user: z.object({
          id: z.string(),
          name: z.string(),
          email: z.string(),
          image: z.string().nullable(),
          /** Holds the install-wide actions (ADR 0014, F3). */
          instance_admin: z.boolean(),
        }),
        workspaces: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            slug: z.string(),
            role: RoleSchema,
            /** The caller's own membership; lets any role leave via DELETE …/members/{id}. */
            member_id: z.string(),
          }),
        ),
      }),
    ),
    ...errors(401),
  },
});

const create = createRoute({
  method: "post",
  path: "/v1/workspaces",
  tags: ["workspaces"],
  summary: "Create a workspace",
  security: sessionAuth,
  request: body(WorkspaceName),
  responses: { 201: json(WorkspaceSchema, "Created"), ...errors(400, 401, 403) },
});

const get = createRoute({
  method: "get",
  path: "/v1/workspaces/{workspaceId}",
  tags: ["workspaces"],
  summary: "Get a workspace",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: { 200: json(WorkspaceSchema), ...errors(401, 404) },
});

const update = createRoute({
  method: "patch",
  path: "/v1/workspaces/{workspaceId}",
  tags: ["workspaces"],
  summary: "Rename a workspace",
  security: sessionAuth,
  request: { params: WorkspaceParams, ...body(WorkspaceName) },
  responses: { 200: json(WorkspaceSchema), ...errors(400, 401, 403, 404) },
});

const listMembers = createRoute({
  method: "get",
  path: "/v1/workspaces/{workspaceId}/members",
  tags: ["members"],
  summary: "List members",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: { 200: json(z.object({ members: z.array(MemberSchema) })), ...errors(401, 403, 404) },
});

const updateMember = createRoute({
  method: "patch",
  path: "/v1/workspaces/{workspaceId}/members/{memberId}",
  tags: ["members"],
  summary: "Change a member's role",
  security: sessionAuth,
  request: { params: MemberParams, ...body(z.object({ role: RoleSchema })) },
  responses: { 200: json(MemberSchema), ...errors(400, 401, 403, 404, 409) },
});

const removeMember = createRoute({
  method: "delete",
  path: "/v1/workspaces/{workspaceId}/members/{memberId}",
  tags: ["members"],
  summary: "Remove a member (or leave, when removing yourself)",
  security: sessionAuth,
  request: { params: MemberParams },
  responses: { 204: { description: "Removed" }, ...errors(401, 403, 404, 409) },
});

function memberQuery(db: Db) {
  return db
    .select({
      id: workspaceMembers.id,
      user_id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      role: workspaceMembers.role,
      createdAt: workspaceMembers.createdAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId));
}

/**
 * WHERE clause that only matches if the row isn't the workspace's last owner.
 * Guarding inside the write (rather than counting first) keeps two owners who
 * demote each other concurrently from leaving the workspace ownerless.
 */
function keepsAnOwner(workspaceId: string) {
  return sql`(${workspaceMembers.role} != 'owner' OR (SELECT count(*) FROM workspace_members WHERE workspace_id = ${workspaceId} AND role = 'owner') > 1)`;
}

/**
 * WHERE clause that only matches non-owners. The permission check reads the
 * target's role before the write; repeating it inside the write stops an
 * admin's change from landing on someone promoted to owner in between.
 */
function notAnOwner() {
  return ne(workspaceMembers.role, "owner");
}

const lastOwner = () => new ApiError(409, "last_owner", "A workspace must keep at least one owner");

const ownerChanged = () =>
  new ApiError(403, "forbidden", "This member is now an owner; only owners can change owners");

/** Routes for `/v1/me` and `/v1/workspaces/*` (excluding nodes, invites, audit). */
export const workspaceRoutes = createRouter()
  .openapi(me, async (c) => {
    const user = await requireUser(c);
    const rows = await c
      .get("db")
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        role: workspaceMembers.role,
        member_id: workspaceMembers.id,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, user.id), isNull(workspaces.deletedAt)))
      .orderBy(asc(workspaces.name));
    const [flags] = await c
      .get("db")
      .select({ instanceAdmin: users.instanceAdmin })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    return c.json(
      { user: { ...user, instance_admin: flags?.instanceAdmin ?? false }, workspaces: rows },
      200,
    );
  })
  .openapi(create, async (c) => {
    const user = await requireUser(c);
    // SECURITY: Workspaces are created by people already trusted to administer
    // one. Otherwise any invited viewer could spin up a workspace and use its
    // invites to pre-register accounts for arbitrary email addresses.
    const [admin] = await c
      .get("db")
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, user.id),
          inArray(workspaceMembers.role, ["owner", "admin"]),
        ),
      )
      .limit(1);
    if (!admin) {
      throw new ApiError(
        403,
        "forbidden",
        "Only workspace owners and admins can create workspaces",
      );
    }
    const ws = await createWorkspace(c.get("db"), c.req.valid("json").name, user.id);
    await recordAudit(c.get("db"), {
      workspaceId: ws.id,
      actorType: "user",
      actorId: user.id,
      action: "workspace.created",
      targetType: "workspace",
      targetId: ws.id,
      ip: clientIp(c),
    });
    return c.json(
      {
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        role: "owner" as const satisfies Role,
        created_at: +ws.createdAt,
      },
      201,
    );
  })
  .openapi(get, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const m = await requireWorkspace(c, workspaceId, "workspace:read");
    const ws = await c
      .get("db")
      .query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws) throw notFound("Workspace");
    return c.json(
      { id: ws.id, name: ws.name, slug: ws.slug, role: m.role, created_at: +ws.createdAt },
      200,
    );
  })
  .openapi(update, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const m = await requireWorkspace(c, workspaceId, "workspace:update");
    const { name } = c.req.valid("json");
    const [ws] = await c
      .get("db")
      .update(workspaces)
      .set({ name })
      .where(eq(workspaces.id, workspaceId))
      .returning();
    if (!ws) throw notFound("Workspace");
    await recordAudit(c.get("db"), {
      workspaceId,
      actorType: "user",
      actorId: m.user.id,
      action: "workspace.renamed",
      targetType: "workspace",
      targetId: workspaceId,
      metadata: { name },
      ip: clientIp(c),
    });
    return c.json(
      { id: ws.id, name: ws.name, slug: ws.slug, role: m.role, created_at: +ws.createdAt },
      200,
    );
  })
  .openapi(listMembers, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, "members:read");
    const rows = await memberQuery(c.get("db"))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(asc(workspaceMembers.createdAt));
    return c.json(
      { members: rows.map(({ createdAt, ...r }) => ({ ...r, created_at: +createdAt })) },
      200,
    );
  })
  .openapi(updateMember, async (c) => {
    const { workspaceId, memberId } = c.req.valid("param");
    const { role } = c.req.valid("json");
    const m = await requireWorkspace(c, workspaceId, "members:manage");
    const db = c.get("db");
    const [target] = await memberQuery(db)
      .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, workspaceId)))
      .limit(1);
    if (!target) throw notFound("Member");

    if ((role === "owner" || target.role === "owner") && m.role !== "owner") {
      throw new ApiError(403, "forbidden", "Only owners can grant or change the owner role");
    }
    const [updated] = await db
      .update(workspaceMembers)
      .set({ role })
      .where(
        and(
          eq(workspaceMembers.id, memberId),
          eq(workspaceMembers.workspaceId, workspaceId),
          role === "owner" ? undefined : keepsAnOwner(workspaceId),
          m.role === "owner" ? undefined : notAnOwner(),
        ),
      )
      .returning({ id: workspaceMembers.id });
    if (!updated) throw m.role === "owner" ? lastOwner() : ownerChanged();
    await recordAudit(db, {
      workspaceId,
      actorType: "user",
      actorId: m.user.id,
      action: "member.role_changed",
      targetType: "member",
      targetId: memberId,
      metadata: { from: target.role, to: role, user_id: target.user_id },
      ip: clientIp(c),
    });
    const { createdAt, ...rest } = target;
    return c.json({ ...rest, role, created_at: +createdAt }, 200);
  })
  .openapi(removeMember, async (c) => {
    const { workspaceId, memberId } = c.req.valid("param");
    const user = await requireUser(c);
    const db = c.get("db");
    const [target] = await memberQuery(db)
      .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, workspaceId)))
      .limit(1);
    const isSelf = target?.user_id === user.id;
    const m = await requireWorkspace(c, workspaceId, isSelf ? "workspace:read" : "members:manage");
    if (!target) throw notFound("Member");
    if (target.role === "owner" && !isSelf && m.role !== "owner") {
      throw new ApiError(403, "forbidden", "Only owners can remove an owner");
    }
    const [removed] = await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.id, memberId),
          eq(workspaceMembers.workspaceId, workspaceId),
          keepsAnOwner(workspaceId),
          m.role === "owner" || isSelf ? undefined : notAnOwner(),
        ),
      )
      .returning({ id: workspaceMembers.id });
    if (!removed) throw m.role === "owner" || isSelf ? lastOwner() : ownerChanged();
    await recordAudit(db, {
      workspaceId,
      actorType: "user",
      actorId: user.id,
      action: isSelf ? "member.left" : "member.removed",
      targetType: "member",
      targetId: memberId,
      metadata: { user_id: target.user_id, email: target.email },
      ip: clientIp(c),
    });
    return c.body(null, 204);
  });

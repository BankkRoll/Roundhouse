/**
 * The signed-in user, their workspaces, and workspace membership management.
 *
 * @module
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  type Db,
  projectAccessGrants,
  projects,
  teamMembers,
  teams,
  users,
  workspaceMembers,
  workspaces,
} from "@roundhouse/db";
import { isApiTokenScope, type Role } from "@roundhouse/shared";
import { and, asc, eq, inArray, isNull, ne, notExists, sql } from "drizzle-orm";
import {
  actorOf,
  clientIp,
  createRouter,
  requireInstanceAction,
  requirePrincipal,
  requireWorkspace,
} from "../context";
import { recordAudit } from "../lib/audit";
import { ApiError, notFound } from "../lib/errors";
import { revalidateWorkspace } from "../lib/realtime";
import { createWorkspace } from "../lib/workspaces";
import {
  ApiTokenScopeSchema,
  body,
  errors,
  json,
  MemberSchema,
  RoleSchema,
  sessionAuth,
  sessionOnlyAuth,
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
        /**
         * Present when the request authenticated with an API token: `user` is
         * its creator and `workspaces` holds only the token's workspace.
         */
        token: z
          .object({
            id: z.string(),
            name: z.string(),
            workspace_id: z.string(),
            scopes: z.array(ApiTokenScopeSchema),
          })
          .optional(),
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
  security: sessionOnlyAuth,
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
    const { user, token } = await requirePrincipal(c);
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
      .where(
        and(
          eq(workspaceMembers.userId, user.id),
          isNull(workspaces.deletedAt),
          token ? eq(workspaces.id, token.workspaceId) : undefined,
        ),
      )
      .orderBy(asc(workspaces.name));
    // SECURITY: A token never carries instance actions, so it never reports
    // its creator as an instance admin either.
    const [flags] = token
      ? []
      : await c
          .get("db")
          .select({ instanceAdmin: users.instanceAdmin })
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1);
    const me = { ...user, instance_admin: flags?.instanceAdmin ?? false };
    if (!token) return c.json({ user: me, workspaces: rows }, 200);
    return c.json(
      {
        user: me,
        workspaces: rows,
        token: {
          id: token.id,
          name: token.name,
          workspace_id: token.workspaceId,
          scopes: token.scopes.filter(isApiTokenScope),
        },
      },
      200,
    );
  })
  .openapi(create, async (c) => {
    // SECURITY: Only instance admins create workspaces (ADR 0014, F3).
    // Otherwise any invited user could spin up a workspace and use its invites
    // to pre-register accounts for arbitrary email addresses.
    const user = await requireInstanceAction(c, "workspaces:create");
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
      ...m.actor,
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
      ...m.actor,
      action: "member.role_changed",
      targetType: "member",
      targetId: memberId,
      metadata: { from: target.role, to: role, user_id: target.user_id },
      ip: clientIp(c),
    });
    await revalidateWorkspace(db, c.env, workspaceId, { userIds: [target.user_id] });
    const { createdAt, ...rest } = target;
    return c.json({ ...rest, role, created_at: +createdAt }, 200);
  })
  .openapi(removeMember, async (c) => {
    const { workspaceId, memberId } = c.req.valid("param");
    const principal = await requirePrincipal(c);
    const db = c.get("db");
    const [target] = await memberQuery(db)
      .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, workspaceId)))
      .limit(1);
    // A token never "leaves": removing its own creator needs members:manage.
    const isSelf = !principal.token && target?.user_id === principal.user.id;
    const m = await requireWorkspace(c, workspaceId, isSelf ? "workspace:read" : "members:manage");
    if (!target) throw notFound("Member");
    if (target.role === "owner" && !isSelf && m.role !== "owner") {
      throw new ApiError(403, "forbidden", "Only owners can remove an owner");
    }
    // The user's teams and direct grants in this workspace go in the same
    // batch, but only once the guarded delete above them actually removed
    // the membership.
    const gone = notExists(
      db
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, target.user_id),
          ),
        ),
    );
    const [[removed]] = await db.batch([
      db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.id, memberId),
            eq(workspaceMembers.workspaceId, workspaceId),
            keepsAnOwner(workspaceId),
            m.role === "owner" || isSelf ? undefined : notAnOwner(),
          ),
        )
        .returning({ id: workspaceMembers.id }),
      db
        .delete(teamMembers)
        .where(
          and(
            eq(teamMembers.userId, target.user_id),
            inArray(
              teamMembers.teamId,
              db.select({ id: teams.id }).from(teams).where(eq(teams.workspaceId, workspaceId)),
            ),
            gone,
          ),
        ),
      db
        .delete(projectAccessGrants)
        .where(
          and(
            eq(projectAccessGrants.userId, target.user_id),
            inArray(
              projectAccessGrants.projectId,
              db
                .select({ id: projects.id })
                .from(projects)
                .where(eq(projects.workspaceId, workspaceId)),
            ),
            gone,
          ),
        ),
    ]);
    if (!removed) throw m.role === "owner" || isSelf ? lastOwner() : ownerChanged();
    await recordAudit(db, {
      workspaceId,
      ...actorOf(principal),
      action: isSelf ? "member.left" : "member.removed",
      targetType: "member",
      targetId: memberId,
      metadata: { user_id: target.user_id, email: target.email },
      ip: clientIp(c),
    });
    await revalidateWorkspace(db, c.env, workspaceId, { userIds: [target.user_id] });
    return c.body(null, 204);
  });

/**
 * Workspace invitations. Invites are the only way to create an account after
 * setup, so accepting one may also sign the user up.
 *
 * @module
 */
import { createRoute, z } from "@hono/zod-openapi";
import { type Db, invites, users, workspaceMembers, workspaces } from "@roundhouse/db";
import { newId } from "@roundhouse/shared";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  clientIp,
  createRouter,
  currentUser,
  originOf,
  requireWorkspace,
  signUp,
} from "../context";
import { auditInsert, recordAudit } from "../lib/audit";
import { forwardCookies } from "../lib/cookies";
import { hashToken, randomToken } from "../lib/crypto";
import { ApiError, notFound } from "../lib/errors";
import {
  body,
  errors,
  InviteSchema,
  json,
  Millis,
  RoleSchema,
  sessionAuth,
  WorkspaceParams,
} from "../schemas";

/** How long an invite link stays valid. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// TODO(phase-1): The invite token travels in the URL path, so it can reach
// Workers logs and observability traces. Move it to the request body, or log
// only its hash, before logs are shipped anywhere.
const TokenParams = z.object({ token: z.string().min(1).max(200) });

const AcceptBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(12).max(256).optional(),
});

const list = createRoute({
  method: "get",
  path: "/v1/workspaces/{workspaceId}/invites",
  tags: ["invites"],
  summary: "List pending invites",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: { 200: json(z.object({ invites: z.array(InviteSchema) })), ...errors(401, 403, 404) },
});

const create = createRoute({
  method: "post",
  path: "/v1/workspaces/{workspaceId}/invites",
  tags: ["invites"],
  summary: "Invite someone by email",
  security: sessionAuth,
  request: {
    params: WorkspaceParams,
    ...body(z.object({ email: z.email().max(254), role: RoleSchema })),
  },
  responses: {
    201: json(z.object({ invite: InviteSchema, url: z.string() }), "Created"),
    ...errors(400, 401, 403, 404, 409),
  },
});

const revoke = createRoute({
  method: "delete",
  path: "/v1/workspaces/{workspaceId}/invites/{inviteId}",
  tags: ["invites"],
  summary: "Revoke a pending invite",
  security: sessionAuth,
  request: { params: WorkspaceParams.extend({ inviteId: z.string() }) },
  responses: { 204: { description: "Revoked" }, ...errors(401, 403, 404) },
});

const preview = createRoute({
  method: "get",
  path: "/v1/invites/{token}",
  tags: ["invites"],
  summary: "Preview an invite (public)",
  request: { params: TokenParams },
  responses: {
    200: json(
      z.object({
        workspace_name: z.string(),
        email: z.string(),
        role: RoleSchema,
        expires_at: Millis,
      }),
    ),
    ...errors(404),
  },
});

const accept = createRoute({
  method: "post",
  path: "/v1/invites/{token}/accept",
  tags: ["invites"],
  summary: "Accept an invite, creating an account if signed out",
  request: {
    params: TokenParams,
    body: { required: false, content: { "application/json": { schema: AcceptBody } } },
  },
  responses: {
    200: json(z.object({ workspace_id: z.string() })),
    ...errors(400, 403, 404, 409, 429),
  },
});

const toInvite = (row: typeof invites.$inferSelect) => ({
  id: row.id,
  email: row.email,
  role: row.role,
  expires_at: +row.expiresAt,
  created_at: +row.createdAt,
});

const isPending = () => and(isNull(invites.acceptedAt), gt(invites.expiresAt, new Date()));

async function findPending(db: Db, token: string) {
  const [row] = await db
    .select({ invite: invites, workspaceName: workspaces.name })
    .from(invites)
    .innerJoin(workspaces, eq(workspaces.id, invites.workspaceId))
    .where(
      and(eq(invites.tokenHash, await hashToken(token)), isPending(), isNull(workspaces.deletedAt)),
    )
    .limit(1);
  return row;
}

/** Routes for invite management and acceptance. */
export const inviteRoutes = createRouter()
  .openapi(list, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, "members:manage");
    const rows = await c
      .get("db")
      .select()
      .from(invites)
      .where(and(eq(invites.workspaceId, workspaceId), isPending()))
      .orderBy(desc(invites.createdAt));
    return c.json({ invites: rows.map(toInvite) }, 200);
  })
  .openapi(create, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { role } = c.req.valid("json");
    const email = c.req.valid("json").email.toLowerCase();
    const m = await requireWorkspace(c, workspaceId, "members:manage");
    if (role === "owner" && m.role !== "owner") {
      throw new ApiError(403, "forbidden", "Only owners can invite owners");
    }
    const db = c.get("db");
    const [existing] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(sql`lower(${users.email})`, email)),
      )
      .limit(1);
    if (existing) throw new ApiError(409, "conflict", `${email} is already a member`);
    const [pending] = await db
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.workspaceId, workspaceId), eq(invites.email, email), isPending()))
      .limit(1);
    if (pending) {
      throw new ApiError(409, "conflict", `${email} already has a pending invite; revoke it first`);
    }

    const token = randomToken("inv");
    const [row] = await db
      .insert(invites)
      .values({
        id: newId("invite"),
        workspaceId,
        email,
        role,
        tokenHash: await hashToken(token),
        invitedBy: m.user.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();
    await recordAudit(db, {
      workspaceId,
      ...m.actor,
      action: "invite.created",
      targetType: "invite",
      targetId: row!.id,
      metadata: { email, role },
      ip: clientIp(c),
    });
    // TODO(phase-1): email the link once a mail provider is configured; until
    // then the inviter copies it from the dashboard.
    return c.json({ invite: toInvite(row!), url: `${originOf(c)}/invite/${token}` }, 201);
  })
  .openapi(revoke, async (c) => {
    const { workspaceId, inviteId } = c.req.valid("param");
    const m = await requireWorkspace(c, workspaceId, "members:manage");
    const [row] = await c
      .get("db")
      .delete(invites)
      .where(
        and(
          eq(invites.id, inviteId),
          eq(invites.workspaceId, workspaceId),
          isNull(invites.acceptedAt),
        ),
      )
      .returning({ id: invites.id, email: invites.email });
    if (!row) throw notFound("Invite");
    await recordAudit(c.get("db"), {
      workspaceId,
      ...m.actor,
      action: "invite.revoked",
      targetType: "invite",
      targetId: inviteId,
      metadata: { email: row.email },
      ip: clientIp(c),
    });
    return c.body(null, 204);
  })
  .openapi(preview, async (c) => {
    const found = await findPending(c.get("db"), c.req.valid("param").token);
    if (!found) throw notFound("Invite");
    return c.json(
      {
        workspace_name: found.workspaceName,
        email: found.invite.email,
        role: found.invite.role,
        expires_at: +found.invite.expiresAt,
      },
      200,
    );
  })
  .openapi(accept, async (c) => {
    const { token } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = c.get("db");
    const found = await findPending(db, token);
    if (!found) throw notFound("Invite");
    const { invite } = found;

    const user = await currentUser(c);
    if (user) {
      // SECURITY: The link is a bearer secret, but binding it to the invited
      // address stops a forwarded link from granting access to another account.
      if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw new ApiError(
          403,
          "email_mismatch",
          `This invite is for ${invite.email}; you're signed in as ${user.email}`,
        );
      }
    } else {
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(sql`lower(${users.email})`, invite.email.toLowerCase()))
        .limit(1);
      if (existing) {
        throw new ApiError(
          409,
          "account_exists",
          "An account with this email exists; sign in first",
        );
      }
    }
    const signUpInput =
      user || !input.name || !input.password
        ? undefined
        : { name: input.name, email: invite.email, password: input.password };
    if (!user && !signUpInput) {
      throw new ApiError(
        400,
        "invalid_request",
        "name and a password of 12+ characters are required",
      );
    }

    // Claim before creating anything, so a link redeemed twice in a race
    // can't leave an orphaned account behind.
    const [claimed] = await db
      .update(invites)
      .set({ acceptedAt: new Date() })
      .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt)))
      .returning({ id: invites.id });
    if (!claimed) throw notFound("Invite");

    let createdUserId: string | undefined;
    let cookies: Headers | undefined;
    try {
      let userId: string;
      if (signUpInput) {
        // SECURITY: The email stays unverified. Whoever holds the link chose the
        // password, and an inviter could address it to someone else's mailbox, so
        // the link proves nothing about who owns the address. Future
        // verified-email account linking must not trust these accounts.
        const created = await signUp(c, signUpInput);
        createdUserId = userId = created.userId;
        cookies = created.headers;
      } else {
        userId = user!.id;
      }

      const [membership] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, invite.workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        )
        .limit(1);
      await db.batch([
        db
          .insert(workspaceMembers)
          .values({
            id: newId("member"),
            workspaceId: invite.workspaceId,
            userId,
            role: invite.role,
          })
          .onConflictDoNothing(),
        auditInsert(db, {
          workspaceId: invite.workspaceId,
          actorType: "user",
          actorId: userId,
          action: "invite.accepted",
          targetType: "invite",
          targetId: invite.id,
          metadata: membership
            ? { role: membership.role, invited_role: invite.role, already_member: true }
            : { role: invite.role },
          ip: clientIp(c),
        }),
      ]);
    } catch (err) {
      // Leave no half-accepted state behind: the link works again and no
      // account exists that its holder never got a session for.
      await db.update(invites).set({ acceptedAt: null }).where(eq(invites.id, invite.id));
      if (createdUserId) await db.delete(users).where(eq(users.id, createdUserId));
      throw err;
    }

    if (cookies) forwardCookies(c, cookies);
    return c.json({ workspace_id: invite.workspaceId }, 200);
  });

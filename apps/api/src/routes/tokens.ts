/**
 * A workspace's API tokens: list, create (the secret is returned once) and
 * revoke. Managing tokens needs `tokens:manage`; a token can only do it when
 * it carries that scope, and can't hand out scopes it doesn't hold.
 *
 * @module
 */
import { apiTokens, users } from "@roundhouse/db";
import { type Action, scopesBeyondRole } from "@roundhouse/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { clientIp, createRouter, requireWorkspace } from "../context";
import { createApiToken, listApiTokens, policyOf, revokeApiToken } from "../contracts";
import { issueApiToken, toApiToken } from "../lib/api-tokens";
import { auditInsert, recordAudit } from "../lib/audit";
import { ApiError, notFound } from "../lib/errors";
import { revalidateWorkspace } from "../lib/realtime";

const DAY_MS = 24 * 60 * 60 * 1000;

/** API token routes. */
export const tokenRoutes = createRouter()
  .openapi(listApiTokens, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, policyOf(listApiTokens).action!);
    const rows = await c
      .get("db")
      .select({ token: apiTokens, creatorName: users.name })
      .from(apiTokens)
      .leftJoin(users, eq(users.id, apiTokens.userId))
      .where(and(eq(apiTokens.workspaceId, workspaceId), eq(apiTokens.kind, "api")))
      .orderBy(desc(apiTokens.id));
    return c.json({ tokens: rows.map((r) => toApiToken(r.token, r.creatorName)) }, 200);
  })
  .openapi(createApiToken, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const m = await requireWorkspace(c, workspaceId, policyOf(createApiToken).action!);
    const beyondRole = scopesBeyondRole(m.role, body.scopes);
    if (beyondRole.length) {
      throw new ApiError(
        403,
        "forbidden",
        `Your role (${m.role}) cannot grant ${beyondRole.join(", ")}`,
      );
    }
    // SECURITY: A token minting a token could otherwise widen its own reach.
    const held = m.principal.token?.scopes;
    const beyondToken = held ? body.scopes.filter((s) => !held.includes(s as Action)) : [];
    if (beyondToken.length) {
      throw new ApiError(
        403,
        "forbidden",
        `This API token cannot grant scopes it lacks: ${beyondToken.join(", ")}`,
      );
    }
    const db = c.get("db");
    const { secret, row } = await issueApiToken({
      workspaceId,
      userId: m.user.id,
      name: body.name,
      scopes: body.scopes,
      expiresAt:
        body.expires_in_days === null ? null : new Date(Date.now() + body.expires_in_days * DAY_MS),
    });
    const [[created]] = await db.batch([
      db.insert(apiTokens).values(row).returning(),
      auditInsert(db, {
        workspaceId,
        ...m.actor,
        action: "token.created",
        targetType: "api_token",
        targetId: row.id,
        metadata: {
          name: body.name,
          scopes: body.scopes,
          expires_at: row.expiresAt ? +row.expiresAt : null,
        },
        ip: clientIp(c),
      }),
    ]);
    return c.json({ token: toApiToken(created!, m.user.name), secret }, 201);
  })
  .openapi(revokeApiToken, async (c) => {
    const { workspaceId, tokenId } = c.req.valid("param");
    const m = await requireWorkspace(c, workspaceId, policyOf(revokeApiToken).action!);
    const db = c.get("db");
    const [token] = await db
      .select({ id: apiTokens.id, name: apiTokens.name, revokedAt: apiTokens.revokedAt })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.id, tokenId),
          eq(apiTokens.workspaceId, workspaceId),
          eq(apiTokens.kind, "api"),
        ),
      )
      .limit(1);
    if (!token) throw notFound("Token");
    const [revoked] = await db
      .update(apiTokens)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(apiTokens.id, tokenId), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    if (revoked) {
      await recordAudit(db, {
        workspaceId,
        ...m.actor,
        action: "token.revoked",
        targetType: "api_token",
        targetId: tokenId,
        metadata: { name: token.name },
        ip: clientIp(c),
      });
      await revalidateWorkspace(db, c.env, workspaceId, { tokenIds: [tokenId] });
    }
    return c.body(null, 204);
  });

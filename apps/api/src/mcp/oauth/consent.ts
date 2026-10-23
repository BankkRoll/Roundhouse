/**
 * Handlers for the dashboard's MCP OAuth routes (`contracts/oauth.ts`): the
 * consent screen's data and decision, and the user's connected clients.
 *
 * Consent re-validates the forwarded request from scratch (the browser
 * carried it, so nothing about it is trusted), checks the consent ticket
 * against the session, and caps the approved scopes by the user's role in
 * the chosen workspace. The code it issues is single use and lives 60 s.
 *
 * @module
 */
import { workspaceMembers, workspaces } from "@roundhouse/db";
import { type ApiTokenScope, scopesBeyondRole } from "@roundhouse/shared";
import { and, eq, isNull } from "drizzle-orm";
import {
  type AppContext,
  clientIp,
  createRouter,
  requireKeys,
  requirePrincipal,
} from "../../context";
import {
  decideOAuthConsent,
  getOAuthConsent,
  listMcpClients,
  revokeMcpClient,
} from "../../contracts/oauth";
import { recordAudit } from "../../lib/audit";
import { ApiError, notFound } from "../../lib/errors";
import {
  type AuthorizationParams,
  type AuthorizationRequest,
  isRejection,
  issueAuthorizationCode,
  redirectWith,
  signConsentTicket,
  validateAuthorization,
  verifyConsentTicket,
} from "./authorize";
import { issuerOf, mcpOAuthEnabled, mcpResourceOf } from "./config";
import { OAuthFailure } from "./errors";
import { findUserGrant, listConnectedClients, revokeGrant } from "./grants";
import { rateLimit } from "./routes";

/** The session user and session, refusing tokens like every session-only route. */
async function sessionHolder(c: AppContext) {
  const principal = await requirePrincipal(c);
  if (principal.token || !principal.session) {
    throw new ApiError(
      403,
      "forbidden",
      "API tokens can't be used for this request; sign in instead",
    );
  }
  return { user: principal.user, sessionId: principal.session.id };
}

async function requireEnabled(c: AppContext) {
  if (!(await mcpOAuthEnabled(c))) {
    throw new ApiError(403, "forbidden", "MCP is disabled on this instance");
  }
}

async function validated(
  c: AppContext,
  params: AuthorizationParams,
): Promise<AuthorizationRequest> {
  let result: Awaited<ReturnType<typeof validateAuthorization>>;
  try {
    result = await validateAuthorization(params, {
      db: c.get("db"),
      issuer: issuerOf(c),
      resource: mcpResourceOf(c),
      beforeClientFetch: () => rateLimit(c, "oauth-client"),
    });
  } catch (err) {
    if (err instanceof OAuthFailure) throw new ApiError(400, "invalid_request", err.description);
    throw err;
  }
  if (isRejection(result) && result.failure.status === 429) {
    throw new ApiError(429, "rate_limited", result.failure.description);
  }
  if (isRejection(result)) {
    throw new ApiError(
      400,
      "invalid_request",
      `${result.failure.code}: ${result.failure.description}`,
    );
  }
  return result;
}

async function memberships(c: AppContext, userId: string) {
  return c
    .get("db")
    .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt)))
    .orderBy(workspaces.name);
}

/** The consent and connected-client routes. */
export const oauthConsentRoutes = createRouter()
  .openapi(getOAuthConsent, async (c) => {
    const holder = await sessionHolder(c);
    await requireEnabled(c);
    const params = c.req.valid("query");
    const request = await validated(c, params);
    const { ticket, expiresAt } = await signConsentTicket(
      requireKeys(c),
      {
        userId: holder.user.id,
        sessionId: holder.sessionId,
      },
      params,
    );
    const rows = await memberships(c, holder.user.id);
    return c.json(
      {
        client: {
          client_id: request.client.clientId,
          name: request.client.name,
          domain: request.client.domain,
          logo_uri: request.client.logoUri,
          client_uri: request.client.clientUri,
        },
        redirect_uri: request.redirectUri,
        scopes: request.scopes,
        workspaces: rows.map((w) => {
          const beyond = new Set<string>(scopesBeyondRole(w.role, request.scopes));
          return {
            id: w.id,
            name: w.name,
            role: w.role,
            grantable_scopes: request.scopes.filter((s) => !beyond.has(s)),
          };
        }),
        consent_token: ticket,
        expires_at: expiresAt,
      },
      200,
    );
  })
  .openapi(decideOAuthConsent, async (c) => {
    const holder = await sessionHolder(c);
    await requireEnabled(c);
    const input = c.req.valid("json");
    const request = await validated(c, input.request);
    const ok = await verifyConsentTicket(
      requireKeys(c),
      input.consent_token,
      { userId: holder.user.id, sessionId: holder.sessionId },
      input.request,
    );
    if (!ok) {
      throw new ApiError(
        400,
        "invalid_request",
        "This consent screen expired; start again from the app",
      );
    }
    const issuer = issuerOf(c);
    if (input.decision === "deny") {
      const redirect_to = redirectWith(request.redirectUri, {
        error: "access_denied",
        error_description: "The user denied access",
        state: request.state,
        iss: issuer,
      });
      return c.json({ redirect_to }, 200);
    }
    const workspaceId = input.workspace_id!;
    const scopes = input.scopes! as ApiTokenScope[];
    const membership = (await memberships(c, holder.user.id)).find((w) => w.id === workspaceId);
    if (!membership) throw notFound("Workspace");
    const unrequested = scopes.filter((s) => !request.scopes.includes(s));
    if (unrequested.length) {
      throw new ApiError(
        400,
        "invalid_request",
        `Not requested by the app: ${unrequested.join(", ")}`,
      );
    }
    const beyondRole = scopesBeyondRole(membership.role, scopes);
    if (beyondRole.length) {
      throw new ApiError(
        403,
        "forbidden",
        `Your role (${membership.role}) cannot grant ${beyondRole.join(", ")}`,
      );
    }
    const db = c.get("db");
    const code = await issueAuthorizationCode(db, {
      request,
      userId: holder.user.id,
      workspaceId,
      scopes,
    });
    await recordAudit(db, {
      workspaceId,
      actorType: "user",
      actorId: holder.user.id,
      action: "mcp_client.authorized",
      targetType: "mcp_client",
      targetId: request.client.clientId,
      metadata: {
        name: request.client.name,
        client_id: request.client.clientId,
        domain: request.client.domain,
        scopes,
      },
      ip: clientIp(c),
    });
    return c.json(
      {
        redirect_to: redirectWith(request.redirectUri, { code, state: request.state, iss: issuer }),
      },
      200,
    );
  })
  .openapi(listMcpClients, async (c) => {
    const { user } = await sessionHolder(c);
    return c.json({ clients: await listConnectedClients(c.get("db"), user.id) }, 200);
  })
  .openapi(revokeMcpClient, async (c) => {
    const { user } = await sessionHolder(c);
    const { grantId } = c.req.valid("param");
    const db = c.get("db");
    const grant = await findUserGrant(db, user.id, grantId);
    if (!grant) throw notFound("Connected client");
    await revokeGrant(
      db,
      grant.id,
      "user",
      { actorType: "user", actorId: user.id },
      {
        ip: clientIp(c),
      },
    );
    return c.body(null, 204);
  });

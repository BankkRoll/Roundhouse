/**
 * Schemas of the dashboard's MCP OAuth routes: the consent screen for an
 * authorization request and the user's connected MCP clients (ADR 0012
 * section 1). The OAuth protocol endpoints themselves (`/oauth/*`,
 * `/.well-known/*`) speak RFC 6749 forms and are not part of this API.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { API_TOKEN_SCOPES, ROLES } from "@roundhouse/shared";

const Millis = z.number().int().openapi({ description: "Unix time in milliseconds" });

const Param = z.string().max(4096).optional();

const Scope = z.enum(API_TOKEN_SCOPES);

/**
 * The authorization request's parameters, exactly as the client sent them
 * to `/oauth/authorize` (which forwarded them to the consent screen).
 */
export const AuthorizationParamsSchema = z
  .object({
    response_type: Param,
    client_id: Param,
    redirect_uri: Param,
    state: Param,
    code_challenge: Param,
    code_challenge_method: Param,
    resource: Param,
    scope: Param,
  })
  .openapi("OAuthAuthorizationParams");

/** What the consent screen shows, and the ticket that submits it. */
export const OAuthConsentSchema = z
  .object({
    client: z.object({
      /** The client metadata document URL. */
      client_id: z.string(),
      name: z.string(),
      /** Host of `client_id`; always shown, since the name is self-asserted. */
      domain: z.string(),
      logo_uri: z.string().nullable(),
      client_uri: z.string().nullable(),
    }),
    redirect_uri: z.string(),
    /** Scopes the client asked for (the read preset when it asked for none). */
    scopes: z.array(Scope),
    /** Workspaces the user can connect, with the requested scopes their role there allows. */
    workspaces: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        role: z.enum(ROLES),
        grantable_scopes: z.array(Scope),
      }),
    ),
    /** Echo in the decision; binds it to this request and session. */
    consent_token: z.string(),
    expires_at: Millis,
  })
  .openapi("OAuthConsent");

/** Body of `POST /v1/oauth/authorization`. */
export const OAuthDecisionSchema = z
  .object({
    request: AuthorizationParamsSchema,
    consent_token: z.string().max(4096),
    decision: z.enum(["approve", "deny"]),
    /** Required to approve. */
    workspace_id: z.string().max(128).optional(),
    /** Required to approve: a non-empty subset of the requested scopes. */
    scopes: z
      .array(Scope)
      .max(API_TOKEN_SCOPES.length)
      .refine((s) => new Set(s).size === s.length, { message: "scopes must be unique" })
      .optional(),
  })
  .refine((b) => b.decision === "deny" || (b.workspace_id && b.scopes?.length), {
    message: "approving needs workspace_id and at least one scope",
  })
  .openapi("OAuthDecision");

/** Where the dashboard sends the browser next: the client's redirect URI. */
export const OAuthRedirectSchema = z.object({ redirect_to: z.string() }).openapi("OAuthRedirect");

/** One MCP client the user has connected. */
export const ConnectedMcpClientSchema = z
  .object({
    id: z.string(),
    client_id: z.string(),
    name: z.string(),
    domain: z.string(),
    workspace: z.object({ id: z.string(), name: z.string() }),
    scopes: z.array(Scope),
    created_at: Millis,
    last_used_at: Millis.nullable(),
    /** When the grant lapses unless the client refreshes before then. */
    expires_at: Millis,
  })
  .openapi("ConnectedMcpClient");

/** `{grantId}` path param. */
export const OAuthGrantParams = z.object({ grantId: z.string() });

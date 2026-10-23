/**
 * MCP OAuth routes the dashboard calls (ADR 0012 section 1): the consent
 * screen for an authorization request, and the signed-in user's connected
 * MCP clients. Browser session only; `action: null` means any signed-in
 * user, since a grant is the user's own and its scopes are capped by their
 * role in the chosen workspace.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { body, errors, json, sessionOnlyAuth } from "../schemas";
import {
  AuthorizationParamsSchema,
  ConnectedMcpClientSchema,
  OAuthConsentSchema,
  OAuthDecisionSchema,
  OAuthGrantParams,
  OAuthRedirectSchema,
} from "../schemas/oauth";
import { defineRoute } from "./policy";

/**
 * Validates an authorization request forwarded by `/oauth/authorize` and
 * returns what the consent screen shows. 400 `invalid_request` when the
 * request is no longer valid; 403 when MCP is disabled; 429 when client
 * metadata fetches from this address are over budget.
 */
export const getOAuthConsent = defineRoute(
  { auth: "session_only", action: null, audit: [] },
  {
    method: "get",
    path: "/v1/oauth/authorization",
    tags: ["oauth"],
    summary: "Describe an MCP authorization request",
    security: sessionOnlyAuth,
    request: { query: AuthorizationParamsSchema },
    responses: { 200: json(OAuthConsentSchema), ...errors(400, 401, 403, 429) },
  },
);

/**
 * Approves or denies an authorization request. Approval issues a 60-second
 * single-use code bound to the workspace and scopes chosen; either way the
 * response names the client redirect URI to send the browser to.
 */
export const decideOAuthConsent = defineRoute(
  { auth: "session_only", action: null, audit: ["mcp_client.authorized"] },
  {
    method: "post",
    path: "/v1/oauth/authorization",
    tags: ["oauth"],
    summary: "Approve or deny an MCP authorization request",
    security: sessionOnlyAuth,
    request: body(OAuthDecisionSchema),
    responses: { 200: json(OAuthRedirectSchema), ...errors(400, 401, 403, 404, 429) },
  },
);

/** The signed-in user's connected MCP clients (live grants), newest first. */
export const listMcpClients = defineRoute(
  { auth: "session_only", action: null, audit: [] },
  {
    method: "get",
    path: "/v1/oauth/grants",
    tags: ["oauth"],
    summary: "List my connected MCP clients",
    security: sessionOnlyAuth,
    responses: {
      200: json(z.object({ clients: z.array(ConnectedMcpClientSchema) })),
      ...errors(401, 403),
    },
  },
);

/** Disconnects one of the user's MCP clients: its grant and every token under it stop working. */
export const revokeMcpClient = defineRoute(
  { auth: "session_only", action: null, audit: ["mcp_client.revoked"] },
  {
    method: "delete",
    path: "/v1/oauth/grants/{grantId}",
    tags: ["oauth"],
    summary: "Disconnect an MCP client",
    security: sessionOnlyAuth,
    request: { params: OAuthGrantParams },
    responses: { 204: { description: "Disconnected" }, ...errors(401, 403, 404) },
  },
);

/** Every MCP OAuth dashboard route, by name. */
export const OAUTH_ROUTES = {
  getOAuthConsent,
  decideOAuthConsent,
  listMcpClients,
  revokeMcpClient,
} as const;

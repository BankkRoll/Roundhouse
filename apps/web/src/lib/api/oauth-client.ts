/**
 * Typed endpoint functions for MCP OAuth: the consent screen an MCP client's sign-in
 * lands on, and the signed-in user's connected clients. Every call goes through
 * {@link request}, like `api`.
 *
 * @module
 */
import { request } from "./client";
import type {
  AuthorizationParams,
  ConnectedMcpClient,
  OAuthConsent,
  OAuthDecision,
} from "./oauth-types";

const seg = encodeURIComponent;

/**
 * MCP OAuth endpoints, one per route in `OAUTH_ROUTES`.
 *
 * @example
 * const consent = await oauthApi.getConsent({ client_id, redirect_uri, ... });
 */
export const oauthApi = {
  /**
   * Validates an authorization request and describes it for the consent screen.
   *
   * @param params - The request's parameters, from the page URL.
   * @param signal - Abort signal.
   * @returns The client, the scopes it asks for, the user's workspaces and a consent token.
   */
  getConsent: (params: AuthorizationParams, signal?: AbortSignal) =>
    request<OAuthConsent>("GET", "/v1/oauth/authorization", { query: { ...params }, signal }),
  /**
   * Approves or denies the request.
   *
   * @param body - The request, the consent token, and the workspace and scopes approved.
   * @returns Where to send the browser: the client's redirect URI with a code or an error.
   */
  decide: (body: OAuthDecision) =>
    request<{ redirect_to: string }>("POST", "/v1/oauth/authorization", { body }),
  /**
   * Lists the signed-in user's connected MCP clients.
   *
   * @param signal - Abort signal.
   * @returns Live grants, newest first.
   */
  listClients: (signal?: AbortSignal) =>
    request<{ clients: ConnectedMcpClient[] }>("GET", "/v1/oauth/grants", { signal }),
  /**
   * Disconnects a client: its grant and every token under it stop working.
   *
   * @param grantId - Grant id.
   */
  revokeClient: (grantId: string) => request<void>("DELETE", `/v1/oauth/grants/${seg(grantId)}`),
};

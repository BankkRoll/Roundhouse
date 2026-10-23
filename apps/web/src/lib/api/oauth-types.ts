/**
 * Wire types for the MCP OAuth dashboard routes (the consent screen and connected
 * clients), derived from the API's route definitions (`apps/api/src/contracts/oauth.ts`)
 * so the dashboard cannot drift from them.
 *
 * Type-only: nothing from the API source reaches the bundle.
 *
 * @module
 */
import type {
  BodyOf,
  decideOAuthConsent,
  getOAuthConsent,
  listMcpClients,
  QueryOf,
  ResponseOf,
} from "../../../../api/src/contracts";

/** The authorization request's parameters, as `/oauth/authorize` forwarded them. */
export type AuthorizationParams = QueryOf<typeof getOAuthConsent>;
/** What the consent screen shows: client, requested scopes, workspaces, and its ticket. */
export type OAuthConsent = ResponseOf<typeof getOAuthConsent, 200>;
/** A workspace the user can connect the client to. */
export type ConsentWorkspace = OAuthConsent["workspaces"][number];
/** `POST /v1/oauth/authorization` body. */
export type OAuthDecision = BodyOf<typeof decideOAuthConsent>;
/** One MCP client the signed-in user has connected. */
export type ConnectedMcpClient = ResponseOf<typeof listMcpClients, 200>["clients"][number];

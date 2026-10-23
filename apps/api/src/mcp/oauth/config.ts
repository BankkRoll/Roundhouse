/**
 * Fixed parameters of the MCP authorization server (ADR 0012 section 1) and
 * the URLs derived from the control plane's public origin: the issuer, the
 * protected resource (`/mcp`), and both discovery documents.
 *
 * @module
 */
import {
  type AuthorizationServerMetadata,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";
import { API_TOKEN_PRESETS, API_TOKEN_SCOPES } from "@roundhouse/shared";
import { type AppContext, originOf } from "../../context";
import { getMcpEnabled } from "../../lib/settings";

/** Path of the protected resource; the same as `MCP_PATH` in `../route`. */
const MCP_PATH = "/mcp";

/** Lifetime of an authorization code (ADR 0012: single use, 60 s). */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;

/** Lifetime of an access token (ADR 0012: 1 h). */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Sliding lifetime of a grant's refresh token (ADR 0012: 30 days). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a consent screen stays submittable after it was shown. */
export const CONSENT_TTL_MS = 10 * 60 * 1000;

/** Secret prefixes, so leaked credentials are recognisable to scanners and humans. */
export const OAUTH_ACCESS_TOKEN_PREFIX = "oat_";
export const OAUTH_REFRESH_TOKEN_PREFIX = "ort_";
export const OAUTH_CODE_PREFIX = "oac_";

/** Scopes granted when a client asks for none: the read preset. */
export const DEFAULT_OAUTH_SCOPES: readonly string[] = API_TOKEN_PRESETS.read;

/** Scopes advertised in a bare 401 challenge, the least a useful session needs. */
const CHALLENGE_SCOPES = ["projects:read", "services:read"];

const AUTHORIZE_PATH = "/oauth/authorize";
const TOKEN_PATH = "/oauth/token";
const REVOKE_PATH = "/oauth/revoke";

/**
 * The authorization server's issuer identifier (RFC 8414): the public origin.
 *
 * @param c - Request context.
 * @returns E.g. `https://cp.example.com`.
 */
export function issuerOf(c: AppContext): string {
  return originOf(c);
}

/**
 * The protected resource every access token is bound to (RFC 8707).
 *
 * @param c - Request context.
 * @returns E.g. `https://cp.example.com/mcp`.
 */
export function mcpResourceOf(c: AppContext): string {
  return `${originOf(c)}${MCP_PATH}`;
}

/**
 * Where the `/mcp` protected resource metadata lives (RFC 9728, path-suffixed).
 *
 * @param c - Request context.
 * @returns E.g. `https://cp.example.com/.well-known/oauth-protected-resource/mcp`.
 */
export function resourceMetadataUrlOf(c: AppContext): string {
  return getOAuthProtectedResourceMetadataUrl(new URL(mcpResourceOf(c)));
}

/**
 * The `WWW-Authenticate` value of a 401 from `/mcp`, pointing clients at
 * discovery (RFC 9728 section 5.1).
 *
 * @param c - Request context.
 * @param error - `invalid_token` and its description, when a credential was presented.
 * @returns The header value.
 */
export function bearerChallenge(
  c: AppContext,
  error?: { code: "invalid_token"; description: string },
): string {
  const parts = [
    'Bearer realm="roundhouse"',
    `resource_metadata="${resourceMetadataUrlOf(c)}"`,
    `scope="${CHALLENGE_SCOPES.join(" ")}"`,
  ];
  if (error) {
    parts.push(`error="${error.code}"`, `error_description="${error.description}"`);
  }
  return parts.join(", ");
}

/**
 * RFC 8414 authorization server metadata.
 *
 * @param c - Request context.
 * @returns The document served at `/.well-known/oauth-authorization-server`.
 */
export function authorizationServerMetadata(c: AppContext): AuthorizationServerMetadata {
  const issuer = issuerOf(c);
  return {
    issuer,
    authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${TOKEN_PATH}`,
    revocation_endpoint: `${issuer}${REVOKE_PATH}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...API_TOKEN_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * RFC 9728 protected resource metadata for `/mcp`.
 *
 * @param c - Request context.
 * @returns The document served at both protected-resource well-known URLs.
 * @throws Error when the public origin is plain HTTP outside development.
 */
export function protectedResourceMetadata(c: AppContext): OAuthProtectedResourceMetadata {
  const doc = buildOAuthProtectedResourceMetadata({
    oauthMetadata: authorizationServerMetadata(c),
    resourceServerUrl: new URL(mcpResourceOf(c)),
    scopesSupported: [...API_TOKEN_SCOPES],
    resourceName: "Roundhouse",
    dangerouslyAllowInsecureIssuerUrl: c.env.ROUNDHOUSE_DEV === "1",
  });
  return { ...doc, bearer_methods_supported: ["header"] };
}

/** Paths of the authorization server's endpoints, for routing. */
export const OAUTH_PATHS = {
  authorize: AUTHORIZE_PATH,
  token: TOKEN_PATH,
  revoke: REVOKE_PATH,
} as const;

/**
 * Whether the MCP server, and with it every OAuth endpoint for MCP clients,
 * is enabled: the `mcp_enabled` instance setting (off by default). The one
 * check point for discovery, `/oauth/*` and the consent routes; `/mcp`
 * itself is gated by `../enabled.ts` on the same setting.
 *
 * @param c - Request context.
 * @returns `true` when MCP clients may discover, authorize and refresh.
 */
export function mcpOAuthEnabled(c: AppContext): Promise<boolean> {
  return getMcpEnabled(c.get("db"));
}

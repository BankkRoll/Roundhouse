/**
 * Authorization requests (OAuth 2.1 section 4.1.1 with PKCE, RFC 8707
 * resource indicators): parsing and validating one, building the redirect
 * that answers it, and the consent ticket that binds a consent screen to the
 * exact request and session it was shown for.
 *
 * Validation runs in two tiers. A bad `client_id` or `redirect_uri` is
 * answered directly, never by redirect, so the server can't be used to
 * bounce a browser to an unregistered address. Every later problem goes back
 * to the client's redirect URI as `error=…` with `state` and `iss`.
 *
 * @module
 */
import { type Db, oauthCodes } from "@roundhouse/db";
import { type ApiTokenScope, isApiTokenScope } from "@roundhouse/shared";
import { hashToken, randomToken, signState, verifyState } from "../../lib/crypto";
import { type OAuthClient, redirectUriMatches, resolveClient } from "./clients";
import {
  AUTHORIZATION_CODE_TTL_MS,
  CONSENT_TTL_MS,
  DEFAULT_OAUTH_SCOPES,
  OAUTH_CODE_PREFIX,
} from "./config";
import { type OAuthErrorCode, OAuthFailure } from "./errors";

/** The parameters of an authorization request, as the client sent them. */
export interface AuthorizationParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
  scope?: string;
}

/** Names of {@link AuthorizationParams}, in a stable order. */
export const AUTHORIZATION_PARAM_NAMES = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "scope",
] as const satisfies readonly (keyof AuthorizationParams)[];

/** A request that passed every check. */
export interface AuthorizationRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  /** What the client asked for, or the read preset when it asked for nothing. */
  scopes: ApiTokenScope[];
  /** The request as received, for echoing back to the consent route. */
  params: AuthorizationParams;
}

/** A failed request: answered directly, or by redirect to the client. */
export type AuthorizationRejection =
  | { kind: "direct"; failure: OAuthFailure }
  | { kind: "redirect"; failure: OAuthFailure; location: string };

const MAX_STATE_LENGTH = 1024;
const MAX_SCOPE_LENGTH = 2048;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Reads the authorization parameters from a query string.
 *
 * @param query - The request's search params.
 * @returns The parameters, or a direct `invalid_request` when one is repeated
 *   (RFC 6749 section 3.1).
 */
export function readAuthorizationParams(
  query: URLSearchParams,
): AuthorizationParams | AuthorizationRejection {
  const params: AuthorizationParams = {};
  for (const name of AUTHORIZATION_PARAM_NAMES) {
    const values = query.getAll(name);
    if (values.length > 1) {
      return { kind: "direct", failure: new OAuthFailure("invalid_request", `${name} repeated`) };
    }
    if (values[0] !== undefined) params[name] = values[0];
  }
  return params;
}

/**
 * Appends response parameters to a redirect URI, keeping its own query.
 *
 * @param redirectUri - The client's validated redirect URI.
 * @param params - `code` or `error` fields, plus `state` and `iss`.
 * @returns The absolute URL to send the browser to.
 */
export function redirectWith(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
}

/**
 * Parses a space-separated scope list.
 *
 * @param scope - The `scope` parameter, if any.
 * @returns The scopes, deduplicated; the read preset when absent or empty.
 * @throws {OAuthFailure} `invalid_scope` for an unknown or instance scope.
 */
export function parseScopes(scope: string | undefined): ApiTokenScope[] {
  if (scope !== undefined && scope.length > MAX_SCOPE_LENGTH) {
    throw new OAuthFailure("invalid_scope", "scope is too long");
  }
  const names = (scope ?? "").split(" ").filter(Boolean);
  if (names.length === 0) return [...DEFAULT_OAUTH_SCOPES] as ApiTokenScope[];
  const unknown = names.filter((s) => !isApiTokenScope(s));
  if (unknown.length) {
    throw new OAuthFailure("invalid_scope", `Unknown scope: ${unknown.slice(0, 5).join(" ")}`);
  }
  return [...new Set(names)] as ApiTokenScope[];
}

/**
 * Whether a `resource` parameter names `expected`, ignoring one trailing slash.
 *
 * @param resource - Untrusted parameter.
 * @param expected - The `/mcp` URL.
 * @returns `true` on a match.
 */
export function resourceMatches(resource: string, expected: string): boolean {
  return resource.replace(/\/$/, "") === expected;
}

/** What {@link validateAuthorization} needs besides the parameters. */
export interface ValidationContext {
  db: Db;
  issuer: string;
  resource: string;
  /** Called before fetching a client metadata document; throw to refuse. */
  beforeClientFetch?: () => Promise<void>;
}

/**
 * Validates an authorization request.
 *
 * @param params - The request's parameters.
 * @param ctx - Database, issuer and the expected resource.
 * @returns The request, or how to reject it.
 */
export async function validateAuthorization(
  params: AuthorizationParams,
  ctx: ValidationContext,
): Promise<AuthorizationRequest | AuthorizationRejection> {
  const direct = (code: OAuthErrorCode, description: string): AuthorizationRejection => ({
    kind: "direct",
    failure: new OAuthFailure(code, description),
  });
  if (!params.client_id) return direct("invalid_request", "client_id is required");
  if (!params.redirect_uri) return direct("invalid_request", "redirect_uri is required");
  let client: OAuthClient;
  try {
    client = await resolveClient(ctx.db, params.client_id, { beforeFetch: ctx.beforeClientFetch });
  } catch (err) {
    if (err instanceof OAuthFailure) return { kind: "direct", failure: err };
    throw err;
  }
  if (!redirectUriMatches(client.redirectUris, params.redirect_uri)) {
    return direct("invalid_request", "redirect_uri is not registered for this client");
  }
  const redirectUri = params.redirect_uri;

  const state = params.state;
  const back = (code: OAuthErrorCode, description: string): AuthorizationRejection => ({
    kind: "redirect",
    failure: new OAuthFailure(code, description),
    location: redirectWith(redirectUri, {
      error: code,
      error_description: description,
      ...(state ? { state } : {}),
      iss: ctx.issuer,
    }),
  });
  if (params.response_type !== "code") {
    return back("unsupported_response_type", "Only response_type=code is supported");
  }
  if (!state || state.length > MAX_STATE_LENGTH) {
    return back("invalid_request", `state is required (at most ${MAX_STATE_LENGTH} characters)`);
  }
  if (params.code_challenge_method !== "S256") {
    return back("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  if (!params.code_challenge || !PKCE_CHALLENGE.test(params.code_challenge)) {
    return back("invalid_request", "code_challenge must be a base64url S256 digest");
  }
  if (!params.resource) return back("invalid_target", `resource is required: ${ctx.resource}`);
  if (!resourceMatches(params.resource, ctx.resource)) {
    return back("invalid_target", `This server only issues tokens for ${ctx.resource}`);
  }
  let scopes: ApiTokenScope[];
  try {
    scopes = parseScopes(params.scope);
  } catch (err) {
    if (err instanceof OAuthFailure) return back(err.code, err.description);
    throw err;
  }
  return {
    client,
    redirectUri,
    state,
    codeChallenge: params.code_challenge,
    resource: ctx.resource,
    scopes,
    params,
  };
}

/**
 * Type guard separating a rejection from a validated request.
 *
 * @param value - Result of {@link validateAuthorization}.
 * @returns `true` for a rejection.
 */
export function isRejection(
  value: AuthorizationRequest | AuthorizationRejection | AuthorizationParams,
): value is AuthorizationRejection {
  return "kind" in value && (value.kind === "direct" || value.kind === "redirect");
}

// -----------------------------------------------------------------------------
// Consent ticket
// -----------------------------------------------------------------------------

const CONSENT_PURPOSE = "oauth-consent";

async function requestDigest(params: AuthorizationParams): Promise<string> {
  return hashToken(JSON.stringify(AUTHORIZATION_PARAM_NAMES.map((n) => params[n] || null)));
}

/** Who a consent ticket was issued to. */
export interface ConsentHolder {
  userId: string;
  sessionId: string;
}

/**
 * Signs a consent ticket: the request's digest bound to the session that saw
 * the consent screen, valid for {@link CONSENT_TTL_MS}.
 *
 * SECURITY: The consent POST is a cookie-authenticated mutation, so it is
 * already same-origin-only (`sameOriginMutations`). The ticket adds that the
 * approval names exactly the request the user was shown, in the same
 * session, recently; a forged or replayed body with other parameters fails.
 *
 * @param masterKey - Master key; the HMAC key is derived from it.
 * @param holder - The session's user and ID.
 * @param params - The request shown.
 * @returns The ticket and when it expires (unix ms).
 */
export async function signConsentTicket(
  masterKey: string,
  holder: ConsentHolder,
  params: AuthorizationParams,
): Promise<{ ticket: string; expiresAt: number }> {
  const ticket = await signState(
    masterKey,
    CONSENT_PURPOSE,
    { u: holder.userId, s: holder.sessionId, r: await requestDigest(params) },
    CONSENT_TTL_MS,
  );
  return { ticket, expiresAt: Date.now() + CONSENT_TTL_MS };
}

/**
 * Checks a consent ticket against the session and request.
 *
 * @param masterKey - Master key.
 * @param ticket - Untrusted ticket from the body.
 * @param holder - The session submitting it.
 * @param params - The request being approved.
 * @returns `true` when the ticket was issued for this session and request and hasn't expired.
 */
export async function verifyConsentTicket(
  masterKey: string,
  ticket: string,
  holder: ConsentHolder,
  params: AuthorizationParams,
): Promise<boolean> {
  const payload = await verifyState(masterKey, CONSENT_PURPOSE, ticket);
  return (
    payload !== null &&
    payload.u === holder.userId &&
    payload.s === holder.sessionId &&
    payload.r === (await requestDigest(params))
  );
}

// -----------------------------------------------------------------------------
// Codes
// -----------------------------------------------------------------------------

/** What an authorization code stands for. */
export interface CodeGrant {
  request: AuthorizationRequest;
  userId: string;
  workspaceId: string;
  scopes: readonly ApiTokenScope[];
}

/**
 * Mints a single-use authorization code and stores its hash.
 *
 * @param db - Database client.
 * @param grant - The approved request, user, workspace and scopes.
 * @param now - Current time, unix ms.
 * @returns The code (returned to the client once, in the redirect).
 */
export async function issueAuthorizationCode(
  db: Db,
  grant: CodeGrant,
  now = Date.now(),
): Promise<string> {
  const code = randomToken(OAUTH_CODE_PREFIX.slice(0, -1));
  await db.insert(oauthCodes).values({
    codeHash: await hashToken(code),
    clientId: grant.request.client.clientId,
    userId: grant.userId,
    workspaceId: grant.workspaceId,
    scopes: [...grant.scopes],
    redirectUri: grant.request.redirectUri,
    codeChallenge: grant.request.codeChallenge,
    resource: grant.request.resource,
    expiresAt: new Date(now + AUTHORIZATION_CODE_TTL_MS),
  });
  return code;
}

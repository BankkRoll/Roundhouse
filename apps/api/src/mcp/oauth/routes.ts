/**
 * The authorization server's public endpoints for MCP clients (ADR 0012
 * section 1). None of them read cookies except `/oauth/authorize`, which only
 * validates and hands the browser to the dashboard's consent screen.
 *
 * - `GET /.well-known/oauth-protected-resource[/mcp]`: RFC 9728 metadata.
 * - `GET /.well-known/oauth-authorization-server`: RFC 8414 metadata.
 * - `GET /oauth/authorize`: validates the request (client metadata document,
 *   exact redirect URI, PKCE S256, `state`, `resource`), then redirects to
 *   `/authorize` in the dashboard, which shows the consent screen.
 * - `POST /oauth/token`: `authorization_code` and `refresh_token` grants.
 * - `POST /oauth/revoke`: RFC 7009 revocation.
 *
 * Token and revocation responses are `no-store`; discovery, token and
 * revocation allow any origin (no credentials ride along), so browser-based
 * MCP clients can use them.
 *
 * @module
 */
import type { Context } from "hono";
import { type AppContext, type AppEnv, clientIp, createRouter } from "../../context";
import {
  type AuthorizationParams,
  isRejection,
  readAuthorizationParams,
  validateAuthorization,
} from "./authorize";
import { resolveClient } from "./clients";
import {
  authorizationServerMetadata,
  issuerOf,
  mcpOAuthEnabled,
  mcpResourceOf,
  OAUTH_PATHS,
  protectedResourceMetadata,
} from "./config";
import { OAuthFailure, oauthErrorBody } from "./errors";
import { exchangeAuthorizationCode, refreshGrant, revokeByToken } from "./grants";

/** Dashboard route that shows the consent screen. */
export const CONSENT_PAGE_PATH = "/authorize";

/**
 * The validated parameters as one base64url JSON value, the consent page's
 * `request` query parameter.
 *
 * NOTE: The dashboard's router JSON-parses and re-serialises every query
 * value, which would change an opaque `state` such as `"1"` or `{…}`; one
 * base64url value always starts with `ey` and survives unchanged.
 */
function encodeForwarded(params: AuthorizationParams): string {
  const bytes = new TextEncoder().encode(JSON.stringify(params));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const PROTECTED_RESOURCE_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
];
const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";

const MAX_FORM_BYTES = 16 * 1024;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
} as const;

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

function oauthError(c: Context<AppEnv>, failure: OAuthFailure) {
  return c.json(oauthErrorBody(failure), failure.status, { ...CORS, ...NO_STORE });
}

/**
 * Takes one unit of the per-IP budget for `bucket` from `AUTH_LIMITER`.
 *
 * @param c - Request context.
 * @param bucket - Limiter key prefix, e.g. `oauth-token`.
 * @throws {OAuthFailure} 429 when it is spent.
 */
export async function rateLimit(c: AppContext, bucket: string): Promise<void> {
  const limiter = c.env.AUTH_LIMITER;
  if (!limiter) return;
  const { success } = await limiter.limit({ key: `${bucket}:${clientIp(c) ?? "unknown"}` });
  if (!success) {
    c.header("retry-after", "60");
    throw new OAuthFailure("temporarily_unavailable", "Too many requests; try again later", 429);
  }
}

const disabled = () =>
  new OAuthFailure("access_denied", "MCP is disabled on this Roundhouse instance", 403);

/**
 * Reads an `application/x-www-form-urlencoded` body, refusing repeated
 * parameters (RFC 6749 section 3.2).
 */
async function readForm(c: AppContext): Promise<Map<string, string>> {
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    throw new OAuthFailure("invalid_request", "Send application/x-www-form-urlencoded");
  }
  if (Number(c.req.header("content-length") ?? 0) > MAX_FORM_BYTES) {
    throw new OAuthFailure("invalid_request", "Request body too large");
  }
  const raw = await c.req.text();
  if (raw.length > MAX_FORM_BYTES)
    throw new OAuthFailure("invalid_request", "Request body too large");
  const form = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(raw)) {
    if (form.has(k)) throw new OAuthFailure("invalid_request", `${k} repeated`);
    form.set(k, v);
  }
  return form;
}

function required(form: Map<string, string>, name: string): string {
  const value = form.get(name);
  if (!value) throw new OAuthFailure("invalid_request", `${name} is required`);
  return value;
}

function plainError(c: AppContext, failure: OAuthFailure) {
  return c.text(
    `Roundhouse could not start signing in this app.\n\n${failure.code}: ${failure.description}\n`,
    failure.status,
    NO_STORE,
  );
}

/** The well-known discovery documents and `/oauth/*` endpoints. */
export const oauthRoutes = createRouter();

for (const path of [
  ...PROTECTED_RESOURCE_PATHS,
  AUTHORIZATION_SERVER_PATH,
  OAUTH_PATHS.token,
  OAUTH_PATHS.revoke,
]) {
  oauthRoutes.options(path, (c) => c.body(null, 204, CORS));
}

for (const path of PROTECTED_RESOURCE_PATHS) {
  oauthRoutes.get(path, async (c) => {
    if (!(await mcpOAuthEnabled(c))) return c.json({ error: "not_found" }, 404, CORS);
    return c.json(protectedResourceMetadata(c), 200, {
      ...CORS,
      "cache-control": "public, max-age=300",
    });
  });
}

oauthRoutes.get(AUTHORIZATION_SERVER_PATH, async (c) => {
  if (!(await mcpOAuthEnabled(c))) return c.json({ error: "not_found" }, 404, CORS);
  return c.json(authorizationServerMetadata(c), 200, {
    ...CORS,
    "cache-control": "public, max-age=300",
  });
});

oauthRoutes.get(OAUTH_PATHS.authorize, async (c) => {
  if (!(await mcpOAuthEnabled(c))) return plainError(c, disabled());
  const url = new URL(c.req.url);
  const params = readAuthorizationParams(url.searchParams);
  if (isRejection(params)) return plainError(c, params.failure);
  let result: Awaited<ReturnType<typeof validateAuthorization>>;
  try {
    result = await validateAuthorization(params, {
      db: c.get("db"),
      issuer: issuerOf(c),
      resource: mcpResourceOf(c),
      beforeClientFetch: () => rateLimit(c, "oauth-client"),
    });
  } catch (err) {
    if (err instanceof OAuthFailure) return plainError(c, err);
    throw err;
  }
  if (isRejection(result)) {
    return result.kind === "redirect"
      ? c.redirect(result.location, 302)
      : plainError(c, result.failure);
  }
  return c.redirect(`${issuerOf(c)}${CONSENT_PAGE_PATH}?request=${encodeForwarded(params)}`, 302);
});

oauthRoutes.post(OAUTH_PATHS.token, async (c) => {
  try {
    if (!(await mcpOAuthEnabled(c))) throw disabled();
    await rateLimit(c, "oauth-token");
    const form = await readForm(c);
    const meta = { ip: clientIp(c) };
    const db = c.get("db");
    const grantType = required(form, "grant_type");
    const clientId = required(form, "client_id");
    if (form.has("client_secret")) {
      throw new OAuthFailure("invalid_client", "Public clients must not send a client_secret");
    }
    if (grantType === "authorization_code") {
      const tokens = await exchangeAuthorizationCode(
        db,
        {
          code: required(form, "code"),
          clientId,
          redirectUri: required(form, "redirect_uri"),
          codeVerifier: required(form, "code_verifier"),
          resource: form.get("resource"),
        },
        async (id) => (await resolveClient(db, id)).name,
        meta,
      );
      return c.json(tokens, 200, { ...CORS, ...NO_STORE });
    }
    if (grantType === "refresh_token") {
      const scope = form.get("scope");
      const tokens = await refreshGrant(
        db,
        {
          refreshToken: required(form, "refresh_token"),
          clientId,
          scope: scope ? scope.split(" ").filter(Boolean) : undefined,
          resource: form.get("resource"),
        },
        meta,
      );
      return c.json(tokens, 200, { ...CORS, ...NO_STORE });
    }
    throw new OAuthFailure("unsupported_grant_type", "Use authorization_code or refresh_token");
  } catch (err) {
    if (err instanceof OAuthFailure) return oauthError(c, err);
    throw err;
  }
});

oauthRoutes.post(OAUTH_PATHS.revoke, async (c) => {
  try {
    if (!(await mcpOAuthEnabled(c))) throw disabled();
    await rateLimit(c, "oauth-revoke");
    const form = await readForm(c);
    await revokeByToken(c.get("db"), required(form, "token"), form.get("client_id"), {
      ip: clientIp(c),
    });
    return c.body(null, 200, { ...CORS, ...NO_STORE });
  } catch (err) {
    if (err instanceof OAuthFailure) return oauthError(c, err);
    throw err;
  }
});

/**
 * OAuth 2.1 for MCP clients (ADR 0012 section 1), end to end against the
 * Worker: discovery, a Client ID Metadata Document client (served by a fetch
 * mock), authorize with a session, consent, code, token, a tool call through
 * the official MCP client SDK, refresh rotation, revocation and the 401 that
 * follows. Then the refusals: wrong PKCE, a reused code, redirect URI
 * mismatches, a wrong resource, a spent refresh token, an OAuth token on
 * REST, a demoted or removed user, forged consent, and MCP being disabled.
 */
import { env, SELF } from "cloudflare:test";
import {
  auth,
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMember, type Client as Browser, call, install, ORIGIN } from "./helpers";
import { createProject } from "./pipeline-helpers";

const CLIENT_ID = "https://agent.example/oauth/client.json";
const REDIRECT_URI = "http://127.0.0.1:43123/callback";
const RESOURCE = `${ORIGIN}/mcp`;
const READ_SCOPES = "workspace:read projects:read services:read variables:read nodes:read";

const realFetch = globalThis.fetch;
let clientDocument: Record<string, unknown>;
let documentFetches = 0;

beforeEach(async () => {
  clientDocument = {
    client_id: CLIENT_ID,
    client_name: "Agent Smith",
    client_uri: "https://agent.example",
    redirect_uris: ["http://127.0.0.1/callback", "https://agent.example/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  documentFetches = 0;
  // The Worker runs in this isolate, so its outbound fetch of the client
  // metadata document lands here.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CLIENT_ID) {
      documentFetches++;
      return Response.json(clientDocument);
    }
    if (url.startsWith("https://redirector.example/")) {
      return new Response(null, { status: 302, headers: { location: CLIENT_ID } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  (env as { MCP_LIMITER?: RateLimit }).MCP_LIMITER = { limit: async () => ({ success: true }) };
  await env.DB.prepare(
    "INSERT OR REPLACE INTO instance_settings (key, value, created_at, updated_at) VALUES ('mcp_enabled', 'true', ?, ?)",
  )
    .bind(Date.now(), Date.now())
    .run();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const toWorker = (url: string | URL, init?: RequestInit) => SELF.fetch(url, init);

/** An in-memory MCP client: what an agent would keep on disk. */
class TestProvider implements OAuthClientProvider {
  clientMetadataUrl = CLIENT_ID;
  saved: OAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | undefined;
  get redirectUrl() {
    return REDIRECT_URI;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Agent Smith",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() {
    return "state-123";
  }
  clientInformation() {
    return { client_id: CLIENT_ID };
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

interface Consent {
  client: { client_id: string; name: string; domain: string };
  scopes: string[];
  workspaces: { id: string; name: string; role: string; grantable_scopes: string[] }[];
  consent_token: string;
}

/**
 * Plays the browser: opens the authorization URL with a session, follows it
 * to the consent screen, and submits a decision.
 */
async function consent(
  browser: Browser,
  authorizationUrl: URL | string,
  decide: (c: Consent) => {
    workspace_id?: string;
    scopes?: string[];
    decision?: "approve" | "deny";
  },
) {
  const url = new URL(authorizationUrl);
  const start = await SELF.fetch(url, { headers: { cookie: browser.cookie }, redirect: "manual" });
  expect(start.status, await start.clone().text()).toBe(302);
  const consentPage = new URL(start.headers.get("location")!);
  expect(consentPage.origin + consentPage.pathname).toBe(`${ORIGIN}/authorize`);
  const forwarded = consentPage.searchParams.get("request")!.replace(/-/g, "+").replace(/_/g, "/");
  const request = JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(forwarded), (ch) => ch.charCodeAt(0))),
  ) as Record<string, string>;
  expect(request).toEqual(Object.fromEntries(url.searchParams));
  const shown = await browser.json<Consent>(
    `/v1/oauth/authorization?${new URLSearchParams(request)}`,
  );
  expect(shown.status).toBe(200);
  const choice = decide(shown.body);
  const decided = await browser.json<{ redirect_to: string }>("/v1/oauth/authorization", {
    method: "POST",
    json: {
      request,
      consent_token: shown.body.consent_token,
      decision: choice.decision ?? "approve",
      ...choice,
    },
  });
  return { shown: shown.body, decided };
}

async function pkcePair() {
  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

function authorizationUrl(challenge: string, overrides: Record<string, string | null> = {}) {
  const url = new URL(`${ORIGIN}/oauth/authorize`);
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: READ_SCOPES,
    ...overrides,
  };
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url;
}

/** Runs authorize + consent by hand and returns the code and its verifier. */
async function manualCode(
  browser: Browser,
  workspaceId: string,
  options: { scopes?: string[]; overrides?: Record<string, string | null> } = {},
) {
  const { verifier, challenge } = await pkcePair();
  const scopes = options.scopes ?? READ_SCOPES.split(" ");
  const { decided } = await consent(
    browser,
    authorizationUrl(challenge, { scope: scopes.join(" "), ...options.overrides }),
    () => ({ workspace_id: workspaceId, scopes }),
  );
  expect(decided.status).toBe(200);
  const back = new URL(decided.body.redirect_to);
  return { code: back.searchParams.get("code")!, verifier, back };
}

function tokenRequest(form: Record<string, string>) {
  return SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

async function exchange(code: string, verifier: string, extra: Record<string, string> = {}) {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    ...extra,
  });
}

async function tokensFor(browser: Browser, workspaceId: string, scopes?: string[]) {
  const { code, verifier } = await manualCode(browser, workspaceId, { scopes });
  const res = await exchange(code, verifier);
  expect(res.status).toBe(200);
  return (await res.json()) as OAuthTokens & { scope: string };
}

function mcpCall(accessToken: string, name: string, args: Record<string, unknown> = {}) {
  return SELF.fetch(RESOURCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

async function connect(provider: OAuthClientProvider) {
  const client = new Client({ name: "agent-smith", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(RESOURCE), {
      authProvider: provider,
      fetch: toWorker,
    }),
  );
  return client;
}

async function auditRows(action: string) {
  const { results } = await env.DB.prepare(
    "SELECT workspace_id, actor_type, actor_id, target_type, metadata FROM audit_logs WHERE action = ? ORDER BY seq",
  )
    .bind(action)
    .all<{
      workspace_id: string | null;
      actor_type: string;
      actor_id: string | null;
      target_type: string;
      metadata: string;
    }>();
  return results.map((r) => ({
    ...r,
    metadata: JSON.parse(r.metadata) as Record<string, unknown>,
  }));
}

// -----------------------------------------------------------------------------
// Discovery
// -----------------------------------------------------------------------------

describe("discovery", () => {
  it("challenges with resource metadata and serves both RFC 9728 URLs and RFC 8414", async () => {
    await install();
    const anonymous = await SELF.fetch(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(anonymous.status).toBe(401);
    const challenge = anonymous.headers.get("www-authenticate")!;
    expect(challenge).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(challenge).toContain('scope="projects:read services:read"');

    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const res = await SELF.fetch(`${ORIGIN}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [ORIGIN],
        bearer_methods_supported: ["header"],
      });
      expect(doc.scopes_supported).not.toContain("instance:manage");
      expect(doc.scopes_supported).not.toContain("workspaces:create");
    }

    const as = (await (
      await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(as).not.toHaveProperty("registration_endpoint");
  });

  it("hides discovery and refuses every OAuth endpoint while MCP is disabled", async () => {
    const { owner } = await install();
    await env.DB.prepare("DELETE FROM instance_settings WHERE key = 'mcp_enabled'").run();
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
    ]) {
      expect((await SELF.fetch(`${ORIGIN}${path}`)).status, path).toBe(404);
    }
    const { challenge } = await pkcePair();
    const start = await SELF.fetch(authorizationUrl(challenge), {
      headers: { cookie: owner.cookie },
      redirect: "manual",
    });
    expect(start.status).toBe(403);
    const token = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: "ort_x",
      client_id: CLIENT_ID,
    });
    expect(token.status).toBe(403);
    const shown = await owner.json(`/v1/oauth/authorization${authorizationUrl(challenge).search}`);
    expect(shown.status).toBe(403);
    expect(documentFetches).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// The full flow
// -----------------------------------------------------------------------------

describe("authorization code flow with the MCP SDK client", () => {
  it("discovers, authorizes, calls a tool, refreshes, revokes, and then gets 401", async () => {
    const { owner, workspaceId } = await install();
    await createProject(owner, workspaceId, { name: "Storefront" });
    const provider = new TestProvider();

    expect(
      await auth(provider, { serverUrl: RESOURCE, fetchFn: toWorker, scope: READ_SCOPES }),
    ).toBe("REDIRECT");
    const requested = provider.authorizationUrl!;
    expect(requested.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(requested.searchParams.get("code_challenge_method")).toBe("S256");
    expect(requested.searchParams.get("resource")).toBe(RESOURCE);

    const { shown, decided } = await consent(owner, requested, (c) => ({
      workspace_id: c.workspaces[0]!.id,
      scopes: c.workspaces[0]!.grantable_scopes,
    }));
    expect(shown.client).toMatchObject({
      client_id: CLIENT_ID,
      name: "Agent Smith",
      domain: "agent.example",
    });
    expect(shown.scopes).toEqual(READ_SCOPES.split(" "));
    expect(shown.workspaces).toEqual([
      expect.objectContaining({
        id: workspaceId,
        role: "owner",
        grantable_scopes: READ_SCOPES.split(" "),
      }),
    ]);
    expect(decided.status).toBe(200);
    const back = new URL(decided.body.redirect_to);
    expect(back.origin + back.pathname).toBe(REDIRECT_URI);
    expect(back.searchParams.get("state")).toBe("state-123");
    expect(back.searchParams.get("iss")).toBe(ORIGIN);

    expect(
      await auth(provider, {
        serverUrl: RESOURCE,
        fetchFn: toWorker,
        authorizationCode: back.searchParams.get("code")!,
        iss: back.searchParams.get("iss")!,
      }),
    ).toBe("AUTHORIZED");
    const first = provider.saved!;
    expect(first.access_token).toMatch(/^oat_/);
    expect(first.refresh_token).toMatch(/^ort_/);
    expect(first.expires_in).toBe(3600);

    const client = await connect(provider);
    const listed = await client.callTool({ name: "list_projects", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(JSON.stringify(listed.structuredContent)).toContain("Storefront");
    await client.close();

    expect(await auth(provider, { serverUrl: RESOURCE, fetchFn: toWorker })).toBe("AUTHORIZED");
    const second = provider.saved!;
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await mcpCall(second.access_token, "list_projects")).status).toBe(200);

    const listedClients = await owner.json<{
      clients: { id: string; name: string; scopes: string[] }[];
    }>("/v1/oauth/grants");
    expect(listedClients.body.clients).toEqual([
      expect.objectContaining({
        name: "Agent Smith",
        domain: "agent.example",
        scopes: READ_SCOPES.split(" "),
      }),
    ]);

    const revoked = await SELF.fetch(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: second.refresh_token!, client_id: CLIENT_ID }).toString(),
    });
    expect(revoked.status).toBe(200);
    const after = await mcpCall(second.access_token, "list_projects");
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await owner.json<{ clients: unknown[] }>("/v1/oauth/grants")).body.clients).toEqual([]);

    const authorized = await auditRows("mcp_client.authorized");
    expect(authorized).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        actor_type: "user",
        target_type: "mcp_client",
      }),
    ]);
    expect(authorized[0]!.metadata).toMatchObject({ name: "Agent Smith", client_id: CLIENT_ID });
    const revokedAudit = await auditRows("mcp_client.revoked");
    expect(revokedAudit).toHaveLength(1);
    expect(revokedAudit[0]!.metadata).toMatchObject({ reason: "client" });
    const { results } = await env.DB.prepare("SELECT metadata FROM audit_logs").all<{
      metadata: string | null;
    }>();
    const everything = JSON.stringify(results);
    for (const secret of [
      first.access_token,
      first.refresh_token!,
      second.access_token,
      back.searchParams.get("code")!,
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toMatch(/oat_|ort_|oac_/);
  });

  it("refuses an OAuth access token on the REST API, and keeps it out of the API token list", async () => {
    const { owner, workspaceId } = await install();
    const tokens = await tokensFor(owner, workspaceId);
    const rest = await call(`/v1/workspaces/${workspaceId}/projects`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(rest.status).toBe(401);
    expect((await mcpCall(tokens.access_token, "list_projects")).status).toBe(200);
    const listed = await owner.json<{ tokens: unknown[] }>(`/v1/workspaces/${workspaceId}/tokens`);
    expect(listed.body.tokens).toEqual([]);
  });

  it("lets the user disconnect a client from the dashboard", async () => {
    const { owner, workspaceId } = await install();
    const tokens = await tokensFor(owner, workspaceId);
    const { body } = await owner.json<{ clients: { id: string }[] }>("/v1/oauth/grants");
    const grantId = body.clients[0]!.id;

    const stranger = await addMember(owner, workspaceId, "someone@example.com", "admin");
    expect(
      (await stranger.request(`/v1/oauth/grants/${grantId}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect(
      (
        await call(`/v1/oauth/grants/${grantId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
      ).status,
    ).toBe(401);

    expect((await owner.request(`/v1/oauth/grants/${grantId}`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await mcpCall(tokens.access_token, "list_projects")).status).toBe(401);
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token!,
      client_id: CLIENT_ID,
    });
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
    const audit = await auditRows("mcp_client.revoked");
    expect(audit).toEqual([
      expect.objectContaining({ actor_type: "user", workspace_id: workspaceId }),
    ]);
    expect(audit[0]!.metadata).toMatchObject({ reason: "user", name: "Agent Smith" });
  });
});

// -----------------------------------------------------------------------------
// Refusals
// -----------------------------------------------------------------------------

describe("token endpoint refusals", () => {
  it("rejects a wrong PKCE verifier and burns the code", async () => {
    const { owner, workspaceId } = await install();
    const { code, verifier } = await manualCode(owner, workspaceId);
    const wrong = await exchange(code, (await pkcePair()).verifier);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    expect(wrong.headers.get("cache-control")).toBe("no-store");
    expect((await exchange(code, verifier)).status).toBe(400);
  });

  it("rejects a reused code and revokes what the first exchange obtained", async () => {
    const { owner, workspaceId } = await install();
    const { code, verifier } = await manualCode(owner, workspaceId);
    const first = await exchange(code, verifier);
    expect(first.status).toBe(200);
    const tokens = (await first.json()) as OAuthTokens;
    const again = await exchange(code, verifier);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "invalid_grant" });
    expect((await mcpCall(tokens.access_token, "list_projects")).status).toBe(401);
    expect((await auditRows("mcp_client.revoked"))[0]).toMatchObject({
      actor_type: "system",
      metadata: expect.objectContaining({ reason: "code_reuse" }),
    });
  });

  it("rejects an expired code", async () => {
    const { owner, workspaceId } = await install();
    const { code, verifier } = await manualCode(owner, workspaceId);
    await env.DB.prepare("UPDATE oauth_codes SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    const res = await exchange(code, verifier);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects a redirect_uri, client or resource that differs from the code's", async () => {
    const { owner, workspaceId } = await install();
    for (const [extra, error] of [
      [{ redirect_uri: "http://127.0.0.1:43124/callback" }, "invalid_grant"],
      [{ client_id: "https://other.example/client.json" }, "invalid_grant"],
      [{ resource: "https://cp.test/other" }, "invalid_target"],
    ] as const) {
      const { code, verifier } = await manualCode(owner, workspaceId);
      const res = await exchange(code, verifier, extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(await res.json()).toMatchObject({ error });
    }
  });

  it("rotates refresh tokens and revokes the grant when a spent one comes back", async () => {
    const { owner, workspaceId } = await install();
    const tokens = await tokensFor(owner, workspaceId);
    const refresh = (token: string, extra: Record<string, string> = {}) =>
      tokenRequest({
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: CLIENT_ID,
        ...extra,
      });

    const wider = await refresh(tokens.refresh_token!, { scope: "variables:manage" });
    expect(wider.status).toBe(400);
    expect(await wider.json()).toMatchObject({ error: "invalid_scope" });
    expect((await refresh("ort_unknown")).status).toBe(400);

    const narrowed = await refresh(tokens.refresh_token!, { scope: "projects:read" });
    expect(narrowed.status).toBe(200);
    const newer = (await narrowed.json()) as OAuthTokens & { scope: string };
    expect(newer.scope).toBe("projects:read");
    expect(newer.refresh_token).not.toBe(tokens.refresh_token);
    expect((await mcpCall(newer.access_token, "list_projects")).status).toBe(200);

    const replay = await refresh(tokens.refresh_token!);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    expect((await mcpCall(newer.access_token, "list_projects")).status).toBe(401);
    expect((await mcpCall(tokens.access_token, "list_projects")).status).toBe(401);
    expect((await refresh(newer.refresh_token!)).status).toBe(400);
    const reuse = (await auditRows("mcp_client.revoked")).filter(
      (r) => r.metadata.reason === "refresh_reuse",
    );
    expect(reuse).toHaveLength(1);
  });

  it("only accepts form bodies and public clients", async () => {
    await install();
    const json = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    });
    expect(json.status).toBe(400);
    const secret = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: "ort_x",
      client_id: CLIENT_ID,
      client_secret: "hunter2",
    });
    expect(secret.status).toBe(401);
    expect(await secret.json()).toMatchObject({ error: "invalid_client" });
    const implicit = await tokenRequest({ grant_type: "password", client_id: CLIENT_ID });
    expect(await implicit.json()).toMatchObject({ error: "unsupported_grant_type" });
  });
});

describe("authorization endpoint refusals", () => {
  it("never redirects to an unregistered redirect URI or for an unusable client", async () => {
    const { owner } = await install();
    const { challenge } = await pkcePair();
    for (const overrides of [
      { redirect_uri: "https://evil.example/callback" },
      { redirect_uri: "http://192.168.1.5/callback" },
      { redirect_uri: "http://127.0.0.1/other" },
      { client_id: "http://agent.example/oauth/client.json" },
      { client_id: "https://127.0.0.1/client.json" },
      { client_id: "https://redirector.example/client.json" },
      { client_id: "my-client" },
    ] as Record<string, string>[]) {
      const res = await SELF.fetch(authorizationUrl(challenge, overrides), {
        headers: { cookie: owner.cookie },
        redirect: "manual",
      });
      expect(res.status, JSON.stringify(overrides)).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("location"), JSON.stringify(overrides)).toBeNull();
    }
  });

  it("rejects a document whose client_id or redirect URIs don't qualify", async () => {
    const { owner } = await install();
    const { challenge } = await pkcePair();
    for (const doc of [
      { client_id: "https://agent.example/other.json" },
      { redirect_uris: ["http://agent.example/callback"] },
      { client_secret: "s3cret" },
    ]) {
      clientDocument = { ...clientDocument, ...doc };
      await env.DB.prepare("DELETE FROM oauth_clients").run();
      const res = await SELF.fetch(authorizationUrl(challenge), {
        headers: { cookie: owner.cookie },
        redirect: "manual",
      });
      expect(res.status, JSON.stringify(doc)).toBe(401);
      expect(await res.text()).toContain("invalid_client");
    }
  });

  it("redirects back with an error for PKCE, state, scope and resource problems", async () => {
    const { owner } = await install();
    const { challenge } = await pkcePair();
    for (const [overrides, error] of [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: null }, "invalid_request"],
      [{ state: null }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ scope: "instance:manage" }, "invalid_scope"],
      [{ resource: "https://cp.test/v1" }, "invalid_target"],
      [{ resource: null }, "invalid_target"],
    ] as const) {
      const res = await SELF.fetch(authorizationUrl(challenge, overrides), {
        headers: { cookie: owner.cookie },
        redirect: "manual",
      });
      expect(res.status, JSON.stringify(overrides)).toBe(302);
      const back = new URL(res.headers.get("location")!);
      expect(back.origin + back.pathname).toBe(REDIRECT_URI);
      expect(back.searchParams.get("error")).toBe(error);
      expect(back.searchParams.get("iss")).toBe(ORIGIN);
    }
  });

  it("accepts any port on a loopback redirect URI and caches the client document", async () => {
    const { owner, workspaceId } = await install();
    await manualCode(owner, workspaceId, {
      overrides: { redirect_uri: "http://127.0.0.1:50001/callback" },
    });
    await manualCode(owner, workspaceId, {
      overrides: { redirect_uri: "https://agent.example/callback" },
    });
    expect(documentFetches).toBe(1);
  });
});

describe("consent", () => {
  it("binds the decision to the screen's session and request, and to same-origin posts", async () => {
    const { owner, workspaceId } = await install();
    const { challenge } = await pkcePair();
    const url = authorizationUrl(challenge);
    const shown = await owner.json<Consent>(`/v1/oauth/authorization${url.search}`);
    const request = Object.fromEntries(url.searchParams);
    const decide = (body: Record<string, unknown>, origin = ORIGIN, browser = owner) =>
      call(
        "/v1/oauth/authorization",
        {
          method: "POST",
          headers: { origin },
          json: {
            request,
            consent_token: shown.body.consent_token,
            decision: "approve",
            workspace_id: workspaceId,
            scopes: ["projects:read"],
            ...body,
          },
        },
        browser.cookie,
      );

    expect((await decide({}, "https://evil.example")).status).toBe(403);
    expect(
      (await decide({ request: { ...request, redirect_uri: "https://agent.example/callback" } }))
        .status,
    ).toBe(400);
    expect((await decide({ consent_token: `${shown.body.consent_token}x` })).status).toBe(400);
    expect((await decide({ scopes: ["variables:manage"] })).status).toBe(400);
    const other = await addMember(owner, workspaceId, "other@example.com", "admin");
    expect((await decide({}, ORIGIN, other)).status).toBe(400);

    const denied = await decide({ decision: "deny" });
    expect(denied.status).toBe(200);
    const back = new URL(((await denied.json()) as { redirect_to: string }).redirect_to);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(await auditRows("mcp_client.authorized")).toEqual([]);

    expect((await call(`/v1/oauth/authorization${url.search}`)).status).toBe(401);
  });

  it("offers only the requested scopes the role allows, and refuses more", async () => {
    const { owner, workspaceId } = await install();
    const viewer = await addMember(owner, workspaceId, "viewer@example.com", "viewer");
    const { challenge } = await pkcePair();
    const scopes = ["projects:read", "variables:manage"];
    const { shown, decided } = await consent(
      viewer,
      authorizationUrl(challenge, { scope: scopes.join(" ") }),
      () => ({ workspace_id: workspaceId, scopes }),
    );
    expect(shown.workspaces[0]).toMatchObject({
      role: "viewer",
      grantable_scopes: ["projects:read"],
    });
    expect(decided.status).toBe(403);
  });
});

describe("two-factor requirement", () => {
  it("refuses tools that change something for an OAuth client whose user hasn't enrolled", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId, { name: "Storefront" });
    const admin = await addMember(owner, workspaceId, "admin@example.com", "admin");
    const tokens = await tokensFor(admin, workspaceId, [
      "workspace:read",
      "projects:read",
      "variables:read",
      "variables:manage",
    ]);
    // Enrollment lapses after consent, as when an admin resets someone's 2FA.
    await env.DB.prepare("UPDATE users SET two_factor_enabled = 0 WHERE email = ?")
      .bind("admin@example.com")
      .run();
    const agent = new Client({ name: "agent-smith", version: "1.0.0" });
    await agent.connect(
      new StreamableHTTPClientTransport(new URL(RESOURCE), {
        fetch: toWorker,
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    const refused = await agent.callTool({
      name: "set_variables",
      arguments: {
        project_id: project.id,
        environment_id: project.environments[0]!.id,
        set: [{ key: "LOG_LEVEL", value: "debug" }],
      },
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      error: { status: 403, code: "two_factor_required" },
    });
    const written = await env.DB.prepare("SELECT count(*) AS n FROM variables WHERE key = ?")
      .bind("LOG_LEVEL")
      .first<{ n: number }>();
    expect(written?.n).toBe(0);

    const read = await agent.callTool({ name: "list_projects", arguments: {} });
    expect(read.isError).not.toBe(true);
    await agent.close();
  });
});

describe("access follows the user's current role", () => {
  it("narrows a demoted user's client and cuts off a removed one", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId, { name: "Storefront" });
    const admin = await addMember(owner, workspaceId, "admin@example.com", "admin");
    const tokens = await tokensFor(admin, workspaceId, [
      "workspace:read",
      "projects:read",
      "variables:read",
      "variables:manage",
    ]);
    const agent = new Client({ name: "agent-smith", version: "1.0.0" });
    await agent.connect(
      new StreamableHTTPClientTransport(new URL(RESOURCE), {
        fetch: toWorker,
        requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    const setVar = () =>
      agent.callTool({
        name: "set_variables",
        arguments: {
          project_id: project.id,
          environment_id: project.environments[0]!.id,
          set: [{ key: "LOG_LEVEL", value: "debug" }],
        },
      });
    const allowed = await setVar();
    expect(allowed.isError, JSON.stringify(allowed.content)).not.toBe(true);

    const { body } = await owner.json<{ members: { id: string; email: string }[] }>(
      `/v1/workspaces/${workspaceId}/members`,
    );
    const memberId = body.members.find((m) => m.email === "admin@example.com")!.id;
    const demoted = await owner.json(`/v1/workspaces/${workspaceId}/members/${memberId}`, {
      method: "PATCH",
      json: { role: "viewer" },
    });
    expect(demoted.status).toBe(200);
    const refused = await setVar();
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.structuredContent)).toContain("viewer");
    expect((await mcpCall(tokens.access_token, "list_projects")).status).toBe(200);
    await agent.close();

    expect(
      (
        await owner.request(`/v1/workspaces/${workspaceId}/members/${memberId}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect((await mcpCall(tokens.access_token, "list_projects")).status).toBe(401);
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token!,
      client_id: CLIENT_ID,
    });
    expect(refreshed.status).toBe(400);
  });
});

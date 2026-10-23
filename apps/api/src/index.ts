/**
 * Control-plane Worker entry point.
 *
 * Responsibilities:
 * - REST API under `/v1` (OpenAPI document at `/v1/openapi.json`)
 * - Better Auth under `/api/auth/*`
 * - The MCP server for coding agents at `/mcp` (`mcp/route.ts`) and its OAuth
 *   authorization server: discovery under `/.well-known/`, `/oauth/*`, and
 *   the consent routes under `/v1/oauth/*` (`mcp/oauth/`)
 * - Agent join/connect endpoints and the install script
 * - The project realtime socket (`ProjectRoom`), the audit chain sealer
 *   (`AuditChain`), and the deploy and key rotation workflows
 *   (`DeployWorkflow`, `KeyRotationWorkflow`), and one-click server
 *   provisioning (`ProvisionWorkflow`), exported for their bindings
 * - `Cache-Control: no-store` on every API and auth response, and the
 *   two-factor gate in front of `/v1/*` mutations (ADR 0014)
 * - Custom-domain checks every minute (Cron Trigger), see `lib/domains/check.ts`
 * - The hourly retention job (Cron Trigger), see `lib/retention.ts`, and the
 *   cloud provider reconcile, see `lib/provisioning.ts`
 * - Static SPA assets (served by the platform for everything else)
 *
 * @module
 */
import { createDb } from "@roundhouse/db";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { authFor, createRouter, withDb } from "./context";
import type { Env } from "./env";
import { noStore } from "./lib/cache-control";
import { DOMAIN_CHECK_CRON, runDomainChecks } from "./lib/domains/check";
import { ApiError, errorBody, errorCodeForStatus } from "./lib/errors";
import { rateLimitSecrets, sameOriginMutations } from "./lib/guards";
import { reconcileProviders } from "./lib/provisioning";
import { runRetention } from "./lib/retention";
import { twoFactorGate } from "./lib/two-factor-gate";
import { oauthConsentRoutes } from "./mcp/oauth/consent";
import { oauthRoutes } from "./mcp/oauth/routes";
import { mcpRoutes } from "./mcp/route";
import { accessRoutes } from "./routes/access";
import { agentRoutes } from "./routes/agent";
import { auditRoutes } from "./routes/audit";
import { authSecurityRoutes } from "./routes/auth-security";
import { changeRoutes } from "./routes/changes";
import { deploymentRoutes } from "./routes/deployments";
import { domainRoutes } from "./routes/domains";
import { githubRoutes } from "./routes/github";
import { instanceRoutes } from "./routes/instance";
import { instanceAdminRoutes } from "./routes/instance-admin";
import { inviteRoutes } from "./routes/invites";
import { keyRoutes } from "./routes/keys";
import { nodeRoutes } from "./routes/nodes";
import { projectRoutes } from "./routes/projects";
import { providerRoutes } from "./routes/providers";
import { REALTIME_PATH, realtimeRoutes } from "./routes/realtime";
import { serviceRoutes } from "./routes/services";
import { setupRoutes } from "./routes/setup";
import { templateRoutes } from "./routes/templates";
import { tokenRoutes } from "./routes/tokens";
import { variableRoutes } from "./routes/variables";
import { workspaceRoutes } from "./routes/workspaces";
import { SESSION_SCHEME, TOKEN_SCHEME } from "./schemas";

export { AuditChain } from "./durable/audit-chain";
export { NodeConnection } from "./durable/node-connection";
export { ProjectRoom } from "./durable/project-room";
export { DeployWorkflow } from "./workflows/deploy";
export { KeyRotationWorkflow } from "./workflows/key-rotation";
export { ProvisionWorkflow } from "./workflows/provision";

/** Version of the REST API advertised in the OpenAPI document. */
const API_VERSION = "0.1.0";

const AGENT_CONNECT_PATH = /^\/v1\/nodes\/[^/]+\/connect$/;

const app = createRouter();

const headers = secureHeaders();
// NOTE: WebSocket upgrade responses (agent and realtime) come back from a
// Durable Object with immutable headers, and security headers mean nothing
// on them. Every other response, including any other request claiming an
// upgrade, gets them.
app.use("*", (c, next) =>
  c.req.header("upgrade")?.toLowerCase() === "websocket" &&
  (AGENT_CONNECT_PATH.test(c.req.path) || REALTIME_PATH.test(c.req.path))
    ? next()
    : headers(c, next),
);
app.use("/v1/*", noStore);
app.use("/api/auth/*", noStore);
app.use("/mcp", noStore);
app.use("*", withDb);
app.use("*", rateLimitSecrets);
app.use("/v1/*", sameOriginMutations);
app.use("/v1/*", twoFactorGate);

app.on(["GET", "POST"], "/api/auth/*", async (c) => (await authFor(c)).handler(c.req.raw));

app
  .route("/", setupRoutes)
  .route("/", workspaceRoutes)
  .route("/", inviteRoutes)
  .route("/", nodeRoutes)
  .route("/", auditRoutes)
  .route("/", agentRoutes)
  .route("/", projectRoutes)
  .route("/", serviceRoutes)
  .route("/", changeRoutes)
  .route("/", domainRoutes)
  .route("/", variableRoutes)
  .route("/", deploymentRoutes)
  .route("/", instanceRoutes)
  .route("/", githubRoutes)
  .route("/", tokenRoutes)
  .route("/", realtimeRoutes)
  .route("/", accessRoutes)
  .route("/", authSecurityRoutes)
  .route("/", instanceAdminRoutes)
  .route("/", keyRoutes)
  .route("/", providerRoutes)
  .route("/", templateRoutes)
  .route("/", mcpRoutes)
  .route("/", oauthRoutes)
  .route("/", oauthConsentRoutes);

app.openAPIRegistry.registerComponent("securitySchemes", SESSION_SCHEME, {
  type: "apiKey",
  in: "cookie",
  name: "__Secure-better-auth.session_token",
  description:
    "Better Auth session cookie, set by sign-in, setup, and invite acceptance. " +
    "Named `better-auth.session_token` (no `__Secure-` prefix) over plain HTTP in local dev.",
});

app.openAPIRegistry.registerComponent("securitySchemes", TOKEN_SCHEME, {
  type: "http",
  scheme: "bearer",
  description:
    "Workspace API token (`tok_…`) created under Settings → API tokens. Limited to its " +
    "workspace and scopes; cookies are ignored when it is sent.",
});

app.doc31("/v1/openapi.json", {
  openapi: "3.1.0",
  info: { title: "Roundhouse API", version: API_VERSION },
});

app.notFound((c) => c.json(errorBody("not_found", "No such endpoint"), 404));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(errorBody(err.code, err.message, err.details), err.status);
  }
  if (err instanceof HTTPException) {
    if (err.status >= 500) console.error("http exception", err);
    return c.json(errorBody(errorCodeForStatus(err.status), err.message), err.status);
  }
  console.error("unhandled error", err);
  return c.json(errorBody("internal", "Internal error"), 500);
});

/** The Hono app, exported for tests. */
export { app };

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    if (controller.cron === DOMAIN_CHECK_CRON) {
      try {
        const checks = await runDomainChecks(env, controller.scheduledTime);
        if (checks.checked) console.log("domain checks", JSON.stringify(checks));
      } catch (err) {
        console.error("domain checks failed", err instanceof Error ? err.name : "error");
      }
      return;
    }
    const report = await runRetention(env, controller.scheduledTime);
    console.log("retention", JSON.stringify(report));
    // NOTE: Separate from retention so a provider outage never blocks cleanup.
    try {
      const reconciled = await reconcileProviders(createDb(env.DB), env);
      console.log("provider reconcile", JSON.stringify(reconciled));
    } catch (err) {
      console.error("provider reconcile failed", err instanceof Error ? err.name : "error");
    }
  },
} satisfies ExportedHandler<Env>;

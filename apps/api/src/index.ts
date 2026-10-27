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
 *   provisioning (`ProvisionWorkflow`), and backups and restores
 *   (`BackupWorkflow`, `RestoreWorkflow`, ADR 0004), and certificate orders
 *   (`CertificateWorkflow`, ADR 0009), exported for their bindings
 * - The public ACME HTTP-01 responder (`routes/acme.ts`) and the Domains &
 *   TLS settings (`routes/tls.ts`)
 * - `Cache-Control: no-store` on every API and auth response, and the
 *   two-factor gate in front of `/v1/*` mutations (ADR 0014)
 * - Service, project and node metrics (`routes/metrics.ts`, ADR 0008)
 * - The minute tick (Cron Trigger): audit-chain sealing (`durable/audit-chain.ts`),
 *   custom-domain checks, certificate orders, volume deletions and the other scheduled claimers,
 *   see `lib/dispatch.ts`
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
import { AUDIT_CHAIN_NAME } from "./lib/audit-chain";
import { noStore } from "./lib/cache-control";
import { MINUTE_CRON, runMinuteTick } from "./lib/dispatch";
import { ApiError, errorBody, errorCodeForStatus } from "./lib/errors";
import { rateLimitSecrets, sameOriginMutations } from "./lib/guards";
import { reconcileProviders } from "./lib/provisioning";
import { runRetention } from "./lib/retention";
import { twoFactorGate } from "./lib/two-factor-gate";
import { oauthConsentRoutes } from "./mcp/oauth/consent";
import { oauthRoutes } from "./mcp/oauth/routes";
import { mcpRoutes } from "./mcp/route";
import { accessRoutes } from "./routes/access";
import { acmeRoutes } from "./routes/acme";
import { agentRoutes } from "./routes/agent";
import { auditRoutes } from "./routes/audit";
import { authSecurityRoutes } from "./routes/auth-security";
import { backupRoutes } from "./routes/backups";
import { changeRoutes } from "./routes/changes";
import { dataBrowserRoutes } from "./routes/data-browser";
import { databaseRoutes } from "./routes/databases";
import { deploymentRoutes } from "./routes/deployments";
import { domainRoutes } from "./routes/domains";
import { githubRoutes } from "./routes/github";
import { instanceRoutes } from "./routes/instance";
import { instanceAdminRoutes } from "./routes/instance-admin";
import { inviteRoutes } from "./routes/invites";
import { keyRoutes } from "./routes/keys";
import { metricsRoutes } from "./routes/metrics";
import { nodeRoutes } from "./routes/nodes";
import { projectRoutes } from "./routes/projects";
import { providerRoutes } from "./routes/providers";
import { REALTIME_PATH, realtimeRoutes } from "./routes/realtime";
import { serviceRoutes } from "./routes/services";
import { setupRoutes } from "./routes/setup";
import { signingKeyRoutes } from "./routes/signing-keys";
import { templateRoutes } from "./routes/templates";
import { tlsRoutes } from "./routes/tls";
import { tokenRoutes } from "./routes/tokens";
import { variableRoutes } from "./routes/variables";
import { workspaceRoutes } from "./routes/workspaces";
import { SESSION_SCHEME, TOKEN_SCHEME } from "./schemas";

export { AuditChain } from "./durable/audit-chain";
export { NodeConnection } from "./durable/node-connection";
export { ProjectRoom } from "./durable/project-room";
export { BackupWorkflow } from "./workflows/backup";
export { CertificateWorkflow } from "./workflows/certificate";
export { DeployWorkflow } from "./workflows/deploy";
export { KeyRotationWorkflow } from "./workflows/key-rotation";
export { ProvisionWorkflow } from "./workflows/provision";
export { RestoreWorkflow } from "./workflows/restore";

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
  .route("/", metricsRoutes)
  .route("/", dataBrowserRoutes)
  .route("/", changeRoutes)
  .route("/", databaseRoutes)
  .route("/", domainRoutes)
  .route("/", acmeRoutes)
  .route("/", variableRoutes)
  .route("/", deploymentRoutes)
  .route("/", instanceRoutes)
  .route("/", tlsRoutes)
  .route("/", githubRoutes)
  .route("/", tokenRoutes)
  .route("/", realtimeRoutes)
  .route("/", accessRoutes)
  .route("/", authSecurityRoutes)
  .route("/", instanceAdminRoutes)
  .route("/", keyRoutes)
  .route("/", signingKeyRoutes)
  .route("/", providerRoutes)
  .route("/", templateRoutes)
  .route("/", backupRoutes)
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
    if (controller.cron === MINUTE_CRON) {
      try {
        await env.AUDIT_CHAIN.get(env.AUDIT_CHAIN.idFromName(AUDIT_CHAIN_NAME)).seal();
      } catch (err) {
        console.error("audit chain seal failed", err instanceof Error ? err.name : "error");
      }
      const ticked = await runMinuteTick(env, controller.scheduledTime);
      if (Object.values(ticked).some((n) => n !== 0)) {
        console.log("minute tick", JSON.stringify(ticked));
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

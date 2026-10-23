/**
 * Control-plane Worker entry point.
 *
 * Responsibilities:
 * - REST API under `/v1` (OpenAPI document at `/v1/openapi.json`)
 * - Better Auth under `/api/auth/*`
 * - Agent join/connect endpoints and the install script
 * - The project realtime socket (`ProjectRoom`), the audit chain sealer
 *   (`AuditChain`), and the deploy and key rotation workflows
 *   (`DeployWorkflow`, `KeyRotationWorkflow`), exported for their bindings
 * - `Cache-Control: no-store` on every API and auth response, and the
 *   two-factor gate in front of `/v1/*` mutations (ADR 0014)
 * - Static SPA assets (served by the platform for everything else)
 *
 * @module
 */
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { authFor, createRouter, withDb } from "./context";
import type { Env } from "./env";
import { noStore } from "./lib/cache-control";
import { ApiError, errorBody, errorCodeForStatus } from "./lib/errors";
import { rateLimitSecrets, sameOriginMutations } from "./lib/guards";
import { twoFactorGate } from "./lib/two-factor-gate";
import { accessRoutes } from "./routes/access";
import { agentRoutes } from "./routes/agent";
import { auditRoutes } from "./routes/audit";
import { authSecurityRoutes } from "./routes/auth-security";
import { deploymentRoutes } from "./routes/deployments";
import { githubRoutes } from "./routes/github";
import { instanceRoutes } from "./routes/instance";
import { instanceAdminRoutes } from "./routes/instance-admin";
import { inviteRoutes } from "./routes/invites";
import { keyRoutes } from "./routes/keys";
import { nodeRoutes } from "./routes/nodes";
import { projectRoutes } from "./routes/projects";
import { REALTIME_PATH, realtimeRoutes } from "./routes/realtime";
import { serviceRoutes } from "./routes/services";
import { setupRoutes } from "./routes/setup";
import { variableRoutes } from "./routes/variables";
import { workspaceRoutes } from "./routes/workspaces";
import { SESSION_SCHEME } from "./schemas";

export { AuditChain } from "./durable/audit-chain";
export { NodeConnection } from "./durable/node-connection";
export { ProjectRoom } from "./durable/project-room";
export { DeployWorkflow } from "./workflows/deploy";
export { KeyRotationWorkflow } from "./workflows/key-rotation";

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
  .route("/", variableRoutes)
  .route("/", deploymentRoutes)
  .route("/", instanceRoutes)
  .route("/", githubRoutes)
  .route("/", realtimeRoutes)
  .route("/", accessRoutes)
  .route("/", authSecurityRoutes)
  .route("/", instanceAdminRoutes)
  .route("/", keyRoutes);

app.openAPIRegistry.registerComponent("securitySchemes", SESSION_SCHEME, {
  type: "apiKey",
  in: "cookie",
  name: "__Secure-better-auth.session_token",
  description:
    "Better Auth session cookie, set by sign-in, setup, and invite acceptance. " +
    "Named `better-auth.session_token` (no `__Secure-` prefix) over plain HTTP in local dev.",
});

app.doc31("/v1/openapi.json", {
  openapi: "3.1.0",
  info: { title: "OpenRail API", version: API_VERSION },
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
} satisfies ExportedHandler<Env>;

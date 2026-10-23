/**
 * `GET /v1/projects/{projectId}/realtime`: authenticates a browser, CLI or API
 * token and hands its WebSocket to the project's `ProjectRoom`.
 *
 * A browser can't read the status of a refused upgrade, so authentication
 * and authorization failures accept the socket and close it at once with a
 * `REALTIME_CLOSE_CODES` code (4401, 4403, 4404) the client can act on.
 *
 * SECURITY: Browsers don't apply CORS to WebSocket upgrades, so a page on
 * any origin could open this socket with the user's cookie. A cookie-
 * authenticated upgrade is only accepted with an `Origin` equal to the
 * control plane's own; a bearer token can't be attached by such a page, so a
 * token upgrade needs no Origin.
 *
 * @module
 */
import { REALTIME_CLOSE_CODES, type RealtimeCloseCode } from "@roundhouse/shared";
import { createRouter, originOf } from "../context";
import { policyOf, projectRealtime } from "../contracts";
import { ROOM_VIEWER_HEADER, type RoomViewer } from "../durable/project-room";
import { bearerSecret } from "../lib/api-tokens";
import { ApiError } from "../lib/errors";
import { projectRoom } from "../lib/realtime";
import { projectScope } from "../lib/scope";

/** Path of the realtime upgrade, for middleware that must leave it untouched. */
export const REALTIME_PATH = /^\/v1\/projects\/[^/]+\/realtime$/;

const CLOSE_FOR_STATUS: Partial<Record<number, RealtimeCloseCode>> = {
  401: REALTIME_CLOSE_CODES.unauthorized,
  403: REALTIME_CLOSE_CODES.forbidden,
  404: REALTIME_CLOSE_CODES.notFound,
};

/**
 * Completes the upgrade only to close the socket with `code`, so the client
 * learns why instead of seeing a failed handshake.
 */
function closedSocket(code: RealtimeCloseCode, reason: string): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  // Close reasons are capped at 123 bytes.
  server.close(code, reason.slice(0, 120));
  return new Response(null, { status: 101, webSocket: client });
}

/** Realtime route. */
export const realtimeRoutes = createRouter().openapi(projectRealtime, async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new ApiError(426, "upgrade_required", "Expected a WebSocket upgrade");
  }
  const bearer = bearerSecret(c.req.header("authorization")) !== null;
  if (!bearer && c.req.header("origin") !== originOf(c)) {
    throw new ApiError(403, "forbidden", "Cross-origin WebSocket rejected");
  }
  const { projectId } = c.req.valid("param");
  const { client } = c.req.valid("query");
  let scope: Awaited<ReturnType<typeof projectScope>>;
  try {
    scope = await projectScope(c, projectId, policyOf(projectRealtime).action!);
  } catch (err) {
    const code = err instanceof ApiError ? CLOSE_FOR_STATUS[err.status] : undefined;
    if (code) return closedSocket(code, (err as ApiError).message);
    throw err;
  }
  const { project, caller } = scope;
  const { principal } = caller;
  const viewer: RoomViewer = {
    user_id: caller.user.id,
    name: caller.user.name,
    image: caller.user.image,
    workspace_id: project.workspaceId,
    project_id: project.id,
    session_id: principal.session?.id ?? null,
    token_id: principal.token?.id ?? null,
    presence: !principal.token && client !== "cli",
  };
  const headers = new Headers({ upgrade: "websocket" });
  headers.set(ROOM_VIEWER_HEADER, JSON.stringify(viewer));
  // Only the upgrade and the trusted viewer travel on; credentials stay here.
  return projectRoom(c.env, projectId).fetch(new Request(c.req.url, { headers }));
});

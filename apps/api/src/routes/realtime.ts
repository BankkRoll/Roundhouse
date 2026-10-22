/**
 * `GET /v1/projects/{projectId}/realtime`: authenticates a browser and hands
 * its WebSocket to the project's `ProjectRoom`.
 *
 * SECURITY: Browsers don't apply CORS to WebSocket upgrades, so a page on
 * any origin could open this socket with the user's cookie. The upgrade is
 * only accepted with an `Origin` equal to the control plane's own.
 *
 * @module
 */
import { createRouter, originOf } from "../context";
import { policyOf, projectRealtime } from "../contracts";
import { ROOM_VIEWER_HEADER, type RoomViewer } from "../durable/project-room";
import { ApiError } from "../lib/errors";
import { projectRoom } from "../lib/realtime";
import { projectScope } from "../lib/scope";

/** Path of the realtime upgrade, for middleware that must leave it untouched. */
export const REALTIME_PATH = /^\/v1\/projects\/[^/]+\/realtime$/;

/** Realtime route. */
export const realtimeRoutes = createRouter().openapi(projectRealtime, async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new ApiError(426, "upgrade_required", "Expected a WebSocket upgrade");
  }
  if (c.req.header("origin") !== originOf(c)) {
    throw new ApiError(403, "forbidden", "Cross-origin WebSocket rejected");
  }
  const { projectId } = c.req.valid("param");
  const { project, caller } = await projectScope(c, projectId, policyOf(projectRealtime).action!);
  const viewer: RoomViewer = {
    user_id: caller.user.id,
    name: caller.user.name,
    image: caller.user.image,
    workspace_id: project.workspaceId,
  };
  const headers = new Headers({ upgrade: "websocket" });
  headers.set(ROOM_VIEWER_HEADER, JSON.stringify(viewer));
  // Only the upgrade and the trusted viewer travel on; the cookie stays here.
  return projectRoom(c.env, projectId).fetch(new Request(c.req.url, { headers }));
});

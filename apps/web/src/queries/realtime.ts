import type { QueryClient } from "@tanstack/react-query";
import type { RealtimeServerMessage } from "../lib/api/deploy-types";
import { appendDeploymentEvent, upsertDeployment } from "./deployments";
import { queryKeys } from "./keys";
import { patchProjectService } from "./services";

/** Timeline events after which a deployment's placements have changed. */
const PLACEMENT_EVENTS = new Set([
  "scheduled",
  "replica_status",
  "rollout_finished",
  "route_switched",
]);

/**
 * Applies a realtime message to the TanStack Query caches, so every open view of a
 * deployment or service updates without refetching. Presence and log lines are not
 * cached; their subscribers handle them.
 *
 * @param queryClient - Shared query client.
 * @param message - A validated server message.
 * @example
 * client = new RealtimeClient({ url, onMessage: (m) => applyRealtimeMessage(queryClient, m) });
 */
export function applyRealtimeMessage(
  queryClient: QueryClient,
  message: RealtimeServerMessage,
): void {
  switch (message.type) {
    case "deployment.updated":
      upsertDeployment(queryClient, message.deployment);
      return;
    case "deployment.event":
      appendDeploymentEvent(queryClient, message.event);
      // NOTE: Events carry no placement rows, and the detail is only cached while
      // someone is looking at it, so a refetch here is cheap and keeps replicas exact.
      if (PLACEMENT_EVENTS.has(message.event.type)) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.deployment(message.event.deployment_id),
          exact: true,
        });
      }
      return;
    case "service.updated":
      patchProjectService(queryClient, message.service, { append: false });
      // NOTE: A deleted service is announced with its row too, and the row has no
      // deleted flag, so the project's service list is refetched to drop it.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.project(message.service.project_id),
        exact: true,
      });
      return;
    default:
      return;
  }
}

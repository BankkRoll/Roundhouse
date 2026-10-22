import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { isApiError } from "../../../lib/api/client";
import { queryKeys } from "../../../queries/keys";

/**
 * Short link to a deployment (`/deployments/<id>`), used by GitHub commit statuses:
 * resolves its service and project, then opens the deployment under its workspace.
 */
export const Route = createFileRoute("/_app/deployments/$deploymentId")({
  staticData: { title: "Deployment" },
  beforeLoad: async ({ context, params }) => {
    // PERF: beforeLoad isn't code-split; a static import would put the deploy API client
    // in the entry chunk for a link that is rarely followed.
    const { deployApi } = await import("../../../lib/api/deploy-client");
    try {
      const deployment = await context.queryClient.fetchQuery({
        queryKey: queryKeys.deployment(params.deploymentId),
        queryFn: () => deployApi.getDeployment(params.deploymentId),
      });
      const service = await deployApi.getService(deployment.service_id);
      const project = await context.queryClient.fetchQuery({
        queryKey: queryKeys.project(service.project_id),
        queryFn: () => deployApi.getProject(service.project_id),
      });
      const environment = project.environments.find((env) => env.id === deployment.environment_id);
      throw redirect({
        to: "/w/$workspaceId/p/$projectId/s/$serviceId/deployments/$deploymentId",
        params: {
          workspaceId: project.workspace_id,
          projectId: project.id,
          serviceId: service.id,
          deploymentId: deployment.id,
        },
        search: {
          env: environment && environment.kind !== "production" ? environment.slug : undefined,
        },
        replace: true,
      });
    } catch (error) {
      if (isApiError(error, 404) || isApiError(error, 403)) throw notFound();
      throw error;
    }
  },
});

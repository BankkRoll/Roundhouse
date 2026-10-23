import { Button, EmptyState, toast } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { BoxesIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { PageHeader } from "../../components/page-header";
import { errorMessage } from "../../lib/api/client";
import type { Service } from "../../lib/api/deploy-types";
import { usePermissions } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import { useDeploy } from "../../queries/deployments";
import { useShellActions } from "../shell/shell-actions";
import { ProjectPresence } from "./presence";
import { ServiceList, useServiceViews } from "./service-list";
import { useProjectEnvironment } from "./use-project-environment";

/**
 * A project's overview: its services in the selected environment, who is viewing, and
 * the actions to add or deploy services. The list is the Phase 1 stand-in for the
 * canvas; both take the same {@link useServiceViews} model.
 *
 * @param props - Workspace and project ids.
 * @returns The page.
 */
export function ProjectPage({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const { project, environment, envParam } = useProjectEnvironment(projectId);
  const { can } = usePermissions(workspaceId);
  const { openNewService } = useShellActions();
  const deploy = useDeploy();
  const now = useNow(15_000);
  const services = project.data?.services ?? [];
  const views = useServiceViews(projectId, services, environment);
  const deployingId = deploy.isPending ? (deploy.variables?.serviceId ?? null) : null;

  function onDeploy(service: Service) {
    if (!environment) return;
    deploy.mutate(
      { serviceId: service.id, environmentId: environment.id },
      {
        onSuccess: () =>
          toast({
            title: `Deploying ${service.name}`,
            description: environment.name,
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title: `Could not deploy ${service.name}`,
            description: errorMessage(error),
            tone: "error",
          }),
      },
    );
  }

  const newService = can("services:manage") ? (
    <Button variant="primary" onClick={() => openNewService(projectId)}>
      <PlusIcon />
      New service
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title={project.data?.name}
        subline={project.data?.description ?? `${services.length} services`}
        actions={
          <>
            <ProjectPresence className="mr-2" />
            {can("projects:manage") ? (
              <Button asChild variant="secondary">
                <Link
                  to="/w/$workspaceId/p/$projectId/settings"
                  params={{ workspaceId, projectId }}
                  search={{ env: envParam }}
                >
                  <SettingsIcon />
                  Settings
                </Link>
              </Button>
            ) : null}
            {newService}
          </>
        }
      />
      {services.length === 0 ? (
        <EmptyState
          icon={<BoxesIcon />}
          title="No services yet"
          description={
            can("services:manage")
              ? "A service runs a Docker image or builds a GitHub repository. Add one to deploy it to your servers."
              : "Services appear here once someone with access adds them."
          }
          action={newService}
          className="py-16"
        />
      ) : (
        <ServiceList
          workspaceId={workspaceId}
          projectId={projectId}
          views={views}
          envParam={envParam}
          onDeploy={can("deployments:create") ? onDeploy : undefined}
          deployingId={deployingId}
          now={now}
        />
      )}
    </>
  );
}

import { Button, EmptyState, toast } from "@roundhouse/ui";
import { SegmentedControl } from "@roundhouse/ui/controls";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { BoxesIcon, ListIcon, NetworkIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { PageHeader } from "../../components/page-header";
import { errorMessage } from "../../lib/api/client";
import type { Service } from "../../lib/api/deploy-types";
import { useNow } from "../../lib/use-now";
import { useDraft } from "../../queries/changes";
import { useDeploy } from "../../queries/deployments";
import { useEnvironmentGate } from "../access/environment-gate";
import { CanvasView } from "../canvas/canvas-view";
import { useShellActions } from "../shell/shell-actions";
import { ProjectPresence } from "./presence";
import { ServiceList, useServiceViews } from "./service-list";
import { useProjectEnvironment } from "./use-project-environment";

/**
 * A project's overview: its services in the selected environment, who is viewing, and
 * the actions to add or deploy services. The canvas (ADR 0006) is the default view and
 * stages edits; the list (`?view=list`) is the accessible alternative with the same
 * actions. Both take the same {@link useServiceViews} model.
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
  const { can } = useEnvironmentGate(workspaceId, projectId, environment);
  const { openNewService } = useShellActions();
  const deploy = useDeploy();
  const now = useNow(15_000);
  const services = project.data?.services ?? [];
  const views = useServiceViews(projectId, services, environment);
  const deployingId = deploy.isPending ? (deploy.variables?.serviceId ?? null) : null;
  const search = useSearch({ strict: false }) as { view?: "list"; review?: string };
  const navigate = useNavigate();
  const draft = useDraft(environment?.id);
  const view = search.view === "list" ? "list" : "canvas";
  const setSearch = (patch: { view?: "list"; review?: string }) =>
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({ ...previous, ...patch }),
      replace: true,
    });

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
            {services.length > 0 || draft.data ? (
              <SegmentedControl
                label="View"
                value={view}
                onValueChange={(next) => setSearch({ view: next === "list" ? "list" : undefined })}
                options={[
                  { value: "canvas", label: <NetworkIcon />, ariaLabel: "Canvas" },
                  { value: "list", label: <ListIcon />, ariaLabel: "List" },
                ]}
              />
            ) : null}
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
            {newService}
          </>
        }
      />
      {services.length === 0 && !draft.data ? (
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
      ) : view === "canvas" && environment ? (
        <CanvasView
          workspaceId={workspaceId}
          projectId={projectId}
          environment={environment}
          envParam={envParam}
          views={views}
          reviewId={search.review}
          onReviewClosed={() => setSearch({ review: undefined })}
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

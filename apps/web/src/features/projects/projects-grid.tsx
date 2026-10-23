import { Button, EmptyState, Skeleton, StatusDot } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { FolderKanbanIcon, PlusIcon } from "lucide-react";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import type { ProjectSummary } from "../../lib/api/deploy-types";
import { formatRelativeTime, formatTimestamp } from "../../lib/format";
import { usePermissions } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import { describeProjectSummary, useProjectSummaries } from "../../queries/projects";
import { useShellActions } from "../shell/shell-actions";
import { PROJECT_HEALTH, ProjectStatusDot } from "./project-status";

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function ProjectCard({
  workspaceId,
  project,
  now,
}: {
  workspaceId: string;
  project: ProjectSummary;
  now: number;
}) {
  const { health, lastDeploy, lastDeployService } = describeProjectSummary(project);
  const { services, environments } = project;

  return (
    <li className="group relative flex flex-col rounded-lg border border-border bg-surface transition-colors focus-within:border-border-strong hover:border-border-strong">
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">
            <Link
              to="/w/$workspaceId/p/$projectId"
              params={{ workspaceId, projectId: project.id }}
              className="outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:underline"
            >
              {project.name}
            </Link>
          </h3>
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {project.description || "No description"}
          </p>
        </div>
        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ProjectStatusDot health={health} />
          <span>{PROJECT_HEALTH[health].label}</span>
        </span>
      </div>
      <div className="flex min-h-12 flex-wrap content-start gap-1.5 px-4 py-3">
        {services.length === 0 ? (
          <span className="text-xs text-subtle-foreground">No services yet</span>
        ) : (
          services.map(({ service, latest_deployment: latest }) => (
            <span
              key={service.id}
              className="inline-flex items-center gap-1.5 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-foreground"
            >
              <StatusDot
                status={latest?.status ?? "idle"}
                kind="deployment"
                label={latest ? undefined : "Never deployed"}
              />
              {service.name}
            </span>
          ))
        )}
      </div>
      <footer className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {plural(services.length, "service")} ·{" "}
          {environments.length === 1 ? environments[0]?.name : plural(environments.length, "env")}
        </span>
        <span className="shrink-0">
          {lastDeploy ? (
            <span title={formatTimestamp(lastDeploy.created_at)}>
              {lastDeployService ? `${lastDeployService.name} ` : ""}deployed{" "}
              {formatRelativeTime(lastDeploy.created_at, now)}
            </span>
          ) : (
            "never deployed"
          )}
        </span>
      </footer>
    </li>
  );
}

/**
 * The home page's projects grid: one card per project with its services (and each
 * one's newest production deployment status), environments and last deploy, all from
 * one summaries request. Every number is real; nothing is estimated.
 *
 * @param props - Workspace id.
 * @returns The section body.
 */
export function ProjectsGrid({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const projects = useProjectSummaries(workspaceId);
  const { openNewProject } = useShellActions();
  const now = useNow(30_000);

  if (projects.isPending) {
    return (
      <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
        <Skeleton className="h-40 rounded-lg" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    );
  }
  if (projects.isError) {
    return (
      <ErrorState message={errorMessage(projects.error)} onRetry={() => void projects.refetch()} />
    );
  }
  if (projects.data.length === 0) {
    return (
      <EmptyState
        icon={<FolderKanbanIcon />}
        title="No projects yet"
        description={
          can("projects:manage")
            ? "Projects group the services you deploy onto your servers. Create one, then add a Docker image or a GitHub repository to it."
            : "Projects group the services deployed onto your servers. Ask an owner or admin to create one."
        }
        action={
          can("projects:manage") ? (
            <Button variant="primary" onClick={openNewProject}>
              <PlusIcon />
              New project
            </Button>
          ) : undefined
        }
        className="py-16"
      />
    );
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {projects.data.map((project) => (
        <ProjectCard key={project.id} workspaceId={workspaceId} project={project} now={now} />
      ))}
    </ul>
  );
}

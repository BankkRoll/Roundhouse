import { cn, SectionLabel, Skeleton } from "@openrail/ui";
import { Link, useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import type { Project } from "../../lib/api/deploy-types";
import { usePermissions } from "../../lib/permissions";
import { useProjectSummary, useProjects } from "../../queries/projects";
import { ProjectStatusDot } from "../projects/project-status";
import { useShellActions } from "./shell-actions";

function ProjectLink({
  workspaceId,
  project,
  active,
  onNavigate,
}: {
  workspaceId: string;
  project: Project;
  active: boolean;
  onNavigate?: () => void;
}) {
  const summary = useProjectSummary(project.id);
  return (
    <li>
      <Link
        to="/w/$workspaceId/p/$projectId"
        params={{ workspaceId, projectId: project.id }}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-7 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          active && "bg-muted text-foreground",
        )}
      >
        <ProjectStatusDot health={summary.health} />
        <span className="flex-1 truncate font-mono text-xs">{project.name}</span>
        {summary.project ? (
          <span className="font-mono text-[10px] text-subtle-foreground tabular-nums">
            {summary.project.services.length}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/**
 * The sidebar's PROJECTS list: every project with a status dot summarising its
 * services' newest deployments, and the service count.
 *
 * @param props - Workspace id and a callback when a link is followed (mobile drawer).
 * @returns The list.
 */
export function ProjectsNav({
  workspaceId,
  onNavigate,
}: {
  workspaceId: string;
  onNavigate?: () => void;
}) {
  const { can } = usePermissions(workspaceId);
  const projects = useProjects(workspaceId, can("projects:read"));
  const { openNewProject } = useShellActions();
  const { projectId } = useParams({ strict: false }) as { projectId?: string };

  return (
    <nav aria-label="Projects" className="grid gap-1.5">
      <div className="flex items-center justify-between px-1.5">
        <SectionLabel>Projects</SectionLabel>
        {can("projects:manage") ? (
          <button
            type="button"
            onClick={openNewProject}
            aria-label="Create a project"
            className="rounded-sm p-0.5 text-subtle-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PlusIcon className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {projects.isPending ? (
        <div className="grid gap-1.5 px-2">
          <Skeleton className="h-4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : projects.isError ? (
        <p className="px-1.5 text-xs text-subtle-foreground">Could not load projects.</p>
      ) : projects.data.length === 0 ? (
        <p className="px-1.5 text-xs text-subtle-foreground">No projects yet.</p>
      ) : (
        <ul className="grid max-h-[40vh] gap-0.5 overflow-y-auto">
          {projects.data.map((project) => (
            <ProjectLink
              key={project.id}
              workspaceId={workspaceId}
              project={project}
              active={project.id === projectId}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}

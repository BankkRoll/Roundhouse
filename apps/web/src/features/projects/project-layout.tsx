import { EmptyState, Skeleton } from "@openrail/ui";
import { Link, Outlet } from "@tanstack/react-router";
import { FolderXIcon } from "lucide-react";
import { ErrorState } from "../../components/error-state";
import { errorMessage, isApiError } from "../../lib/api/client";
import { RealtimeProvider } from "../../lib/realtime/provider";
import { useProject } from "../../queries/projects";

/**
 * Layout for every page of a project: loads the project once, shows its loading, missing
 * and error states, and holds the project's single realtime socket while any of its
 * pages is open.
 *
 * @param props - Workspace and project ids.
 * @returns The layout.
 */
export function ProjectLayout({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const project = useProject(projectId);

  if (project.isPending) {
    return (
      <div aria-busy="true" className="grid gap-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-4 w-96" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-36 rounded-lg" />
          <Skeleton className="h-36 rounded-lg" />
          <Skeleton className="h-36 rounded-lg" />
        </div>
      </div>
    );
  }
  if (project.isError) {
    return isApiError(project.error, 404) ? (
      <EmptyState
        icon={<FolderXIcon />}
        title="Project not found"
        description="It may have been deleted, or you no longer have access to it."
        action={
          <Link
            to="/w/$workspaceId"
            params={{ workspaceId }}
            className="text-sm text-accent-text underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            Back to projects
          </Link>
        }
        className="py-16"
      />
    ) : (
      <ErrorState message={errorMessage(project.error)} onRetry={() => void project.refetch()} />
    );
  }
  return (
    <RealtimeProvider projectId={projectId}>
      <Outlet />
    </RealtimeProvider>
  );
}

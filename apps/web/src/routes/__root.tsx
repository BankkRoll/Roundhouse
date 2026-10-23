import { useQuery } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet, useMatches } from "@tanstack/react-router";
import { useEffect } from "react";
import type { ProjectDetail } from "../lib/api/deploy-types";
import { formatDocumentTitle } from "../lib/document-title";
import { useCachedQueryData } from "../lib/use-cached-query-data";
import { queryKeys } from "../queries/keys";
import { meQueryOptions } from "../queries/me";
import type { RouterContext } from "../router";

/** Root of the route tree: provides router context and keeps the tab title current. */
export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
});

/**
 * Sets the tab title from the deepest route's `staticData.title` plus the workspace
 * name, e.g. "Servers · Nightjar Labs · OpenRail". Routes without a title (the landing
 * page) manage their own.
 */
function useDocumentTitle(): void {
  const { page, workspaceId, projectId, serviceId } = useMatches({
    select: (matches) => {
      const titled = [...matches].reverse().find((match) => match.staticData.title);
      const params = matches.at(-1)?.params as
        | { workspaceId?: string; projectId?: string; serviceId?: string }
        | undefined;
      return { page: titled?.staticData.title, ...params };
    },
  });
  // NOTE: Reads the cache without fetching, so public pages never call the API.
  const { data: me } = useQuery({ ...meQueryOptions(), enabled: false });
  // NOTE: Cache-only too, and without the project query module, which would pull the
  // deploy API client into the entry chunk.
  const project = useCachedQueryData<ProjectDetail>(queryKeys.project(projectId ?? ""));
  const workspace = me?.workspaces.find((entry) => entry.id === workspaceId)?.name;
  const service = project?.services.find((entry) => entry.id === serviceId)?.name;
  const projectName = projectId ? project?.name : undefined;

  useEffect(() => {
    if (page) document.title = formatDocumentTitle(page, service, projectName, workspace);
  }, [page, service, projectName, workspace]);
}

function Root() {
  useDocumentTitle();
  return <Outlet />;
}

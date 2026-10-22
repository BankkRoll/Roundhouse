import { useQuery } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet, useMatches } from "@tanstack/react-router";
import { useEffect } from "react";
import { formatDocumentTitle } from "../lib/document-title";
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
  const { page, workspaceId } = useMatches({
    select: (matches) => {
      const titled = [...matches].reverse().find((match) => match.staticData.title);
      const params = matches.at(-1)?.params as { workspaceId?: string } | undefined;
      return { page: titled?.staticData.title, workspaceId: params?.workspaceId };
    },
  });
  // NOTE: Reads the cache without fetching, so public pages never call the API.
  const { data: me } = useQuery({ ...meQueryOptions(), enabled: false });
  const workspace = me?.workspaces.find((entry) => entry.id === workspaceId)?.name;

  useEffect(() => {
    if (page) document.title = formatDocumentTitle(page, workspace);
  }, [page, workspace]);
}

function Root() {
  useDocumentTitle();
  return <Outlet />;
}

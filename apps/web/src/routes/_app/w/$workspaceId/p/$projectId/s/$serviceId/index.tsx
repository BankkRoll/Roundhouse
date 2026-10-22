import { createFileRoute, redirect } from "@tanstack/react-router";

/** A service opens on its deployments. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/s/$serviceId/")({
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/w/$workspaceId/p/$projectId/s/$serviceId/deployments",
      params,
      search,
      replace: true,
    });
  },
});

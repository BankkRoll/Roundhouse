import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireSession } from "../lib/route-guards";

/** Signed-in area: loads `/v1/me` (or redirects to sign in) for every child route. */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const me = await requireSession(context.queryClient, location.href);
    return { me };
  },
  component: Outlet,
});

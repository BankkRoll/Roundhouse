/**
 * Navigation guards shared by route `beforeLoad` hooks. They decide where a visitor
 * belongs based on setup state and session:
 *
 * - setup not done          → /setup
 * - signed out              → /login?redirect=<where they were going>
 * - not a member of the URL's workspace → /
 *
 * @module
 */
import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { meQueryOptions } from "../queries/me";
import { setupQueryOptions } from "../queries/setup";
import { isApiError } from "./api/client";
import type { Me } from "./api/types";

/**
 * Sends the visitor to the setup wizard when the instance has not been set up.
 *
 * @param queryClient - Shared query client.
 * @throws A router redirect to `/setup`.
 */
export async function ensureSetupDone(queryClient: QueryClient): Promise<void> {
  const status = await queryClient.fetchQuery(setupQueryOptions());
  if (status.needs_setup) throw redirect({ to: "/setup" });
}

/**
 * Loads `/v1/me`, redirecting to the login page (or setup) when signed out.
 *
 * @param queryClient - Shared query client.
 * @param returnTo - Path to come back to after signing in.
 * @returns The current user and their workspaces.
 * @throws A router redirect to `/login` or `/setup`.
 */
export async function requireSession(queryClient: QueryClient, returnTo: string): Promise<Me> {
  try {
    return await queryClient.ensureQueryData(meQueryOptions());
  } catch (error) {
    if (!isApiError(error, 401)) throw error;
    await ensureSetupDone(queryClient);
    throw redirect({
      to: "/login",
      search: { redirect: returnTo === "/" ? undefined : returnTo },
    });
  }
}

/**
 * Finds the caller's membership for a workspace, refetching `/v1/me` once when it is
 * missing from the cache. That covers workspaces created or joined moments ago.
 *
 * @param queryClient - Shared query client.
 * @param me - Possibly stale `/v1/me` data.
 * @param workspaceId - Workspace from the URL.
 * @returns The membership.
 * @throws A router redirect to `/` when the caller is not a member.
 */
export async function requireMembership(queryClient: QueryClient, me: Me, workspaceId: string) {
  let membership = me.workspaces.find((workspace) => workspace.id === workspaceId);
  if (!membership) {
    const fresh = await queryClient.fetchQuery({ ...meQueryOptions(), staleTime: 0 });
    membership = fresh.workspaces.find((workspace) => workspace.id === workspaceId);
  }
  if (!membership) throw redirect({ to: "/dashboard" });
  return membership;
}

import { toast } from "@roundhouse/ui";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, errorMessage } from "../lib/api/client";
import { queryKeys } from "./keys";

/**
 * Query options for the signed-in user and their workspaces. A 401 means signed out.
 *
 * @returns Options for `useQuery` / `ensureQueryData`.
 */
export function meQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => api.getMe(signal),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Reads `GET /v1/me`.
 *
 * @returns The current-user query.
 */
export function useMe() {
  return useQuery(meQueryOptions());
}

/**
 * The caller's membership (and role) in a workspace, from the cached `/v1/me`.
 *
 * @param workspaceId - Workspace to look up.
 * @returns The membership, or `undefined` while loading or when not a member.
 */
export function useMembership(workspaceId: string) {
  const { data } = useMe();
  return data?.workspaces.find((workspace) => workspace.id === workspaceId);
}

/**
 * Creates a workspace and refreshes `/v1/me` so it shows up in the switcher.
 *
 * @returns A mutation resolving to the new workspace.
 */
export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createWorkspace(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

/** Options for {@link useSignOut}. */
export interface SignOutOptions {
  /** Go to the sign-in page afterwards. Defaults to `true`. */
  redirectToLogin?: boolean;
}

/**
 * Signs out and drops every cached query, so no data from the previous session leaks
 * into the next one, then goes to the sign-in page. If the server refuses, nothing is
 * cleared and a toast explains why.
 *
 * @param options - Whether to leave the current page afterwards.
 * @returns A mutation; call `mutate()` with no arguments.
 */
export function useSignOut({ redirectToLogin = true }: SignOutOptions = {}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api.signOut(),
    onSuccess: async () => {
      queryClient.clear();
      if (redirectToLogin) await navigate({ to: "/login" });
    },
    onError: (error) =>
      toast({ title: "Could not sign out", description: errorMessage(error), tone: "error" }),
  });
}

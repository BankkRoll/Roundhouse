import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api/client";
import type { SetupRequest } from "../lib/api/types";
import { queryKeys } from "./keys";

/**
 * Query options for first-run setup status. Always refetched on mount because it flips
 * once, from the setup wizard.
 *
 * @returns Options for `useQuery` / `ensureQueryData`.
 */
export function setupQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.setup,
    queryFn: ({ signal }) => api.getSetup(signal),
    staleTime: 0,
  });
}

/**
 * Reads `GET /v1/setup`.
 *
 * @returns The setup status query.
 */
export function useSetupStatus() {
  return useQuery(setupQueryOptions());
}

/**
 * Submits the first-run admin account and workspace. The API signs the new admin in.
 *
 * @returns A mutation resolving to the new user and workspace ids.
 */
export function useCompleteSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SetupRequest) => api.completeSetup(body),
    // SECURITY: The variables hold the master key and password. Drop the mutation from
    // the MutationCache as soon as the form unmounts instead of after the default 5 min.
    gcTime: 0,
    onSuccess: () => {
      queryClient.setQueryData(queryKeys.setup, {
        needs_setup: false,
        master_key_configured: true,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

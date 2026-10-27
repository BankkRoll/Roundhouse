import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api/client";
import type { SetupRequest } from "../lib/api/types";
import { queryKeys } from "./keys";

/**
 * Query options for first-run setup status. Always stale, so route guards fetch it fresh,
 * because it flips once, from the setup wizard.
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
 * Reads `GET /v1/setup` for the setup wizard.
 *
 * The `/setup` route fetches a fresh copy in `beforeLoad`, so the wizard does not refetch
 * on mount. That refetch would only repeat the request, landing after the first step had
 * rendered, where a changed answer could switch steps under the operator's form.
 *
 * @returns The setup status query.
 */
export function useSetupStatus() {
  return useQuery({ ...setupQueryOptions(), refetchOnMount: false });
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

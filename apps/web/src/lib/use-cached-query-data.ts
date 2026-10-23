import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Reads a query's cached data and re-renders when the cache changes, without fetching
 * and without registering an observer on the query.
 *
 * NOTE: A `useQuery` observer (even a disabled or `skipToken` one) writes its options onto
 * the shared query each time it renders. A cache-only observer rendered after the real
 * one would replace the query's `queryFn`, and the next invalidation would fail with
 * "Missing queryFn". Subscribing to the cache avoids touching the query at all.
 *
 * @param queryKey - Key of the query to read.
 * @returns The cached data, or `undefined` when nothing is cached.
 * @example
 * const project = useCachedQueryData<ProjectDetail>(queryKeys.project(projectId));
 */
export function useCachedQueryData<T>(queryKey: QueryKey): T | undefined {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  return useSyncExternalStore(
    subscribe,
    () => queryClient.getQueryData<T>(queryKey),
    () => undefined,
  );
}

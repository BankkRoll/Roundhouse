import { hashKey, MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queries/keys";
import { isApiError } from "./api/client";

/** Options for {@link createQueryClient}. */
export interface QueryClientOptions {
  /** Called when any query or mutation gets a 401, i.e. the session ended mid-use. */
  onUnauthorized?: () => void;
  /** Disable retries (tests). */
  retry?: boolean;
}

/**
 * Whether a failed request is worth retrying: network errors and 5xx, never 4xx.
 *
 * @param failureCount - Attempts so far.
 * @param error - The error from the last attempt.
 * @returns `true` to retry.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (isApiError(error)) return error.status === 0 || error.status >= 500;
  return false;
}

const ME_KEY_HASH = hashKey(queryKeys.me);

/**
 * Creates the app's QueryClient with API-aware retry and session-expiry handling.
 *
 * @param options - Unauthorized callback and retry toggle.
 * @returns A configured QueryClient.
 */
export function createQueryClient(options: QueryClientOptions = {}): QueryClient {
  const onError = (error: unknown) => {
    if (isApiError(error, 401)) options.onUnauthorized?.();
  };
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        // NOTE: A 401 on `/v1/me` is how the route guards learn the visitor is signed out,
        // and they redirect (with the right return path) themselves. Handling it here too
        // would race them with a second navigation.
        if (query.queryHash === ME_KEY_HASH) return;
        onError(error);
      },
    }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        retry: options.retry === false ? false : shouldRetry,
        staleTime: 10_000,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CLOUDFLARE_ROLLOUT_STATUSES,
  cloudflareApi,
  type PutInstanceCloudflareBody,
} from "../lib/api/cloudflare-client";

/** Query keys of the Cloudflare resources. */
export const cloudflareKeys = {
  instance: ["instance", "cloudflare"] as const,
  /** Every service's Cloudflare view; prefix of {@link cloudflareKeys.service}. */
  services: ["services", "cloudflare"] as const,
  service: (serviceId: string, environmentId: string) =>
    ["services", "cloudflare", serviceId, environmentId] as const,
};

/**
 * Reads the instance's Cloudflare account. Instance admins only.
 *
 * @param enabled - Skip for callers without `instance:manage`.
 * @returns The query.
 */
export function useInstanceCloudflare(enabled = true) {
  return useQuery({
    queryKey: cloudflareKeys.instance,
    queryFn: ({ signal }) => cloudflareApi.getInstance(signal),
    enabled,
  });
}

/**
 * Sets the instance's Cloudflare account and token, and caches the result.
 *
 * @returns A mutation taking the account id and token.
 */
export function useSaveInstanceCloudflare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PutInstanceCloudflareBody) => cloudflareApi.putInstance(body),
    onSuccess: (settings) => {
      queryClient.setQueryData(cloudflareKeys.instance, settings);
      void queryClient.invalidateQueries({ queryKey: cloudflareKeys.services });
    },
  });
}

/**
 * Removes the instance's Cloudflare account.
 *
 * @returns A mutation.
 */
export function useDeleteInstanceCloudflare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => cloudflareApi.deleteInstance(),
    onSuccess: (settings) => {
      queryClient.setQueryData(cloudflareKeys.instance, settings);
      void queryClient.invalidateQueries({ queryKey: cloudflareKeys.services });
    },
  });
}

/**
 * Re-checks the stored Cloudflare token.
 *
 * @returns A mutation resolving to the checks.
 */
export function useVerifyInstanceCloudflare() {
  return useMutation({ mutationFn: () => cloudflareApi.verify() });
}

/** How often a service's runtime refreshes while a Cloudflare rollout is in progress. */
export const CLOUDFLARE_RUNTIME_POLL_MS = 10_000;

/**
 * Reads a service's provider, Cloudflare eligibility and runtime in an environment.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits for it.
 * @returns The query.
 */
export function useServiceCloudflare(serviceId: string, environmentId: string | undefined) {
  return useQuery({
    queryKey: cloudflareKeys.service(serviceId, environmentId ?? ""),
    queryFn: ({ signal }) => cloudflareApi.getService(serviceId, environmentId ?? "", signal),
    enabled: Boolean(environmentId),
    refetchInterval: (query) => {
      const latest = query.state.data?.deployments[0];
      return latest && CLOUDFLARE_ROLLOUT_STATUSES.has(latest.status)
        ? CLOUDFLARE_RUNTIME_POLL_MS
        : false;
    },
  });
}

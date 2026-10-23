/**
 * Custom-domain queries and mutations. The list polls while a custom domain is still
 * being verified or issued, so the status updates live without a reload.
 *
 * @module
 */
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Domain } from "../lib/api/deploy-types";
import { domainsApi } from "../lib/api/domains-client";
import { queryKeys } from "./keys";
import { domainsQueryOptions } from "./services";

/** How often the list refetches while a custom domain is in progress. */
export const DOMAIN_POLL_MS = 10_000;

/** Statuses that change without the user doing anything. */
const IN_PROGRESS = new Set<Domain["status"]>(["pending_dns", "pending_verification", "issuing"]);

/**
 * Whether a domain is still moving on its own (being verified or issued).
 *
 * @param domain - A domain.
 * @returns `true` for custom domains that aren't `active` or `failed` yet.
 */
export function isInProgress(domain: Domain): boolean {
  return domain.type === "custom" && IN_PROGRESS.has(domain.status);
}

/**
 * Reads a service's domains in an environment, polling while one is in progress.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @returns The domains query.
 */
export function useServiceDomains(serviceId: string, environmentId: string | undefined) {
  return useQuery({
    ...domainsQueryOptions(serviceId, environmentId ?? ""),
    enabled: Boolean(environmentId),
    refetchInterval: (query) =>
      query.state.data?.domains.some(isInProgress) ? DOMAIN_POLL_MS : false,
  });
}

function upsert(queryClient: QueryClient, domain: Domain) {
  queryClient.setQueryData<{ domains: Domain[] }>(
    queryKeys.domains(domain.service_id, domain.environment_id),
    (data) => {
      if (!data) return data;
      const rest = data.domains.filter((d) => d.id !== domain.id);
      return {
        domains: [...rest, domain].sort((a, b) => a.hostname.localeCompare(b.hostname)),
      };
    },
  );
}

/**
 * Adds a custom domain to a service.
 *
 * @param serviceId - Service id.
 * @returns The mutation; its result is the new domain with its records.
 */
export function useAddDomain(serviceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { environment_id: string; hostname: string }) =>
      domainsApi.add(serviceId, body),
    onSuccess: (domain) => upsert(queryClient, domain),
  });
}

/**
 * Checks a domain's DNS now.
 *
 * @returns The mutation; its result is the domain after the check.
 */
export function useCheckDomain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (domain: Domain) => domainsApi.check(domain.id),
    onSuccess: (domain) => upsert(queryClient, domain),
  });
}

/**
 * Removes a custom domain.
 *
 * @returns The mutation.
 */
export function useRemoveDomain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (domain: Domain) => domainsApi.remove(domain.id),
    onSuccess: (_, domain) =>
      queryClient.setQueryData<{ domains: Domain[] }>(
        queryKeys.domains(domain.service_id, domain.environment_id),
        (data) => data && { domains: data.domains.filter((d) => d.id !== domain.id) },
      ),
  });
}

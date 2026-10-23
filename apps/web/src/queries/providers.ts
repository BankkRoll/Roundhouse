/**
 * Queries and mutations for cloud providers: integrations, offers and one-click
 * provisioning runs.
 *
 * @module
 */
import type { ProviderId } from "@roundhouse/providers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { providersApi } from "../lib/api/providers-client";
import type {
  NodeProvision,
  NodeProvisionStatus,
  OfferRole,
  ProviderIntegration,
  ProvisionNodeBody,
} from "../lib/api/providers-types";
import { queryKeys } from "./keys";
import { NODE_POLL_INTERVAL_MS } from "./nodes";

/** How often a provisioning run is polled while it is still in flight. */
export const PROVISION_POLL_INTERVAL_MS = 2_000;

/**
 * Whether a provisioning run is still working towards a joined node.
 *
 * @param status - The run's status.
 * @returns `true` for `queued`, `creating` and `booting`.
 */
export function isProvisionInFlight(status: NodeProvisionStatus): boolean {
  return status === "queued" || status === "creating" || status === "booting";
}

/**
 * Reads every provider and whether the workspace is connected to it.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip for callers without `nodes:manage`.
 * @returns The integrations query (data is the integration array).
 */
export function useIntegrations(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.integrations(workspaceId),
    queryFn: ({ signal }) => providersApi.listIntegrations(workspaceId, signal),
    select: (data) => data.integrations,
    enabled,
  });
}

/**
 * A provider token on its way to the API. {@link useConnectProvider} empties it as the
 * request starts.
 */
export interface TokenEnvelope {
  /** The token; `""` once sent. */
  value: string;
}

function replaceIntegration(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
  integration: ProviderIntegration,
) {
  queryClient.setQueryData<{ integrations: ProviderIntegration[] }>(
    queryKeys.integrations(workspaceId),
    (data) =>
      data
        ? {
            integrations: data.integrations.map((entry) =>
              entry.provider === integration.provider ? integration : entry,
            ),
          }
        : data,
  );
}

/**
 * Connects (or re-keys) a provider. 400 `provider_token_invalid` when the provider
 * rejects the token, 409 `provider_read_only` when it cannot create servers.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking the provider and a {@link TokenEnvelope}.
 */
export function useConnectProvider(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // SECURITY: TanStack keeps a mutation's variables in its cache for as long as the
    // mutation is observed. The token travels in an envelope that is emptied before the
    // request goes out, so neither the cache nor devtools ever hold it afterwards.
    mutationFn: ({ provider, token }: { provider: ProviderId; token: TokenEnvelope }) => {
      const value = token.value;
      token.value = "";
      return providersApi.connect(workspaceId, provider, value);
    },
    gcTime: 0,
    onSuccess: (integration) => {
      replaceIntegration(queryClient, workspaceId, integration);
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.integrations(workspaceId), integration.provider],
      });
    },
  });
}

/**
 * Disconnects a provider and drops its cached offers.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking the provider and whether to force past existing servers.
 */
export function useDisconnectProvider(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, force = false }: { provider: ProviderId; force?: boolean }) =>
      providersApi.disconnect(workspaceId, provider, force),
    onSuccess: (_, { provider }) => {
      queryClient.removeQueries({ queryKey: [...queryKeys.integrations(workspaceId), provider] });
      return queryClient.invalidateQueries({
        queryKey: queryKeys.integrations(workspaceId),
        exact: true,
      });
    },
  });
}

/**
 * Reads a connected provider's offers for a role.
 *
 * @param workspaceId - Workspace id.
 * @param provider - Provider id.
 * @param role - `node` or `builder`.
 * @param enabled - Only once the provider is connected.
 * @returns The offers query.
 */
export function useProviderOffers(
  workspaceId: string,
  provider: ProviderId,
  role: OfferRole,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.providerOffers(workspaceId, provider, role),
    queryFn: ({ signal }) => providersApi.listOffers(workspaceId, provider, role, signal),
    // NOTE: The API caches prices briefly too; a minute avoids refetching on every toggle.
    staleTime: 60_000,
    enabled,
  });
}

/**
 * Starts provisioning a cloud server and seeds its run into the cache.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking provider, plan, region, name and builder flag.
 */
export function useProvisionNode(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ProvisionNodeBody) => providersApi.provision(workspaceId, body),
    onSuccess: (provision) => {
      queryClient.setQueryData(queryKeys.nodeProvision(workspaceId, provision.id), provision);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.nodeProvisions(workspaceId),
        exact: true,
      });
    },
  });
}

/**
 * Reads recent provisioning runs, polling quickly while any is in flight.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip for callers without `nodes:read`.
 * @returns The provisions query (data is the run array, newest first).
 */
export function useNodeProvisions(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.nodeProvisions(workspaceId),
    queryFn: ({ signal }) => providersApi.listProvisions(workspaceId, signal),
    select: (data) => data.provisions,
    refetchInterval: (query) =>
      query.state.data?.provisions.some((run) => isProvisionInFlight(run.status))
        ? PROVISION_POLL_INTERVAL_MS
        : NODE_POLL_INTERVAL_MS,
    enabled,
  });
}

/**
 * Follows one provisioning run until it joins or fails. Once it joins, the node list is
 * refreshed so the new server shows up everywhere.
 *
 * @param workspaceId - Workspace id.
 * @param provisionId - Run id.
 * @param pollIntervalMs - Interval while in flight.
 * @returns The run query.
 */
export function useNodeProvision(
  workspaceId: string,
  provisionId: string,
  pollIntervalMs = PROVISION_POLL_INTERVAL_MS,
) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.nodeProvision(workspaceId, provisionId),
    queryFn: async ({ signal }): Promise<NodeProvision> => {
      const run = await providersApi.getProvision(workspaceId, provisionId, signal);
      if (run.status === "joined") {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.nodes(workspaceId),
          exact: true,
        });
      }
      return run;
    },
    refetchInterval: (query) =>
      query.state.status === "error" ||
      (query.state.data && !isProvisionInFlight(query.state.data.status))
        ? false
        : pollIntervalMs,
  });
}

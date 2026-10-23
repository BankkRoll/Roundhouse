/**
 * Queries and mutations for MCP OAuth: the consent screen and the signed-in user's
 * connected MCP clients.
 *
 * @module
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { oauthApi } from "../lib/api/oauth-client";
import type { AuthorizationParams, ConnectedMcpClient } from "../lib/api/oauth-types";

/** Cache keys for MCP OAuth; per user, not per workspace. */
export const oauthKeys = {
  consent: (params: AuthorizationParams) => ["oauth", "consent", params] as const,
  clients: ["oauth", "clients"] as const,
};

/**
 * Validates an authorization request and loads its consent screen. Never retried or
 * refetched in the background: each load mints a new consent token.
 *
 * @param params - The request's parameters, from the page URL.
 * @returns The consent query.
 */
export function useOAuthConsent(params: AuthorizationParams) {
  return useQuery({
    queryKey: oauthKeys.consent(params),
    queryFn: ({ signal }) => oauthApi.getConsent(params, signal),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

/**
 * Approves or denies an authorization request; the caller then navigates to
 * `redirect_to`, which leaves the dashboard.
 *
 * @returns The decision mutation.
 */
export function useDecideOAuthConsent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: oauthApi.decide,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: oauthKeys.clients }),
  });
}

/**
 * Reads the signed-in user's connected MCP clients.
 *
 * @returns The clients query.
 */
export function useConnectedClients() {
  return useQuery({
    queryKey: oauthKeys.clients,
    queryFn: ({ signal }) => oauthApi.listClients(signal),
    select: (data) => data.clients,
  });
}

/**
 * Disconnects a client, dropping it from the cached list straight away.
 *
 * @returns A mutation taking the grant id.
 */
export function useRevokeConnectedClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) => oauthApi.revokeClient(grantId),
    onSuccess: (_, grantId) => {
      queryClient.setQueryData<{ clients: ConnectedMcpClient[] }>(oauthKeys.clients, (data) =>
        data ? { clients: data.clients.filter((c) => c.id !== grantId) } : data,
      );
      void queryClient.invalidateQueries({ queryKey: oauthKeys.clients });
    },
  });
}

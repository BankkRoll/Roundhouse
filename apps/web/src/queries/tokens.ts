import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deployApi } from "../lib/api/deploy-client";
import type { ApiToken, CreateApiTokenBody } from "../lib/api/deploy-types";
import { queryKeys } from "./keys";

/** Whether a token can still be used, and if not, why. */
export type ApiTokenState = "active" | "expired" | "revoked";

/**
 * Derives a token's state. Revocation wins over expiry, since it was a deliberate act.
 *
 * @param token - A listed token.
 * @param now - Current time in ms.
 * @returns `revoked`, `expired` or `active`.
 * @example
 * apiTokenState({ revoked_at: null, expires_at: Date.now() - 1 }, Date.now()); // "expired"
 */
export function apiTokenState(
  token: Pick<ApiToken, "revoked_at" | "expires_at">,
  now: number,
): ApiTokenState {
  if (token.revoked_at !== null) return "revoked";
  if (token.expires_at !== null && token.expires_at <= now) return "expired";
  return "active";
}

/**
 * Reads a workspace's API tokens, newest first, revoked and expired ones included.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip for callers without `tokens:manage`.
 * @returns The tokens query.
 */
export function useApiTokens(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tokens(workspaceId),
    queryFn: ({ signal }) => deployApi.listApiTokens(workspaceId, signal),
    select: (data) => data.tokens,
    enabled,
  });
}

/**
 * Creates an API token and adds it to the cached list. The secret is only in the
 * mutation's result; it is never cached.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking name, scopes and lifetime, resolving to the token and secret.
 */
export function useCreateApiToken(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateApiTokenBody) => deployApi.createApiToken(workspaceId, body),
    onSuccess: ({ token }) => {
      queryClient.setQueryData<{ tokens: ApiToken[] }>(queryKeys.tokens(workspaceId), (data) =>
        data ? { tokens: [token, ...data.tokens.filter((entry) => entry.id !== token.id)] } : data,
      );
    },
  });
}

/**
 * Revokes a token, marking it revoked in the cached list straight away and refetching to
 * pick up the server's timestamp.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking the token id.
 */
export function useRevokeApiToken(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => deployApi.revokeApiToken(workspaceId, tokenId),
    onSuccess: (_, tokenId) => {
      const revokedAt = Date.now();
      queryClient.setQueryData<{ tokens: ApiToken[] }>(queryKeys.tokens(workspaceId), (data) =>
        data
          ? {
              tokens: data.tokens.map((entry) =>
                entry.id === tokenId && entry.revoked_at === null
                  ? { ...entry, revoked_at: revokedAt }
                  : entry,
              ),
            }
          : data,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.tokens(workspaceId) });
    },
  });
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api/client";
import type { AcceptInviteRequest } from "../lib/api/types";
import { queryKeys } from "./keys";

/**
 * Reads the public preview of an invite link.
 *
 * @param token - Invite token from the URL.
 * @returns The preview query. A 404 means the link is invalid, already used, or expired.
 */
export function useInvitePreview(token: string) {
  return useQuery({
    queryKey: queryKeys.invite(token),
    queryFn: ({ signal }) => api.getInvite(token, signal),
    retry: false,
  });
}

/**
 * Accepts an invite, creating an account first when the visitor is signed out. Refreshes
 * `/v1/me` so the new workspace is known before navigating to it.
 *
 * @param token - Invite token from the URL.
 * @returns A mutation resolving to the joined workspace id.
 */
export function useAcceptInvite(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AcceptInviteRequest) => api.acceptInvite(token, body),
    // SECURITY: The variables hold the new account's password; see useCompleteSetup.
    gcTime: 0,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

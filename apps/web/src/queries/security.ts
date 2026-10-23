/**
 * Queries and mutations for account security: two-factor state, enrollment and
 * changes, re-authentication, and the signed-in user's sessions.
 *
 * SECURITY: Mutations that carry a password, a code or backup codes use `gcTime: 0`, so
 * their variables and results leave the MutationCache as soon as the form unmounts.
 *
 * @module
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { securityApi } from "../lib/api/security-client";
import { queryKeys } from "./keys";

/** Cache keys for account security; per user, not per workspace. */
export const securityKeys = {
  status: ["account", "security"] as const,
  sessions: ["account", "sessions"] as const,
};

/**
 * Query options for the caller's security status.
 *
 * @returns Options for `useQuery` / `ensureQueryData`.
 */
export function securityStatusQueryOptions() {
  return queryOptions({
    queryKey: securityKeys.status,
    queryFn: ({ signal }) => securityApi.getStatus(signal),
  });
}

/**
 * Reads `GET /v1/auth/security`.
 *
 * @returns The status query.
 */
export function useSecurityStatus() {
  return useQuery(securityStatusQueryOptions());
}

/**
 * Reads the caller's sessions.
 *
 * @returns The sessions query.
 */
export function useSessions() {
  return useQuery({
    queryKey: securityKeys.sessions,
    queryFn: ({ signal }) => securityApi.listSessions(signal),
    select: (data) => data.sessions,
  });
}

function useInvalidateSecurity() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: securityKeys.status }),
      queryClient.invalidateQueries({ queryKey: queryKeys.me }),
    ]);
}

/**
 * Starts two-factor enrollment with the password.
 *
 * @returns A mutation resolving to the TOTP URI and backup codes.
 */
export function useEnableTwoFactor() {
  return useMutation({ mutationFn: securityApi.enableTwoFactor, gcTime: 0 });
}

/**
 * Finishes enrollment with a code from the authenticator app.
 *
 * @returns The verification mutation.
 */
export function useConfirmTwoFactor() {
  const invalidate = useInvalidateSecurity();
  return useMutation({
    mutationFn: securityApi.verifyTotp,
    gcTime: 0,
    onSuccess: () => invalidate(),
  });
}

/**
 * Turns two-factor off with the password and a current code.
 *
 * @returns The mutation.
 */
export function useDisableTwoFactor() {
  const invalidate = useInvalidateSecurity();
  return useMutation({
    mutationFn: ({ password, code }: { password: string; code: string }) =>
      securityApi.disableTwoFactor(password, code),
    gcTime: 0,
    onSuccess: () => invalidate(),
  });
}

/**
 * Replaces the backup codes, with the password and a current code.
 *
 * @returns A mutation resolving to the new codes.
 */
export function useRegenerateBackupCodes() {
  const invalidate = useInvalidateSecurity();
  return useMutation({
    mutationFn: ({ password, code }: { password: string; code: string }) =>
      securityApi.regenerateBackupCodes(password, code),
    gcTime: 0,
    onSuccess: () => invalidate(),
  });
}

/**
 * Re-authenticates, making dangerous actions possible for a few minutes.
 *
 * @returns The mutation.
 */
export function useReauthenticate() {
  const invalidate = useInvalidateSecurity();
  return useMutation({
    mutationFn: securityApi.reauthenticate,
    gcTime: 0,
    onSuccess: () => invalidate(),
  });
}

/**
 * Ends one of the caller's sessions.
 *
 * @returns The mutation.
 */
export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: securityApi.revokeSession,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: securityKeys.sessions }),
  });
}

/**
 * Ends every session but the current one.
 *
 * @returns The mutation.
 */
export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: securityApi.revokeOtherSessions,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: securityKeys.sessions }),
  });
}

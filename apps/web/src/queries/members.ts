import type { Role } from "@openrail/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "../lib/api/client";
import { queryKeys } from "./keys";
import { meQueryOptions } from "./me";

/**
 * Reads workspace members.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip the request when the caller cannot read members.
 * @returns The members query.
 */
export function useMembers(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.members(workspaceId),
    queryFn: ({ signal }) => api.listMembers(workspaceId, signal),
    select: (data) => data.members,
    enabled,
  });
}

/**
 * Changes a member's role.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking `{ memberId, role }`.
 */
export function useUpdateMemberRole(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: Role }) =>
      api.updateMember(workspaceId, memberId, role),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.members(workspaceId) }),
  });
}

/**
 * Removes a member from the workspace.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking the membership id.
 */
export function useRemoveMember(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => api.removeMember(workspaceId, memberId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.members(workspaceId) }),
  });
}

/**
 * Leaves a workspace by removing the caller's own membership, then opens the dashboard
 * entry point, which picks another workspace or explains there is none. Fails with 409
 * `last_owner` when the caller is the only owner.
 *
 * @param workspaceId - Workspace to leave.
 * @returns A mutation taking the caller's own membership id.
 */
export function useLeaveWorkspace(workspaceId: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (memberId: string) => api.removeMember(workspaceId, memberId),
    onSuccess: async () => {
      // NOTE: /dashboard redirects to the first workspace in the cached /v1/me, which
      // still lists this one until it is refetched.
      await queryClient.fetchQuery({ ...meQueryOptions(), staleTime: 0 });
      await navigate({ to: "/dashboard" });
      queryClient.removeQueries({ queryKey: queryKeys.workspace(workspaceId) });
    },
  });
}

/**
 * Reads pending invites.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Only managers may list invites.
 * @returns The invites query.
 */
export function useInvites(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.invites(workspaceId),
    queryFn: ({ signal }) => api.listInvites(workspaceId, signal),
    select: (data) => data.invites,
    enabled,
  });
}

/**
 * Creates an invite. The response carries the URL to share, since email is not wired yet.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking `{ email, role }`.
 */
export function useCreateInvite(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: Role }) => api.createInvite(workspaceId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invites(workspaceId) }),
  });
}

/**
 * Revokes a pending invite.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking the invite id.
 */
export function useRevokeInvite(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => api.revokeInvite(workspaceId, inviteId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.invites(workspaceId) }),
  });
}

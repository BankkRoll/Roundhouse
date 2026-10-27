/**
 * Queries and mutations for access control (ADR 0014): workspace access settings, the
 * caller's effective access, teams, project grants and environment protection.
 *
 * Every write can change what the caller may do, so each one also invalidates the
 * effective access the dashboard decides its controls from.
 *
 * @module
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "../lib/api/access-client";
import type {
  CreateTeamBody,
  PutEnvironmentProtectionBody,
  PutProjectGrantBody,
  UpdateTeamBody,
  WorkspaceAccessSettingsPatch,
} from "../lib/api/access-types";
import { queryKeys } from "./keys";

/**
 * Reads the caller's effective access in a workspace.
 *
 * @param workspaceId - Workspace id.
 * @returns The query.
 */
export function useEffectiveAccess(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.effectiveAccess(workspaceId),
    queryFn: ({ signal }) => accessApi.getEffectiveAccess(workspaceId, signal),
    staleTime: 30_000,
  });
}

/**
 * Reads the default project roles of members and viewers.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip the request when the caller can't read members.
 * @returns The query.
 */
export function useAccessSettings(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.accessSettings(workspaceId),
    queryFn: ({ signal }) => accessApi.getSettings(workspaceId, signal),
    enabled,
  });
}

/**
 * Changes the default project roles.
 *
 * @param workspaceId - Workspace id.
 * @returns The mutation.
 */
export function useUpdateAccessSettings(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: WorkspaceAccessSettingsPatch) =>
      accessApi.updateSettings(workspaceId, patch),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.accessSettings(workspaceId), settings);
      void queryClient.invalidateQueries({ queryKey: queryKeys.effectiveAccess(workspaceId) });
      // NOTE: Every project's access view shows the implied roles.
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "projects" && query.queryKey[2] === "access",
      });
    },
  });
}

/**
 * Lists the workspace's teams.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip the request when the caller can't read members.
 * @returns The query, selecting the teams.
 */
export function useTeams(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.teams(workspaceId),
    queryFn: ({ signal }) => accessApi.listTeams(workspaceId, signal),
    select: (data) => data.teams,
    enabled,
  });
}

/**
 * Reads one team with its members.
 *
 * @param teamId - Team id.
 * @param enabled - Skip the request when the caller can't read members.
 * @returns The query.
 */
export function useTeam(teamId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.team(teamId),
    queryFn: ({ signal }) => accessApi.getTeam(teamId, signal),
    enabled,
  });
}

/**
 * Reads several teams with their members, e.g. to work out who a team grant covers.
 *
 * @param teamIds - Team ids.
 * @param enabled - Skip the requests.
 * @returns One query per team, in order.
 */
export function useTeamDetails(teamIds: readonly string[], enabled = true) {
  return useQueries({
    queries: teamIds.map((teamId) => ({
      queryKey: queryKeys.team(teamId),
      queryFn: ({ signal }: { signal: AbortSignal }) => accessApi.getTeam(teamId, signal),
      enabled,
    })),
  });
}

function useInvalidateTeams(workspaceId: string) {
  const queryClient = useQueryClient();
  return (teamId?: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.teams(workspaceId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.effectiveAccess(workspaceId) }),
      teamId ? queryClient.invalidateQueries({ queryKey: queryKeys.team(teamId) }) : null,
    ]);
}

/**
 * Creates a team.
 *
 * @param workspaceId - Workspace id.
 * @returns The mutation, resolving to the new team.
 */
export function useCreateTeam(workspaceId: string) {
  const invalidate = useInvalidateTeams(workspaceId);
  return useMutation({
    mutationFn: (body: CreateTeamBody) => accessApi.createTeam(workspaceId, body),
    onSuccess: () => invalidate(),
  });
}

/**
 * Renames or re-describes a team.
 *
 * @param workspaceId - Workspace id.
 * @param teamId - Team id.
 * @returns The mutation.
 */
export function useUpdateTeam(workspaceId: string, teamId: string) {
  const invalidate = useInvalidateTeams(workspaceId);
  return useMutation({
    mutationFn: (body: UpdateTeamBody) => accessApi.updateTeam(teamId, body),
    onSuccess: () => invalidate(teamId),
  });
}

/**
 * Deletes a team.
 *
 * @param workspaceId - Workspace id.
 * @returns The mutation, taking the team id.
 */
export function useDeleteTeam(workspaceId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateTeams(workspaceId);
  return useMutation({
    mutationFn: (teamId: string) => accessApi.deleteTeam(teamId),
    onSuccess: (_, teamId) => {
      queryClient.removeQueries({ queryKey: queryKeys.team(teamId) });
      return invalidate();
    },
  });
}

/**
 * Replaces a team's members.
 *
 * @param workspaceId - Workspace id.
 * @param teamId - Team id.
 * @returns The mutation, taking the complete list of user ids.
 */
export function useSetTeamMembers(workspaceId: string, teamId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateTeams(workspaceId);
  return useMutation({
    mutationFn: (userIds: string[]) => accessApi.setTeamMembers(teamId, userIds),
    onSuccess: (team) => {
      queryClient.setQueryData(queryKeys.team(teamId), team);
      return invalidate();
    },
  });
}

/**
 * Reads a project's grants and implied roles.
 *
 * @param projectId - Project id.
 * @param enabled - Skip the request when the caller can't manage access.
 * @returns The query.
 */
export function useProjectAccess(projectId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.projectAccess(projectId),
    queryFn: ({ signal }) => accessApi.getProjectAccess(projectId, signal),
    enabled,
  });
}

/**
 * Reads the names behind a project's access settings, for callers who can read the
 * project but maybe not the workspace's members.
 *
 * @param projectId - Project id.
 * @returns The query.
 */
export function useProjectDirectory(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectDirectory(projectId),
    queryFn: ({ signal }) => accessApi.getProjectDirectory(projectId, signal),
  });
}

function useInvalidateProjectAccess(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.projectAccess(projectId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projectDirectory(projectId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.effectiveAccess(workspaceId) }),
    ]);
}

/**
 * Creates or changes a grant.
 *
 * @param workspaceId - Workspace id.
 * @param projectId - Project id.
 * @returns The mutation.
 */
export function usePutProjectGrant(workspaceId: string, projectId: string) {
  const invalidate = useInvalidateProjectAccess(workspaceId, projectId);
  return useMutation({
    mutationFn: (body: PutProjectGrantBody) => accessApi.putProjectGrant(projectId, body),
    onSuccess: () => invalidate(),
  });
}

/**
 * Revokes a grant.
 *
 * @param workspaceId - Workspace id.
 * @param projectId - Project id.
 * @returns The mutation, taking the grant id.
 */
export function useDeleteProjectGrant(workspaceId: string, projectId: string) {
  const invalidate = useInvalidateProjectAccess(workspaceId, projectId);
  return useMutation({
    mutationFn: (grantId: string) => accessApi.deleteProjectGrant(projectId, grantId),
    onSuccess: () => invalidate(),
  });
}

/**
 * Reads an environment's protection.
 *
 * @param environmentId - Environment id, or `undefined` while it is picked.
 * @returns The query.
 */
export function useProtection(environmentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.protection(environmentId ?? ""),
    queryFn: ({ signal }) => accessApi.getProtection(environmentId ?? "", signal),
    enabled: Boolean(environmentId),
  });
}

/**
 * Turns an environment's protection on or off and edits its rules.
 *
 * @param workspaceId - Workspace id.
 * @param projectId - Project the environment belongs to.
 * @param environmentId - Environment id.
 * @returns The mutation.
 */
export function usePutProtection(workspaceId: string, projectId: string, environmentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PutEnvironmentProtectionBody) =>
      accessApi.putProtection(environmentId, body),
    onSuccess: (protection) => {
      queryClient.setQueryData(queryKeys.protection(environmentId), protection);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projectDirectory(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.effectiveAccess(workspaceId) }),
        // NOTE: The project detail carries each environment's `protected` flag.
        queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId), exact: true }),
      ]);
    },
  });
}

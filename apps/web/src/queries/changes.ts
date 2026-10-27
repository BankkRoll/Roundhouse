/**
 * Queries and mutations for the project canvas and staged changes (ADR 0006), and how
 * their realtime frames update the cache.
 *
 * @module
 */
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { changesApi } from "../lib/api/changes-client";
import type { Canvas, CanvasPositions, ChangeSet, StagedOpInput } from "../lib/api/changes-types";
import type { RealtimeServerMessage } from "../lib/api/deploy-types";
import { queryKeys } from "./keys";
import { invalidateProjectSummaries } from "./projects";

/** Cache keys of this module. Canvas keys sit under the project, so project-wide invalidation reaches them. */
export const changeKeys = {
  /** Every canvas of a project, whatever the environment. */
  canvasAll: (projectId: string) => [...queryKeys.project(projectId), "canvas"] as const,
  canvas: (projectId: string, environmentId: string) =>
    [...queryKeys.project(projectId), "canvas", environmentId] as const,
  draft: (environmentId: string) => ["environments", environmentId, "draft"] as const,
  changeSet: (changeSetId: string) => ["change-sets", changeSetId] as const,
  review: (changeSetId: string) => ["change-sets", changeSetId, "review"] as const,
  /** Every workspace review queue; prefix of {@link changeKeys.workspaceQueue}. */
  workspaceQueueAll: () => ["change-sets", "workspace"] as const,
  workspaceQueue: (workspaceId: string, review: "open" | "pending") =>
    ["change-sets", "workspace", workspaceId, review] as const,
};

/**
 * Query options for an environment's canvas.
 *
 * @param projectId - Project id.
 * @param environmentId - Environment id.
 * @returns Options for `useQuery`.
 */
export function canvasQueryOptions(projectId: string, environmentId: string) {
  return queryOptions({
    queryKey: changeKeys.canvas(projectId, environmentId),
    queryFn: ({ signal }) => changesApi.getCanvas(projectId, environmentId, signal),
  });
}

/**
 * Reads the canvas of one environment.
 *
 * @param projectId - Project id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @returns The canvas query.
 */
export function useCanvas(projectId: string, environmentId: string | undefined) {
  return useQuery({
    ...canvasQueryOptions(projectId, environmentId ?? ""),
    enabled: Boolean(environmentId),
  });
}

/**
 * Reads the environment's shared draft.
 *
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @returns The draft query (`null` when nothing is staged).
 */
export function useDraft(environmentId: string | undefined) {
  return useQuery({
    queryKey: changeKeys.draft(environmentId ?? ""),
    queryFn: ({ signal }) => changesApi.getDraft(environmentId!, signal),
    select: (data) => data.change_set,
    enabled: Boolean(environmentId),
  });
}

/**
 * Reads a change set, for review links that name one.
 *
 * @param changeSetId - Change set id; the query waits while it is unknown.
 * @returns The change set query.
 */
export function useChangeSet(changeSetId: string | undefined) {
  return useQuery({
    queryKey: changeKeys.changeSet(changeSetId ?? ""),
    queryFn: ({ signal }) => changesApi.getChangeSet(changeSetId!, signal),
    enabled: Boolean(changeSetId),
  });
}

/**
 * Checks a set against the current state: rebases, conflicts and what would deploy.
 *
 * @param changeSetId - Change set id.
 * @param enabled - Whether the review panel is open.
 * @returns The review query.
 */
export function useReview(changeSetId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: changeKeys.review(changeSetId ?? ""),
    queryFn: ({ signal }) => changesApi.reviewChangeSet(changeSetId!, signal),
    enabled: Boolean(changeSetId) && enabled,
  });
}

/** Where a set lives, for cache updates. */
interface SetScope {
  projectId: string;
  environmentId: string;
}

function storeSet(queryClient: QueryClient, scope: SetScope, set: ChangeSet): void {
  queryClient.setQueryData(changeKeys.changeSet(set.id), set);
  if (set.is_draft) {
    queryClient.setQueryData(changeKeys.draft(scope.environmentId), {
      change_set: set.status === "open" || set.status === "applying" ? set : null,
    });
  }
  void queryClient.invalidateQueries({ queryKey: changeKeys.review(set.id) });
  void queryClient.invalidateQueries({
    queryKey: changeKeys.canvas(scope.projectId, scope.environmentId),
  });
}

/**
 * Stages an op into the environment's draft.
 *
 * @param scope - Project and environment.
 * @returns A mutation taking the op and, optionally, the revision it was made against.
 */
export function useStage(scope: SetScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ op, expectedRevision }: { op: StagedOpInput; expectedRevision?: number }) =>
      changesApi.stageDraftOp(scope.environmentId, op, expectedRevision),
    onSuccess: (set) => storeSet(queryClient, scope, set),
  });
}

/**
 * Removes one op from a set.
 *
 * @param scope - Project and environment.
 * @returns A mutation taking the set, op id and revision.
 */
export function useUnstage(scope: SetScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ setId, opId, revision }: { setId: string; opId: string; revision: number }) =>
      changesApi.unstage(setId, opId, revision),
    onSuccess: (set) => storeSet(queryClient, scope, set),
  });
}

/**
 * Settles a conflicted op.
 *
 * @param scope - Project and environment.
 * @returns A mutation taking the set, op id, side and revision.
 */
export function useResolve(scope: SetScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      setId: string;
      opId: string;
      keep: "mine" | "theirs";
      revision: number;
    }) => changesApi.resolve(input.setId, input.opId, input.keep, input.revision),
    onSuccess: (set) => storeSet(queryClient, scope, set),
  });
}

function refreshAfterApply(queryClient: QueryClient, scope: SetScope): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.project(scope.projectId) });
  void queryClient.invalidateQueries({ queryKey: ["services"] });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.sharedVariables(scope.projectId, scope.environmentId),
  });
  invalidateProjectSummaries(queryClient, scope.projectId);
}

/**
 * Applies a set exactly as reviewed, then refreshes everything it may have changed.
 *
 * @param scope - Project and environment.
 * @returns A mutation taking the set id, its reviewed revision and the deploy mode.
 */
export function useApply(scope: SetScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { setId: string; revision: number; deploy: "affected" | "none" }) =>
      changesApi.apply(input.setId, { expected_revision: input.revision, deploy: input.deploy }),
    onSuccess: ({ change_set }) => {
      storeSet(queryClient, scope, change_set);
      refreshAfterApply(queryClient, scope);
    },
    onError: (_, input) => {
      // NOTE: A refused apply may have marked conflicts or moved the revision on.
      void queryClient.invalidateQueries({ queryKey: changeKeys.changeSet(input.setId) });
      void queryClient.invalidateQueries({ queryKey: changeKeys.review(input.setId) });
      void queryClient.invalidateQueries({ queryKey: changeKeys.draft(scope.environmentId) });
    },
  });
}

/**
 * Throws a set away.
 *
 * @param scope - Project and environment.
 * @returns A mutation taking the set id and the revision the caller saw.
 */
export function useDiscard(scope: SetScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ setId, revision }: { setId: string; revision: number }) =>
      changesApi.discard(setId, revision),
    onSuccess: (set) => storeSet(queryClient, scope, set),
  });
}

/**
 * The workspace's open change sets: its review queue.
 *
 * @param workspaceId - Workspace id.
 * @param review - Every open set, or only those waiting for a reviewer.
 * @returns The queue query.
 */
export function useWorkspaceChangeSets(workspaceId: string, review: "open" | "pending" = "open") {
  return useQuery({
    queryKey: changeKeys.workspaceQueue(workspaceId, review),
    queryFn: ({ signal }) => changesApi.listWorkspaceChangeSets(workspaceId, review, signal),
    select: (data) => data.change_sets,
  });
}

/**
 * Asks for a review of a set.
 *
 * @param scope - Project and environment.
 * @returns A mutation taking the set id, the revision the caller saw and a note.
 */
export function useSubmit(scope: SetScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { setId: string; revision: number; note?: string }) =>
      changesApi.submit(input.setId, {
        expected_revision: input.revision,
        ...(input.note ? { note: input.note } : {}),
      }),
    onSuccess: (set) => {
      storeSet(queryClient, scope, set);
      void queryClient.invalidateQueries({ queryKey: changeKeys.workspaceQueueAll() });
    },
  });
}

/**
 * Approves or rejects the revision a reviewer looked at.
 *
 * @param scope - Project and environment.
 * @returns A mutation taking the set id, decision, reviewed revision and a note.
 */
export function useDecide(scope: SetScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      setId: string;
      decision: "approve" | "reject";
      revision: number;
      note?: string;
    }) =>
      changesApi.decide(input.setId, input.decision, {
        expected_revision: input.revision,
        ...(input.note ? { note: input.note } : {}),
      }),
    onSuccess: (set) => {
      storeSet(queryClient, scope, set);
      void queryClient.invalidateQueries({ queryKey: changeKeys.workspaceQueueAll() });
    },
    onError: (_, input) => {
      void queryClient.invalidateQueries({ queryKey: changeKeys.changeSet(input.setId) });
    },
  });
}

/**
 * Moves a stale set onto the current state.
 *
 * @param scope - Project and environment.
 * @returns A mutation taking the set id and the revision the caller saw.
 */
export function useRebase(scope: SetScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ setId, revision }: { setId: string; revision: number }) =>
      changesApi.rebase(setId, revision),
    onSuccess: (result) => storeSet(queryClient, scope, result.change_set),
  });
}

/**
 * Draws a "connects to" edge.
 *
 * @param projectId - Project id.
 * @returns A mutation taking both service ids.
 */
export function useAddEdge(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      changesApi.addEdge(projectId, from, to),
    onSettled: () => queryClient.invalidateQueries({ queryKey: changeKeys.canvasAll(projectId) }),
  });
}

/**
 * Removes a "connects to" edge.
 *
 * @param projectId - Project id.
 * @returns A mutation taking the edge id.
 */
export function useRemoveEdge(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (edgeId: string) => changesApi.removeEdge(projectId, edgeId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: changeKeys.canvasAll(projectId) }),
  });
}

/**
 * Persists canvas positions. A stale version refetches the canvas; the caller keeps
 * its local positions and retries on the next move.
 *
 * @param projectId - Project id.
 * @returns A mutation taking the moved positions and the version they start from.
 */
export function useUpdateLayout(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      positions: Record<string, { x: number; y: number } | null>;
      version: number;
    }) =>
      changesApi.updateLayout(projectId, {
        positions: input.positions,
        expected_version: input.version,
      }),
    onSuccess: (layout) => setLayout(queryClient, projectId, layout.positions, layout.version),
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: changeKeys.canvasAll(projectId) });
    },
  });
}

function setLayout(
  queryClient: QueryClient,
  projectId: string,
  positions: CanvasPositions,
  version: number,
): void {
  queryClient.setQueriesData<Canvas>({ queryKey: changeKeys.canvasAll(projectId) }, (canvas) =>
    canvas && canvas.layout_version < version
      ? { ...canvas, positions, layout_version: version }
      : canvas,
  );
}

/**
 * Applies a change set or canvas realtime frame to the cache.
 *
 * @param queryClient - Shared query client.
 * @param message - A validated server message.
 * @param projectId - The project whose socket sent it.
 * @returns Whether the message was one of this module's.
 */
export function applyChangeRealtime(
  queryClient: QueryClient,
  message: RealtimeServerMessage,
  projectId: string,
): boolean {
  switch (message.type) {
    case "change_set.updated": {
      const set = message.change_set;
      void queryClient.invalidateQueries({ queryKey: changeKeys.changeSet(set.id) });
      if (set.is_draft) {
        void queryClient.invalidateQueries({ queryKey: changeKeys.draft(set.environment_id) });
      }
      void queryClient.invalidateQueries({
        queryKey: changeKeys.canvas(set.project_id, set.environment_id),
      });
      void queryClient.invalidateQueries({ queryKey: changeKeys.review(set.id) });
      void queryClient.invalidateQueries({ queryKey: changeKeys.workspaceQueueAll() });
      return true;
    }
    case "change_set.applied":
      refreshAfterApply(queryClient, { projectId, environmentId: message.environment_id });
      return true;
    case "canvas.layout_updated":
      setLayout(queryClient, projectId, message.positions, message.version);
      return true;
    case "canvas.edges_updated":
      void queryClient.invalidateQueries({ queryKey: changeKeys.canvasAll(projectId) });
      return true;
    default:
      return false;
  }
}

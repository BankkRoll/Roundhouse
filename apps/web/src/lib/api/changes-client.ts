/**
 * Typed endpoint functions for the project canvas and staged changes (ADR 0006). Every
 * call goes through {@link request}, like `api`.
 *
 * @module
 */
import type {
  AppliedChangeSet,
  ApplyChangeSetBody,
  Canvas,
  CanvasLayout,
  ChangeSet,
  ChangeSetReview,
  ChangeSetSummary,
  StagedOpInput,
  UpdateCanvasLayoutBody,
} from "./changes-types";
import { request } from "./client";

const seg = encodeURIComponent;

/**
 * Canvas and change set endpoints.
 *
 * @example
 * const canvas = await changesApi.getCanvas("prj_1", "env_1");
 */
export const changesApi = {
  /**
   * Services, reference edges and positions of one environment, with its draft.
   *
   * @param projectId - Project id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns The canvas.
   */
  getCanvas: (projectId: string, environmentId: string, signal?: AbortSignal) =>
    request<Canvas>("GET", `/v1/projects/${seg(projectId)}/canvas`, {
      query: { environment_id: environmentId },
      signal,
    }),
  /**
   * Moves services on the canvas, guarded on the layout version.
   *
   * @param projectId - Project id.
   * @param body - Positions to merge and the version they start from.
   * @returns The stored layout.
   */
  updateLayout: (projectId: string, body: UpdateCanvasLayoutBody) =>
    request<CanvasLayout>("PATCH", `/v1/projects/${seg(projectId)}/canvas/layout`, { body }),
  /**
   * Lists an environment's change sets.
   *
   * @param environmentId - Environment id.
   * @param status - Open sets only (default), or every set.
   * @param signal - Abort signal.
   * @returns The sets, newest first.
   */
  listChangeSets: (environmentId: string, status: "open" | "all" = "open", signal?: AbortSignal) =>
    request<{ change_sets: ChangeSetSummary[] }>(
      "GET",
      `/v1/environments/${seg(environmentId)}/change-sets`,
      { query: { status }, signal },
    ),
  /**
   * Reads the environment's shared draft.
   *
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns The draft, or `null` when nothing is staged.
   */
  getDraft: (environmentId: string, signal?: AbortSignal) =>
    request<{ change_set: ChangeSet | null }>(
      "GET",
      `/v1/environments/${seg(environmentId)}/draft`,
      { signal },
    ),
  /**
   * Stages an op into the environment's draft, opening it if needed.
   *
   * @param environmentId - Environment id.
   * @param op - The op.
   * @param expectedRevision - Refuse with 409 unless the draft is still at this revision.
   * @returns The draft after the change.
   */
  stageDraftOp: (environmentId: string, op: StagedOpInput, expectedRevision?: number) =>
    request<ChangeSet>("POST", `/v1/environments/${seg(environmentId)}/draft/ops`, {
      body: {
        op,
        ...(expectedRevision !== undefined ? { expected_revision: expectedRevision } : {}),
      },
    }),
  /**
   * Reads a change set.
   *
   * @param changeSetId - Change set id.
   * @param signal - Abort signal.
   * @returns The set with its ops.
   */
  getChangeSet: (changeSetId: string, signal?: AbortSignal) =>
    request<ChangeSet>("GET", `/v1/change-sets/${seg(changeSetId)}`, { signal }),
  /**
   * Checks a set against the current state: rebases, conflicts and planned deploys.
   *
   * @param changeSetId - Change set id.
   * @param signal - Abort signal.
   * @returns The review.
   */
  reviewChangeSet: (changeSetId: string, signal?: AbortSignal) =>
    request<ChangeSetReview>("GET", `/v1/change-sets/${seg(changeSetId)}/diff`, { signal }),
  /**
   * Removes one op from a set.
   *
   * @param changeSetId - Change set id.
   * @param opId - Staged change id.
   * @param expectedRevision - The revision the caller saw.
   * @returns The set after the change.
   */
  unstage: (changeSetId: string, opId: string, expectedRevision?: number) =>
    request<ChangeSet>("DELETE", `/v1/change-sets/${seg(changeSetId)}/ops/${seg(opId)}`, {
      query: { expected_revision: expectedRevision?.toString() },
    }),
  /**
   * Settles a conflicted op.
   *
   * @param changeSetId - Change set id.
   * @param opId - Staged change id.
   * @param keep - `mine` rebases it, `theirs` drops it.
   * @param expectedRevision - The revision the caller reviewed.
   * @returns The set after the change.
   */
  resolve: (changeSetId: string, opId: string, keep: "mine" | "theirs", expectedRevision: number) =>
    request<ChangeSet>("POST", `/v1/change-sets/${seg(changeSetId)}/ops/${seg(opId)}/resolve`, {
      body: { keep, expected_revision: expectedRevision },
    }),
  /**
   * Applies a set exactly as reviewed.
   *
   * @param changeSetId - Change set id.
   * @param body - Reviewed revision and deploy mode.
   * @returns The applied set and the deployments it started.
   */
  apply: (changeSetId: string, body: ApplyChangeSetBody) =>
    request<AppliedChangeSet>("POST", `/v1/change-sets/${seg(changeSetId)}/apply`, { body }),
  /**
   * Throws a set away.
   *
   * @param changeSetId - Change set id.
   * @param expectedRevision - The revision the caller saw.
   * @returns The discarded set.
   */
  discard: (changeSetId: string, expectedRevision?: number) =>
    request<ChangeSet>("POST", `/v1/change-sets/${seg(changeSetId)}/discard`, {
      body: expectedRevision !== undefined ? { expected_revision: expectedRevision } : {},
    }),
};

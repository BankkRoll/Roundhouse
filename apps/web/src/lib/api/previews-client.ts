/**
 * Typed endpoint functions and wire types for pull request previews (ADR 0007): a
 * project's preview settings, its previews, and approving, redeploying and tearing one
 * down.
 *
 * Types come from the API's route contracts (`apps/api/src/contracts/previews.ts`).
 *
 * @module
 */
import type {
  BodyOf,
  Preview,
  PreviewSettings,
  putPreviewSettings,
} from "../../../../api/src/contracts";
import { request } from "./client";

export type { Preview, PreviewSettings };

/** `PUT /v1/projects/{projectId}/preview-settings` body. */
export type PreviewSettingsBody = BodyOf<typeof putPreviewSettings>;

/** Which previews to list: `open` hides closed and expired ones. */
export type PreviewListFilter = "open" | "all";

const seg = encodeURIComponent;

/** Preview endpoints. */
export const previewsApi = {
  /**
   * Reads a project's preview settings, or the defaults while none were saved.
   *
   * @param projectId - Project id.
   * @param signal - Abort signal.
   * @returns The settings.
   */
  getSettings: (projectId: string, signal?: AbortSignal) =>
    request<PreviewSettings>("GET", `/v1/projects/${seg(projectId)}/preview-settings`, {
      signal,
    }),
  /**
   * Saves a project's preview settings.
   *
   * @param projectId - Project id.
   * @param body - The whole settings object.
   * @returns The saved settings.
   */
  putSettings: (projectId: string, body: PreviewSettingsBody) =>
    request<PreviewSettings>("PUT", `/v1/projects/${seg(projectId)}/preview-settings`, { body }),
  /**
   * Lists a project's previews, newest PR activity first.
   *
   * @param projectId - Project id.
   * @param status - `open` (default) or `all`.
   * @param signal - Abort signal.
   * @returns The previews.
   */
  list: (projectId: string, status: PreviewListFilter = "open", signal?: AbortSignal) =>
    request<{ previews: Preview[] }>("GET", `/v1/projects/${seg(projectId)}/previews`, {
      query: { status },
      signal,
    }),
  /**
   * Reads one preview.
   *
   * @param previewId - Preview id.
   * @param signal - Abort signal.
   * @returns The preview.
   */
  get: (previewId: string, signal?: AbortSignal) =>
    request<Preview>("GET", `/v1/previews/${seg(previewId)}`, { signal }),
  /**
   * Approves a fork PR's head. 409 `head_moved` when the PR moved past `headSha`.
   *
   * @param previewId - Preview id.
   * @param headSha - The head the approver looked at.
   * @returns The preview after approval.
   */
  approve: (previewId: string, headSha: string) =>
    request<Preview>("POST", `/v1/previews/${seg(previewId)}/approve`, {
      body: { head_sha: headSha },
    }),
  /**
   * Deploys an active preview's git services again at the PR's head.
   *
   * @param previewId - Preview id.
   * @returns The preview.
   */
  redeploy: (previewId: string) =>
    request<Preview>("POST", `/v1/previews/${seg(previewId)}/redeploy`),
  /**
   * Tears a preview down; it becomes `closed`.
   *
   * @param previewId - Preview id.
   * @returns The closed preview.
   */
  remove: (previewId: string) => request<Preview>("DELETE", `/v1/previews/${seg(previewId)}`),
};

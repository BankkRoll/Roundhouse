/**
 * Pull request preview queries (ADR 0007): a project's preview settings and previews,
 * one preview for the in-environment banner, and approve, redeploy and tear down.
 *
 * @module
 */
import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type Preview,
  type PreviewListFilter,
  type PreviewSettingsBody,
  previewsApi,
} from "../lib/api/previews-client";
import { queryKeys } from "./keys";

/** How often the list refetches while a preview is being created. */
export const PREVIEW_POLL_MS = 5_000;

/** Query keys of previews; the project ones sit under the project key. */
export const previewKeys = {
  settings: (projectId: string) => ["projects", projectId, "preview-settings"] as const,
  /** Every preview list of a project, whatever the filter. */
  listAll: (projectId: string) => ["projects", projectId, "previews"] as const,
  list: (projectId: string, filter: PreviewListFilter) =>
    ["projects", projectId, "previews", filter] as const,
  preview: (previewId: string) => ["previews", previewId] as const,
};

/**
 * A project's preview settings.
 *
 * @param projectId - Project id.
 * @returns The settings query.
 */
export function usePreviewSettings(projectId: string) {
  return useQuery({
    queryKey: previewKeys.settings(projectId),
    queryFn: ({ signal }) => previewsApi.getSettings(projectId, signal),
  });
}

/**
 * Saves a project's preview settings.
 *
 * @param projectId - Project id.
 * @returns The mutation; it takes the whole settings body.
 */
export function useSavePreviewSettings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PreviewSettingsBody) => previewsApi.putSettings(projectId, body),
    onSuccess: (settings) => queryClient.setQueryData(previewKeys.settings(projectId), settings),
  });
}

/**
 * A project's previews. Refetches every {@link PREVIEW_POLL_MS} while one is being
 * created, since nothing pushes preview changes over the realtime socket.
 *
 * @param projectId - Project id.
 * @param filter - `open` or `all`.
 * @returns The previews query.
 */
export function usePreviews(projectId: string, filter: PreviewListFilter) {
  return useQuery({
    queryKey: previewKeys.list(projectId, filter),
    queryFn: ({ signal }) => previewsApi.list(projectId, filter, signal),
    select: (data) => data.previews,
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.previews.some((preview) => preview.status === "creating")
        ? PREVIEW_POLL_MS
        : false,
  });
}

/**
 * One preview, for the banner inside its environment.
 *
 * @param previewId - Preview id, or `null` outside a preview environment.
 * @returns The preview query; idle without an id.
 */
export function usePreview(previewId: string | null | undefined) {
  return useQuery({
    queryKey: previewKeys.preview(previewId ?? ""),
    queryFn: ({ signal }) => previewsApi.get(previewId!, signal),
    enabled: Boolean(previewId),
  });
}

function refresh(queryClient: QueryClient, projectId: string, preview?: Preview) {
  if (preview) queryClient.setQueryData(previewKeys.preview(preview.id), preview);
  void queryClient.invalidateQueries({ queryKey: previewKeys.listAll(projectId) });
}

/**
 * Approves a fork PR's head as shown. On 409 `head_moved` the caller should refetch so
 * the new head is the one reviewed.
 *
 * @param projectId - Project of the previews.
 * @returns The mutation; it takes the preview id and the head SHA on screen.
 */
export function useApprovePreview(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ previewId, headSha }: { previewId: string; headSha: string }) =>
      previewsApi.approve(previewId, headSha),
    onSuccess: (preview) => refresh(queryClient, projectId, preview),
  });
}

/**
 * Deploys an active preview again at the PR's head.
 *
 * @param projectId - Project of the previews.
 * @returns The mutation; it takes the preview id.
 */
export function useRedeployPreview(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (previewId: string) => previewsApi.redeploy(previewId),
    onSuccess: (preview) => refresh(queryClient, projectId, preview),
  });
}

/**
 * Tears a preview down. Its environment goes, so the project is refetched too.
 *
 * @param projectId - Project of the previews.
 * @returns The mutation; it takes the preview id.
 */
export function useDeletePreview(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (previewId: string) => previewsApi.remove(previewId),
    onSuccess: (preview) => {
      refresh(queryClient, projectId, preview);
      void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId), exact: true });
    },
  });
}

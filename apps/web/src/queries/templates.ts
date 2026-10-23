/**
 * Queries and mutations for templates: the gallery, one template's detail, and deploying
 * a template into a new or existing project.
 *
 * @module
 */
import {
  type QueryClient,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { templatesApi } from "../lib/api/templates-client";
import type {
  CreateProjectFromTemplateBody,
  DeployTemplateBody,
  TemplateDeployment,
  TemplateDetail,
} from "../lib/api/templates-types";
import { queryKeys } from "./keys";

/**
 * Reads the template gallery.
 *
 * @param workspaceId - Workspace id.
 * @returns The templates query (data is the summary array, in gallery order).
 */
export function useTemplates(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.templates(workspaceId),
    queryFn: ({ signal }) => templatesApi.list(workspaceId, signal),
    select: (data) => data.templates,
    // NOTE: The catalogue is built into the control plane and only changes on upgrade.
    staleTime: 5 * 60_000,
  });
}

function templateQuery(workspaceId: string, templateId: string) {
  return {
    queryKey: queryKeys.template(workspaceId, templateId),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      templatesApi.get(workspaceId, templateId, signal),
    staleTime: 5 * 60_000,
  };
}

/**
 * Reads one template with its deploy form.
 *
 * @param workspaceId - Workspace id.
 * @param templateId - Template id.
 * @returns The template query.
 */
export function useTemplate(workspaceId: string, templateId: string) {
  return useQuery(templateQuery(workspaceId, templateId));
}

/**
 * Reads several templates' details at once, e.g. for the gallery's source hints. Shares
 * the cache with {@link useTemplate}, so opening one afterwards is instant.
 *
 * @param workspaceId - Workspace id.
 * @param templateIds - Template ids.
 * @returns Details by template id; templates still loading (or failed) are absent.
 */
export function useTemplateDetails(
  workspaceId: string,
  templateIds: readonly string[],
): ReadonlyMap<string, TemplateDetail> {
  return useQueries({
    queries: templateIds.map((id) => templateQuery(workspaceId, id)),
    combine: (results) =>
      new Map(results.flatMap((result) => (result.data ? [[result.data.id, result.data]] : []))),
  });
}

function refreshProject(
  queryClient: QueryClient,
  workspaceId: string,
  result: TemplateDeployment,
): void {
  // NOTE: Not exact: the summaries key sits under the projects key, so both refresh.
  void queryClient.invalidateQueries({ queryKey: queryKeys.projects(workspaceId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.project(result.project.id) });
}

/**
 * Creates a project from a template, then refreshes the project lists and summaries.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking the request body.
 */
export function useCreateProjectFromTemplate(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectFromTemplateBody) =>
      templatesApi.createProject(workspaceId, body),
    // SECURITY: The body can carry secret input values; drop the settled mutation (and
    // its variables) from the cache as soon as nothing observes it.
    gcTime: 0,
    onSuccess: (result) => refreshProject(queryClient, workspaceId, result),
  });
}

/**
 * Deploys a template into an existing project, then refreshes that project and the
 * workspace's summaries.
 *
 * @param workspaceId - Workspace the project belongs to.
 * @returns A mutation taking the project id and the request body.
 */
export function useDeployTemplate(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: DeployTemplateBody }) =>
      templatesApi.deploy(projectId, body),
    // SECURITY: As in useCreateProjectFromTemplate: never keep secret inputs cached.
    gcTime: 0,
    onSuccess: (result) => refreshProject(queryClient, workspaceId, result),
  });
}

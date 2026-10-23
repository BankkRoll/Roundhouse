/**
 * Typed endpoint functions for templates: the built-in gallery, one template's deploy
 * form, and deploying a template into a new or existing project. Every call goes through
 * {@link request}, like `api`.
 *
 * @module
 */
import { request } from "./client";
import type {
  CreateProjectFromTemplateBody,
  DeployTemplateBody,
  TemplateDeployment,
  TemplateDetail,
  TemplateSummary,
} from "./templates-types";

const seg = encodeURIComponent;

/**
 * Template endpoints, one per route in `TEMPLATE_ROUTES`.
 *
 * @example
 * const { templates } = await templatesApi.list("ws_123");
 */
export const templatesApi = {
  /**
   * Lists the built-in templates in gallery order.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns Every template's summary.
   */
  list: (workspaceId: string, signal?: AbortSignal) =>
    request<{ templates: TemplateSummary[] }>(
      "GET",
      `/v1/workspaces/${seg(workspaceId)}/templates`,
      { signal },
    ),
  /**
   * Reads one template with its inputs, services and variables. Secret values are never
   * returned.
   *
   * @param workspaceId - Workspace id.
   * @param templateId - Template id, e.g. `fastapi`.
   * @param signal - Abort signal.
   * @returns The template's detail view.
   */
  get: (workspaceId: string, templateId: string, signal?: AbortSignal) =>
    request<TemplateDetail>(
      "GET",
      `/v1/workspaces/${seg(workspaceId)}/templates/${seg(templateId)}`,
      { signal },
    ),
  /**
   * Creates a project with a `production` environment from a template. 400
   * `confirmation_required` when it sets write-only variables without
   * `confirm_write_only`; 409 when the template is unsupported.
   *
   * @param workspaceId - Workspace id.
   * @param body - Template, project name and deploy options.
   * @returns What was created, including first deployments and any that failed to start.
   */
  createProject: (workspaceId: string, body: CreateProjectFromTemplateBody) =>
    request<TemplateDeployment>(
      "POST",
      `/v1/workspaces/${seg(workspaceId)}/projects/from-template`,
      { body },
    ),
  /**
   * Adds a template's services to an existing project; variables and first deployments go
   * to `environment_id`.
   *
   * @param projectId - Project id.
   * @param body - Template, target environment and deploy options.
   * @returns What was created.
   */
  deploy: (projectId: string, body: DeployTemplateBody) =>
    request<TemplateDeployment>("POST", `/v1/projects/${seg(projectId)}/templates/deploy`, {
      body,
    }),
};

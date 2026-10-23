/**
 * Template routes (ADR 0012 section 2): the built-in gallery, and deploying a
 * template into a new project or an existing one.
 *
 * Deploying creates every service, its config in every environment and its
 * variables in the target environment in one D1 batch, then optionally
 * starts first deployments. Generated and secret variables are write-only, so
 * the body must carry `confirm_write_only` when the template sets any.
 *
 * NOTE: ADR 0012 has templates render into a reviewed change set (ADR 0006).
 * Change sets don't exist yet, so deploying applies directly with the same
 * checks a person creating the services and variables by hand would face.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { errors, json, sessionAuth, WorkspaceParams } from "../schemas";
import {
  CreateProjectFromTemplateBody,
  DeployTemplateBody,
  TemplateDeploymentSchema,
  TemplateDetailSchema,
  TemplateParams,
  TemplateSummarySchema,
} from "../schemas/templates";
import { ProjectParams } from "./params";
import { defineRoute, session } from "./policy";

/** Audit actions a template deploy records, besides `project.created` for a new project. */
const DEPLOY_AUDIT = ["service.created", "deployment.created", "template.deployed"] as const;

/** Lists the built-in templates, in gallery order. */
export const listTemplates = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/templates",
  tags: ["templates"],
  summary: "List templates",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: {
    200: json(z.object({ templates: z.array(TemplateSummarySchema) })),
    ...errors(401, 403, 404),
  },
});

/** One template with its inputs, services and variables (secret values never included). */
export const getTemplate = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/templates/{templateId}",
  tags: ["templates"],
  summary: "Get a template",
  security: sessionAuth,
  request: { params: TemplateParams },
  responses: { 200: json(TemplateDetailSchema), ...errors(400, 401, 403, 404) },
});

/**
 * Creates a project with a `production` environment from a template. Needs
 * `projects:create`, plus `services:manage` and `variables:manage` (and
 * `deployments:create` when `deploy`) as a new project would grant them.
 * 409 when the template needs something this control plane lacks.
 */
export const createProjectFromTemplate = defineRoute(
  session("projects:create", ["project.created", ...DEPLOY_AUDIT]),
  {
    method: "post",
    path: "/v1/workspaces/{workspaceId}/projects/from-template",
    tags: ["templates"],
    summary: "Create a project from a template",
    security: sessionAuth,
    request: {
      params: WorkspaceParams,
      body: {
        required: true,
        content: { "application/json": { schema: CreateProjectFromTemplateBody } },
      },
    },
    responses: {
      201: json(TemplateDeploymentSchema, "Created"),
      ...errors(400, 401, 403, 404, 409),
    },
  },
);

/**
 * Adds a template's services to an existing project. Variables and first
 * deployments go to `environment_id`, whose protection applies; slugs taken
 * in the project are suffixed -2, -3, … and references follow them.
 */
export const deployTemplate = defineRoute(session("services:manage", DEPLOY_AUDIT), {
  method: "post",
  path: "/v1/projects/{projectId}/templates/deploy",
  tags: ["templates"],
  summary: "Deploy a template into a project",
  security: sessionAuth,
  request: {
    params: ProjectParams,
    body: { required: true, content: { "application/json": { schema: DeployTemplateBody } } },
  },
  responses: {
    201: json(TemplateDeploymentSchema, "Created"),
    ...errors(400, 401, 403, 404, 409),
  },
});

/** Every template route, by name. */
export const TEMPLATE_ROUTES = {
  listTemplates,
  getTemplate,
  createProjectFromTemplate,
  deployTemplate,
} as const;

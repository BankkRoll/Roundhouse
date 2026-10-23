/**
 * MCP tools for templates: `list_templates` (read-only) and
 * `deploy_template`, which calls the same `deployTemplateIntoProject` as
 * `POST /v1/projects/{projectId}/templates/deploy`, so RBAC (environment
 * protection included), the write-only confirmation and the audit records
 * are the REST route's, plus `via: "mcp"` and the tool name.
 *
 * `deploy_template` only adds services to an existing project; creating
 * projects stays a dashboard, CLI or REST action.
 *
 * @module
 */
import type { ApiTokenScope } from "@roundhouse/shared";
import { z } from "zod";
import { requireKeys, requireWorkspace } from "../context";
import { policyOf } from "../contracts/policy";
import {
  deployTemplate as deployTemplateRoute,
  listTemplates as listTemplatesRoute,
} from "../contracts/templates";
import { environmentOf, projectScope } from "../lib/scope";
import { BUILT_IN_TEMPLATES } from "../lib/template-catalogue";
import { deployTemplateIntoProject, findTemplate, toTemplateDetail } from "../lib/templates";
import type { McpTool } from "./tools";

const scopeOf = (route: Parameters<typeof policyOf>[0]) => policyOf(route).action as ApiTokenScope;

const Id = (what: string) => z.string().min(1).max(128).describe(`${what} ID`);

const ListTemplatesInput = z.object({
  workspace_id: Id("Workspace").optional().describe("Defaults to the token's workspace."),
});

/** `list_templates`: the built-in gallery with each template's deploy form. */
export const listTemplatesTool: McpTool<typeof ListTemplatesInput> = {
  name: "list_templates",
  title: "List templates",
  description:
    "Lists the built-in templates (starters, static sites, tools) with the services each " +
    "creates, its inputs, and the variables it sets. Secret and generated variables are " +
    "listed by key only. Templates with supported: false need features this control plane " +
    "lacks. Deploy one into a project with deploy_template.",
  input: ListTemplatesInput,
  scopes: [scopeOf(listTemplatesRoute)],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run({ c, token }, input) {
    const workspaceId = input.workspace_id ?? token.workspaceId;
    await requireWorkspace(c, workspaceId, policyOf(listTemplatesRoute).action!);
    return { templates: BUILT_IN_TEMPLATES.map(toTemplateDetail) };
  },
};

const DeployTemplateInput = z.object({
  template_id: z.string().min(1).max(40).describe("Template ID from list_templates."),
  project_id: Id("Project"),
  environment_id: Id("Environment").describe(
    "Environment (from get_project) that gets the variables and first deployments.",
  ),
  inputs: z
    .record(z.string().max(256), z.string().max(32 * 1024))
    .default({})
    .describe("Values for the template's inputs, by key."),
  deploy: z
    .boolean()
    .default(false)
    .describe("Start a first deployment of every created service; needs deployments:create."),
  confirm_write_only: z
    .boolean()
    .default(false)
    .describe("Confirms that generated and secret variables can never be read back."),
  acknowledge_public: z
    .array(z.string().max(256))
    .max(64)
    .default([])
    .describe("Public-prefix keys to store even though their values look like credentials."),
});

/** `deploy_template`: adds a template's services to an existing project. */
export const deployTemplateTool: McpTool<typeof DeployTemplateInput> = {
  name: "deploy_template",
  title: "Deploy a template",
  description:
    "Adds a template's services to an existing project: config in every environment, " +
    "variables in environment_id (generated secrets are minted server-side and are " +
    "write-only), and, with deploy, first deployments. Taken service slugs are suffixed " +
    "-2, -3, … and references follow. Refused without confirm_write_only when the template " +
    "sets secrets. Protected environments may refuse. Returns what was created, never a " +
    "secret value.",
  input: DeployTemplateInput,
  scopes: [scopeOf(deployTemplateRoute), "variables:manage"],
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run(ctx, input) {
    const { c, tool, token } = ctx;
    const { project, caller } = await projectScope(
      c,
      input.project_id,
      policyOf(deployTemplateRoute).action!,
      input.environment_id,
    );
    const environment = await environmentOf(c, project.id, input.environment_id);
    const result = await deployTemplateIntoProject(
      c,
      caller,
      requireKeys(c),
      findTemplate(input.template_id),
      project,
      environment,
      {
        inputs: input.inputs,
        deploy: input.deploy,
        confirmWriteOnly: input.confirm_write_only,
        acknowledgePublic: input.acknowledge_public,
        auditMetadata: {
          via: "mcp",
          tool,
          ...(token.oauth ? { oauth_client_id: token.oauth.clientId } : {}),
        },
      },
    );
    return result;
  },
};

/**
 * Template routes: the built-in gallery and deploying a template. Contracts
 * live in `../contracts/templates`; the work is in `../lib/templates`, shared
 * with the MCP `deploy_template` tool.
 *
 * @module
 */
import { createRouter, requireKeys, requireWorkspace } from "../context";
import { policyOf } from "../contracts/policy";
import {
  createProjectFromTemplate,
  deployTemplate,
  getTemplate,
  listTemplates,
} from "../contracts/templates";
import { environmentOf, projectScope } from "../lib/scope";
import { BUILT_IN_TEMPLATES } from "../lib/template-catalogue";
import {
  createProjectFromTemplate as createFromTemplate,
  deployTemplateIntoProject,
  findTemplate,
  toTemplateDetail,
  toTemplateSummary,
} from "../lib/templates";

/** Template routes. */
export const templateRoutes = createRouter()
  .openapi(listTemplates, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, policyOf(listTemplates).action!);
    return c.json({ templates: BUILT_IN_TEMPLATES.map(toTemplateSummary) }, 200);
  })
  .openapi(getTemplate, async (c) => {
    const { workspaceId, templateId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, policyOf(getTemplate).action!);
    return c.json(toTemplateDetail(findTemplate(templateId)), 200);
  })
  .openapi(createProjectFromTemplate, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const caller = await requireWorkspace(
      c,
      workspaceId,
      policyOf(createProjectFromTemplate).action!,
    );
    const keys = requireKeys(c);
    const result = await createFromTemplate(
      c,
      caller,
      keys,
      findTemplate(body.template_id),
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      },
      {
        inputs: body.inputs,
        deploy: body.deploy,
        confirmWriteOnly: body.confirm_write_only,
        acknowledgePublic: body.acknowledge_public,
      },
    );
    return c.json(result, 201);
  })
  .openapi(deployTemplate, async (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { project, caller } = await projectScope(
      c,
      projectId,
      policyOf(deployTemplate).action!,
      body.environment_id,
    );
    const environment = await environmentOf(c, project.id, body.environment_id);
    const result = await deployTemplateIntoProject(
      c,
      caller,
      requireKeys(c),
      findTemplate(body.template_id),
      project,
      environment,
      {
        inputs: body.inputs,
        deploy: body.deploy,
        confirmWriteOnly: body.confirm_write_only,
        acknowledgePublic: body.acknowledge_public,
      },
    );
    return c.json(result, 201);
  });

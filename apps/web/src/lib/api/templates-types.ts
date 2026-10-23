/**
 * Wire types for the template routes (the gallery and deploying a template into a new or
 * existing project), derived from the API's route definitions
 * (`apps/api/src/contracts/templates.ts`) so the dashboard cannot drift from them.
 *
 * Type-only: nothing from the API source reaches the bundle.
 *
 * @module
 */
import type {
  BodyOf,
  createProjectFromTemplate,
  deployTemplate,
  getTemplate,
  listTemplates,
  ResponseOf,
} from "../../../../api/src/contracts";

/** A template as the gallery lists it. */
export type TemplateSummary = ResponseOf<typeof listTemplates, 200>["templates"][number];
/** A gallery grouping such as `starter` or `monitoring`. */
export type TemplateCategory = TemplateSummary["category"];
/** A platform feature a template needs beyond plain services. */
export type TemplateRequirement = TemplateSummary["requirements"][number];
/** One template with its inputs, services and variables. Secret values are never included. */
export type TemplateDetail = ResponseOf<typeof getTemplate, 200>;
/** A value the deployer supplies. */
export type TemplateInput = TemplateDetail["inputs"][number];
/** One service a template creates. */
export type TemplateService = TemplateDetail["services"][number];
/** Where a template service's code comes from. */
export type TemplateSource = TemplateService["source"];
/** A variable a template sets; `value` is `null` for secret ones. */
export type TemplateVariable = TemplateService["variables"][number];
/** `POST /v1/workspaces/{workspaceId}/projects/from-template` body. */
export type CreateProjectFromTemplateBody = BodyOf<typeof createProjectFromTemplate>;
/** `POST /v1/projects/{projectId}/templates/deploy` body. */
export type DeployTemplateBody = BodyOf<typeof deployTemplate>;
/** What deploying a template created. */
export type TemplateDeployment = ResponseOf<typeof createProjectFromTemplate, 201>;

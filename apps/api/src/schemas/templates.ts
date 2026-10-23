/**
 * Template schemas: the gallery views of a template (summary and detail),
 * and the bodies and result of deploying one into a new or existing project.
 *
 * The views are a stable projection of the manifest (`@roundhouse/shared/template`),
 * not the manifest itself, so the manifest format can grow without changing
 * the API. Secret and generated variables are listed by key only: their
 * values are minted or entered at deploy time and never returned.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { SERVICE_KINDS } from "@roundhouse/shared";
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_DATABASE_ENGINES,
  TEMPLATE_INPUT_TYPES,
  TEMPLATE_REQUIREMENTS,
} from "@roundhouse/shared/template";
import {
  DeploymentSchema,
  EnvironmentSchema,
  NameField,
  ProjectSchema,
  ServiceSchema,
  SlugField,
} from "../schemas";
import { VariableWarningSchema } from "./variables";

/** A template ID, slug-shaped. */
export const TemplateIdField = SlugField.openapi({ example: "fastapi" });

/** `{workspaceId}` and `{templateId}` path params. */
export const TemplateParams = z.object({ workspaceId: z.string(), templateId: TemplateIdField });

/** A template as the gallery lists it. */
export const TemplateSummarySchema = z
  .object({
    id: z.string(),
    /** Bumped whenever the template changes. */
    version: z.number().int().positive(),
    name: z.string(),
    description: z.string(),
    /** `builtin:<name>` for an icon the dashboard ships, or an https URL. */
    icon: z.string().nullable(),
    category: z.enum(TEMPLATE_CATEGORIES),
    tags: z.array(z.string()),
    docs_url: z.string().nullable(),
    service_count: z.number().int().positive(),
    /** Platform features the template needs beyond plain services. */
    requirements: z.array(z.enum(TEMPLATE_REQUIREMENTS)),
    /** `false` when this control plane lacks a requirement; deploying then answers 409. */
    supported: z.boolean(),
  })
  .openapi("TemplateSummary");

/** A value the deployer supplies. */
export const TemplateInputSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    description: z.string().nullable(),
    type: z.enum(TEMPLATE_INPUT_TYPES),
    required: z.boolean(),
    /** Used when the input is left empty. Never set for `secret` inputs. */
    default: z.string().nullable(),
    /** Choices of a `select` input. */
    options: z.array(z.string()).nullable(),
  })
  .openapi("TemplateInput");

/** A variable a template sets. */
export const TemplateVariableSchema = z
  .object({
    key: z.string(),
    /** Stored write-only: generated, marked secret, or filled from a secret input. */
    secret: z.boolean(),
    /** Minted fresh on every deploy. */
    generated: z.boolean(),
    /**
     * The value as written, references and `${{input.KEY}}` included; `null`
     * for secret variables.
     */
    value: z.string().nullable(),
    description: z.string().nullable(),
  })
  .openapi("TemplateVariable");

/** Where a template service's code comes from. */
export const TemplateSourceSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("image"), image: z.string() }),
    z.object({
      type: z.literal("git"),
      repo_url: z.string(),
      branch: z.string(),
      root_dir: z.string(),
    }),
    z.object({
      type: z.literal("database"),
      engine: z.enum(TEMPLATE_DATABASE_ENGINES),
      version: z.string().nullable(),
    }),
  ])
  .openapi("TemplateSource");

/** One service a template creates. */
export const TemplateServiceSchema = z
  .object({
    /** Default slug; suffixed -2, -3, … when taken in the target project. */
    ref: z.string(),
    name: z.string(),
    kind: z.enum(SERVICE_KINDS),
    icon: z.string().nullable(),
    source: TemplateSourceSchema,
    /** Port the service listens on (`PORT`), or `null` for no listener. */
    port: z.number().int().nullable(),
    /** Whether it gets a public generated hostname. */
    public: z.boolean(),
    start_command: z.string().nullable(),
    variables: z.array(TemplateVariableSchema),
  })
  .openapi("TemplateService");

/** A template with everything the deploy form needs. */
export const TemplateDetailSchema = TemplateSummarySchema.extend({
  inputs: z.array(TemplateInputSchema),
  services: z.array(TemplateServiceSchema),
  shared_variables: z.array(TemplateVariableSchema),
}).openapi("TemplateDetail");

const InputsField = z
  .record(z.string().max(256), z.string().max(32 * 1024))
  .default({})
  .openapi({ description: "Values for the template's inputs, by key." });

const DeployOptions = {
  inputs: InputsField,
  /** Start a deployment of every created service. */
  deploy: z.boolean().default(true),
  /**
   * Confirms that generated and secret variables become write-only. Required
   * when the template sets any; 400 `confirmation_required` otherwise.
   */
  confirm_write_only: z.boolean().default(false),
  /** Public-prefix keys to store even though their values look like credentials. */
  acknowledge_public: z.array(z.string().max(256)).max(64).default([]),
};

/** Body of `POST /v1/workspaces/{workspaceId}/projects/from-template`. */
export const CreateProjectFromTemplateBody = z
  .object({
    template_id: TemplateIdField,
    /** Project name; the template's name when omitted. */
    name: NameField.optional(),
    /** Derived from the name when omitted; suffixed with -2, -3, … when taken. */
    slug: SlugField.optional(),
    description: z.string().trim().max(500).optional(),
    ...DeployOptions,
  })
  .openapi("CreateProjectFromTemplate");

/** Body of `POST /v1/projects/{projectId}/templates/deploy`. */
export const DeployTemplateBody = z
  .object({
    template_id: TemplateIdField,
    /** Environment that gets the template's variables and first deployments. */
    environment_id: z.string(),
    ...DeployOptions,
  })
  .openapi("DeployTemplate");

/** What deploying a template created. */
export const TemplateDeploymentSchema = z
  .object({
    template: z.object({ id: z.string(), version: z.number().int().positive() }),
    project: ProjectSchema,
    environment: EnvironmentSchema,
    /** Created services, in template order. */
    services: z.array(ServiceSchema),
    /** First deployments that started; empty when `deploy` was false. */
    deployments: z.array(DeploymentSchema),
    /** Services whose first deployment could not start, and why. They exist regardless. */
    deploy_errors: z.array(z.object({ service_id: z.string(), message: z.string() })),
    /** Variable classifier warnings, as a variables write returns them. */
    warnings: z.array(VariableWarningSchema),
  })
  .openapi("TemplateDeployment");

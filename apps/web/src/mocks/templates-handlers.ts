/**
 * MSW handlers for the template routes (`TEMPLATE_ROUTES` in
 * `apps/api/src/contracts/templates.ts`) against the in-memory {@link db} and the
 * catalogue in `./templates-db`. `contract.test.ts` validates every response against the
 * API's schemas.
 *
 * Requests are validated with the routes' own zod schemas first (400), then the API's
 * order: 401 without a session, 404 for non-members or a missing project, environment or
 * template, 403 when the role lacks an action, 409 for unsupported templates, then input
 * problems and the write-only confirmation (400). Deploying writes the services, configs
 * and variables the API would, starts first deployments, and records the same audit
 * entries.
 *
 * @module
 */
import {
  type Action,
  classifyVariable,
  decideVariableTier,
  freeSlug,
  slugify,
} from "@roundhouse/shared";
import {
  type RenderedTemplate,
  type RenderedVariable,
  renderTemplate,
  type Template,
  TemplateInputError,
  templateRequirements,
} from "@roundhouse/shared/template";
import { HttpResponse, http } from "msw";
import { policyOf, TEMPLATE_ROUTES } from "../../../api/src/contracts";
import type {
  Deployment,
  Environment,
  Project,
  Service,
  ServiceConfig,
} from "../lib/api/deploy-types";
import type { TemplateDeployment } from "../lib/api/templates-types";
import {
  apiError,
  currentUser,
  invalid,
  notFound,
  recordAudit,
  requireWorkspace,
  unauthorized,
} from "./common";
import { db, nextId } from "./db";
import type { DbVariable } from "./deploy-db";
import {
  announceDeployment,
  broadcastRealtime,
  createConfigs,
  ensureGeneratedDomain,
  startDeployment,
} from "./deploy-handlers";
import {
  findMockTemplate,
  MOCK_TEMPLATES,
  SUPPORTED_REQUIREMENTS,
  toDetail,
  toSummary,
} from "./templates-db";

// -----------------------------------------------------------------------------
// Validation with the contract's schemas
// -----------------------------------------------------------------------------

type RouteName = keyof typeof TEMPLATE_ROUTES;

interface Schema {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

interface RouteRequest {
  params?: Schema;
  body?: { content: { "application/json": { schema: Schema } } };
}

function issueResponse(issues: { path: PropertyKey[]; message: string }[]): Response {
  const issue = issues[0];
  const where = issue?.path.length ? `${issue.path.map(String).join(".")}: ` : "";
  return invalid(`${where}${issue?.message ?? "invalid"}`);
}

/** Validates params, then the JSON body, as `@hono/zod-openapi` does before any handler. */
async function validate<B = Record<string, never>>(
  name: RouteName,
  request: Request,
  params: Record<string, string | readonly string[] | undefined>,
): Promise<
  { ok: true; params: Record<string, string>; body: B } | { ok: false; response: Response }
> {
  const spec = (TEMPLATE_ROUTES[name] as { request?: RouteRequest }).request ?? {};
  const parsedParams = spec.params?.safeParse(params);
  if (parsedParams && !parsedParams.success) {
    return { ok: false, response: issueResponse(parsedParams.error.issues) };
  }
  let body: unknown = {};
  const bodySchema = spec.body?.content["application/json"].schema;
  if (bodySchema) {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return { ok: false, response: invalid("Malformed JSON in request body") };
    }
    const result = bodySchema.safeParse(raw);
    if (!result.success) return { ok: false, response: issueResponse(result.error.issues) };
    body = result.data;
  }
  return {
    ok: true,
    params: (parsedParams?.data ?? params) as Record<string, string>,
    body: body as B,
  };
}

function actionOf(name: RouteName): Action {
  return policyOf(TEMPLATE_ROUTES[name]).action as Action;
}

function mswPath(name: RouteName): string {
  return `*${TEMPLATE_ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;
}

// -----------------------------------------------------------------------------
// Deploying
// -----------------------------------------------------------------------------

/** Options shared by both deploy bodies, defaults applied by the schema. */
interface DeployOptions {
  template_id: string;
  inputs: Record<string, string>;
  deploy: boolean;
  confirm_write_only: boolean;
  acknowledge_public: string[];
}

const forbidden = (action: string) =>
  apiError(403, "forbidden", `Deploying this template needs ${action}, which you lack here`);

function unsupported(template: Template): Response | null {
  const missing = templateRequirements(template).filter((r) => !SUPPORTED_REQUIREMENTS.includes(r));
  if (!missing.length) return null;
  return apiError(
    409,
    "conflict",
    `${template.name} needs ${missing.join(" and ")}, which this control plane doesn't support yet`,
  );
}

/** Mirrors `assertDeployAccess`: the actions a deploy needs beyond the route's own. */
function deployAccess(workspaceId: string, deploy: boolean): Response | null {
  const needed: Action[] = ["services:manage", "variables:manage"];
  if (deploy) needed.push("deployments:create");
  for (const action of needed) {
    if (!requireWorkspace(workspaceId, action).ok) return forbidden(action);
  }
  return null;
}

function render(
  template: Template,
  inputs: Record<string, string>,
  existingSlugs: string[],
): RenderedTemplate | Response {
  try {
    return renderTemplate(template, {
      inputs,
      existingSlugs,
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    });
  } catch (err) {
    if (!(err instanceof TemplateInputError)) throw err;
    const details = err.issues.map((i) => ({
      field: `inputs.${i.key}`,
      code: i.code,
      message: i.message,
    }));
    return apiError(
      400,
      "invalid_request",
      `${details[0]?.field}: ${details[0]?.message}`,
      details,
    );
  }
}

interface Planned {
  ownerRef: string | null;
  key: string;
  value: string;
  tier: DbVariable["tier"];
  locked: boolean;
}

/** Mirrors `planVariables`: the classifier decides tiers; secrets need confirmation. */
function planVariables(
  rendered: RenderedTemplate,
  options: DeployOptions,
): { planned: Planned[]; warnings: TemplateDeployment["warnings"] } | Response {
  const entries: { ownerRef: string | null; variables: RenderedVariable[] }[] = [
    ...rendered.services.map((s) => ({ ownerRef: s.ref, variables: s.variables })),
    { ownerRef: null, variables: rendered.sharedVariables },
  ];
  const planned: Planned[] = [];
  const warnings: TemplateDeployment["warnings"] = [];
  const problems: { field: string; code: string; message: string }[] = [];
  const needAck: string[] = [];
  const needConfirm: string[] = [];
  for (const { ownerRef, variables } of entries) {
    for (const v of variables) {
      const classification = classifyVariable(v.key, v.value);
      const decision = decideVariableTier({
        classification,
        ...(v.secret ? { requested: "secret" as const } : {}),
        valueProvided: true,
      });
      if (!decision.ok) {
        problems.push({ field: v.key, code: decision.code, message: decision.message });
        continue;
      }
      for (const w of classification.warnings) {
        if (
          w.code === "public_prefix_secret_value" &&
          !options.acknowledge_public.includes(v.key)
        ) {
          needAck.push(v.key);
        }
        warnings.push({ key: v.key, code: w.code, message: w.message });
      }
      if (decision.tier === "secret") needConfirm.push(v.key);
      planned.push({
        ownerRef,
        key: v.key,
        value: v.value,
        tier: decision.tier,
        locked: decision.locked,
      });
    }
  }
  const first = problems[0];
  if (first) return apiError(400, first.code, `${first.field}: ${first.message}`, problems);
  if (needAck.length) {
    return apiError(
      400,
      "public_prefix_secret_value",
      `${needAck.join(", ")} will ship to every browser but look like a credential; add them to acknowledge_public to store anyway`,
      needAck.map((k) => ({
        field: k,
        code: "public_prefix_secret_value",
        message: "Looks like a credential",
      })),
    );
  }
  if (needConfirm.length && !options.confirm_write_only) {
    const unique = [...new Set(needConfirm)];
    return apiError(
      400,
      "confirmation_required",
      `${unique.join(", ")} will be write-only: nobody can read ${unique.length === 1 ? "it" : "them"} back. Resend with confirm_write_only to continue`,
      unique.map((k) => ({
        field: k,
        code: "confirmation_required",
        message: "Becomes write-only",
      })),
    );
  }
  return { planned, warnings };
}

function plan(template: Template, options: DeployOptions, existingSlugs: string[]) {
  const rendered = render(template, options.inputs, existingSlugs);
  if (rendered instanceof Response) return rendered;
  const variables = planVariables(rendered, options);
  if (variables instanceof Response) return variables;
  return { rendered, ...variables };
}

/**
 * Stores a rendered template in a project: services, config version 1 in every
 * environment, the target environment's variables, audit entries; then first deploys.
 */
function write(
  template: Template,
  project: Project,
  environment: Environment,
  planned: Exclude<ReturnType<typeof plan>, Response>,
  options: DeployOptions,
  userId: string,
): TemplateDeployment {
  const now = Date.now();
  const created: Service[] = [];
  const configsBy = new Map<string, ServiceConfig[]>();
  const idByRef = new Map<string, string>();
  for (const s of planned.rendered.services) {
    if (s.source.type === "database") throw new Error("database sources are refused earlier");
    const service: Service = {
      id: nextId("svc"),
      project_id: project.id,
      name: s.name,
      slug: s.slug,
      kind: s.kind,
      icon: s.icon,
      health: "ok",
      health_reason: null,
      created_at: now,
      updated_at: now,
    };
    db.deploy.services.push(service);
    const source: ServiceConfig["source"] =
      s.source.type === "image"
        ? { type: "image", image: s.source.image }
        : {
            type: "git",
            repo_url: s.source.repo_url,
            branch: s.source.branch,
            root_dir: s.source.root_dir,
          };
    const configs = createConfigs(
      service,
      source,
      s.config as Record<string, Record<string, unknown> | null>,
      userId,
    );
    db.deploy.configs.push(...configs);
    for (const config of configs) ensureGeneratedDomain(service, config);
    created.push(service);
    configsBy.set(service.id, configs);
    idByRef.set(s.ref, service.id);
  }
  for (const v of planned.planned) {
    const serviceId = v.ownerRef === null ? null : (idByRef.get(v.ownerRef) ?? null);
    db.deploy.variables.push({
      scope: serviceId ? "service" : "shared",
      owner_id: serviceId ?? project.id,
      environment_id: environment.id,
      key: v.key,
      value: v.value,
      tier: v.tier,
      locked: v.locked,
      available_at_build: false,
      mount_as_file: false,
      version: 1,
      updated_at: now,
      updated_by: userId,
    });
  }
  const audit = { workspaceId: project.workspace_id, actorType: "user", actorId: userId } as const;
  for (const service of created) {
    recordAudit({
      ...audit,
      action: "service.created",
      targetType: "service",
      targetId: service.id,
      metadata: {
        project_id: project.id,
        name: service.name,
        slug: service.slug,
        template_id: template.id,
      },
    });
  }
  const keysOf = (ref: string | null) =>
    planned.planned.filter((v) => v.ownerRef === ref).map((v) => v.key);
  recordAudit({
    ...audit,
    action: "template.deployed",
    targetType: "project",
    targetId: project.id,
    metadata: {
      name: template.name,
      template_id: template.id,
      template_version: template.version,
      environment_id: environment.id,
      services: planned.rendered.services.map((s) => ({
        id: idByRef.get(s.ref),
        slug: s.slug,
        variables: keysOf(s.ref),
      })),
      shared_variables: keysOf(null),
      secret_keys: planned.planned.filter((v) => v.tier === "secret").map((v) => v.key),
      inputs: Object.keys(options.inputs),
      deploy: options.deploy,
    },
  });
  for (const service of created) {
    broadcastRealtime(project.id, { type: "service.updated", service });
  }

  const deployments: Deployment[] = [];
  const deployErrors: TemplateDeployment["deploy_errors"] = [];
  if (options.deploy) {
    for (const service of created) {
      const config = configsBy.get(service.id)?.find((c) => c.environment_id === environment.id);
      if (!config || config.deploy.replicas === 0) {
        deployErrors.push({
          service_id: service.id,
          message: "The service has 0 replicas; scale it up to deploy",
        });
        continue;
      }
      const row = startDeployment(service, environment.id, config, undefined, "template", userId);
      recordAudit({
        ...audit,
        action: "deployment.created",
        targetType: "deployment",
        targetId: row.id,
        metadata: {
          service_id: service.id,
          environment_id: environment.id,
          config_version: row.config_version,
        },
      });
      announceDeployment(row);
      deployments.push({
        ...row,
        build: db.deploy.builds.find((build) => build.id === row.build_id) ?? null,
      });
    }
  }
  return {
    template: { id: template.id, version: template.version },
    project,
    environment,
    services: created,
    deployments,
    deploy_errors: deployErrors,
    warnings: planned.warnings,
  };
}

function stripProject({ deleted: _deleted, ...project }: Project & { deleted?: boolean }): Project {
  return project;
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

/** Every template route the dashboard calls. */
export const templateHandlers = [
  http.get(mswPath("listTemplates"), async ({ request, params }) => {
    const input = await validate("listTemplates", request, params);
    if (!input.ok) return input.response;
    const access = requireWorkspace(input.params.workspaceId ?? "", actionOf("listTemplates"));
    if (!access.ok) return access.response;
    return HttpResponse.json({ templates: MOCK_TEMPLATES.map(toSummary) });
  }),

  http.get(mswPath("getTemplate"), async ({ request, params }) => {
    const input = await validate("getTemplate", request, params);
    if (!input.ok) return input.response;
    const access = requireWorkspace(input.params.workspaceId ?? "", actionOf("getTemplate"));
    if (!access.ok) return access.response;
    const template = findMockTemplate(input.params.templateId ?? "");
    if (!template) return notFound("Template");
    return HttpResponse.json(toDetail(template));
  }),

  http.post(mswPath("createProjectFromTemplate"), async ({ request, params }) => {
    const input = await validate<
      DeployOptions & { name?: string; slug?: string; description?: string }
    >("createProjectFromTemplate", request, params);
    if (!input.ok) return input.response;
    const workspaceId = input.params.workspaceId ?? "";
    const access = requireWorkspace(workspaceId, actionOf("createProjectFromTemplate"));
    if (!access.ok) return access.response;
    const body = input.body;
    const template = findMockTemplate(body.template_id);
    if (!template) return notFound("Template");
    const refused = unsupported(template) ?? deployAccess(workspaceId, body.deploy);
    if (refused) return refused;
    const planned = plan(template, body, []);
    if (planned instanceof Response) return planned;

    const name = body.name ?? template.name;
    const taken = new Set(
      db.deploy.projects
        .filter((row) => row.workspace_id === workspaceId && !row.deleted)
        .map((row) => row.slug),
    );
    const slug = freeSlug(taken, body.slug ?? slugify(name, 40, "project"));
    const now = Date.now();
    const project: Project = {
      id: nextId("prj"),
      workspace_id: workspaceId,
      name,
      slug,
      description: body.description || null,
      created_at: now,
      updated_at: now,
    };
    const environment: Environment = {
      id: nextId("env"),
      project_id: project.id,
      name: "production",
      slug: "production",
      kind: "production",
      pr_number: null,
      source_branch: null,
      protected: true,
      created_at: now,
    };
    db.deploy.projects.push(project);
    db.deploy.environments.push(environment);
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "project.created",
      targetType: "project",
      targetId: project.id,
      metadata: { name, slug, template_id: template.id },
    });
    const result = write(template, project, environment, planned, body, access.user.id);
    return HttpResponse.json(result, { status: 201 });
  }),

  http.post(mswPath("deployTemplate"), async ({ request, params }) => {
    const input = await validate<DeployOptions & { environment_id: string }>(
      "deployTemplate",
      request,
      params,
    );
    if (!input.ok) return input.response;
    if (!currentUser()) return unauthorized();
    const project = db.deploy.projects.find(
      (row) => row.id === input.params.projectId && !row.deleted,
    );
    if (!project) return notFound("Project");
    const access = requireWorkspace(project.workspace_id, actionOf("deployTemplate"));
    // NOTE: Non-members get the same 404 as a missing project, so ids can't be probed.
    if (!access.ok) {
      return access.response.status === 404 ? notFound("Project") : access.response;
    }
    const body = input.body;
    const environment = db.deploy.environments.find(
      (row) => row.id === body.environment_id && row.project_id === project.id,
    );
    if (!environment) return notFound("Environment");
    const template = findMockTemplate(body.template_id);
    if (!template) return notFound("Template");
    const refused = unsupported(template) ?? deployAccess(project.workspace_id, body.deploy);
    if (refused) return refused;
    const taken = db.deploy.services
      .filter((row) => row.project_id === project.id && !row.deleted)
      .map((row) => row.slug);
    const planned = plan(template, body, taken);
    if (planned instanceof Response) return planned;
    const result = write(
      template,
      stripProject(project),
      environment,
      planned,
      body,
      access.user.id,
    );
    return HttpResponse.json(result, { status: 201 });
  }),
];

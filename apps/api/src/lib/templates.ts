/**
 * Deploying templates: finding one in the built-in catalogue, the API's
 * views of it, and turning a rendered template into stored services,
 * configs and variables.
 *
 * Shared by the REST routes (`../routes/templates`) and the MCP
 * `deploy_template` tool, so both check the same actions and write the same
 * audit records.
 *
 * Writes happen in one D1 batch: the project (when new), every service, its
 * config version 1 in every environment, the target environment's variables,
 * each volume in every environment, each database's generated credentials
 * in every environment (ADR 0004), and the audit records. First deployments start afterwards, one per
 * service; one that can't start is reported, not fatal, since the services
 * already exist.
 *
 * @module
 */

import type { z } from "@hono/zod-openapi";
import {
  type Db,
  environments,
  projectKeys,
  projects,
  services,
  variables,
  volumes,
} from "@roundhouse/db";
import {
  classifyVariable,
  DEFAULT_ENVIRONMENT,
  decideVariableTier,
  defaultServiceConfig,
  newId,
  parseReferences,
  type ServiceDatabaseEngine,
  type ServiceSource,
  secretLengthWarnings,
  type VariableTier,
} from "@roundhouse/shared";
import {
  isSecretTemplateVariable,
  type RenderedTemplate,
  type RenderedVariable,
  renderTemplate,
  type Template,
  TemplateInputError,
  type TemplateRequirement,
  type TemplateSource,
  type TemplateVariable,
  templateRequirements,
} from "@roundhouse/shared/template";
import { and, asc, eq, isNull } from "drizzle-orm";
import { type AppContext, type Caller, clientIp, originOf } from "../context";
import type {
  TemplateDeploymentSchema,
  TemplateDetailSchema,
  TemplateSummarySchema,
} from "../schemas/templates";
import { type AuditEntry, auditInsert, recordAudit } from "./audit";
import { type KeyEnv, openDataKey } from "./crypto";
import {
  databaseCreateOp,
  databaseVariableRows,
  databaseVariables,
  resolveDatabaseVersion,
} from "./databases";
import { createDeployment } from "./deployments";
import { ApiError, type ErrorDetail, isUniqueViolation, notFound } from "./errors";
import {
  configInsert,
  insertWithFreeSlug,
  mergeConfig,
  slugFor,
  syncGeneratedDomain,
} from "./projects";
import { publish } from "./realtime";
import { toApiDeployment, toApiEnvironment, toApiProject, toApiService } from "./serialize";
import { getIngressSettings } from "./settings";
import { BUILT_IN_TEMPLATES } from "./template-catalogue";
import {
  assertPlainBuildArgs,
  assertValidReferences,
  newProjectKeyRow,
  projectKey,
  type StoredVariable,
  sealVariable,
  type VariableTarget,
  type VariableWriteWarning,
} from "./variables";
import { singleReplicaError, volumeRowsFor } from "./volumes";

/** Requirements this control plane can satisfy: every one, since ADR 0004 shipped. */
export const SUPPORTED_TEMPLATE_REQUIREMENTS: readonly TemplateRequirement[] = [
  "databases",
  "volumes",
];

// -----------------------------------------------------------------------------
// Catalogue and views
// -----------------------------------------------------------------------------

/**
 * Looks a template up by ID.
 *
 * @param id - Template ID.
 * @returns The template.
 * @throws {ApiError} 404 when there is none.
 */
export function findTemplate(id: string): Template {
  const template = BUILT_IN_TEMPLATES.find((t) => t.id === id);
  if (!template) throw notFound("Template");
  return template;
}

/** A template as the gallery lists it; see `TemplateSummarySchema`. */
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;

/** A template with its deploy form; see `TemplateDetailSchema`. */
export type TemplateDetail = z.infer<typeof TemplateDetailSchema>;

/**
 * Projects a template for the gallery.
 *
 * @param t - A template.
 * @returns Its summary.
 */
export function toTemplateSummary(t: Template): TemplateSummary {
  const requirements = templateRequirements(t);
  return {
    id: t.id,
    version: t.version,
    name: t.name,
    description: t.description,
    icon: t.icon ?? null,
    category: t.category,
    tags: t.tags,
    docs_url: t.docs_url ?? null,
    service_count: t.services.length,
    requirements,
    supported: requirements.every((r) => SUPPORTED_TEMPLATE_REQUIREMENTS.includes(r)),
  };
}

/** Port a service listens on when its template doesn't say. */
const DEFAULT_PORT = defaultServiceConfig({ type: "image", image: "scratch" }).networking.port;

function toTemplateVariables(t: Template, vars: Record<string, TemplateVariable> | undefined) {
  return Object.entries(vars ?? {}).map(([key, raw]) => {
    const spec = typeof raw === "string" ? { value: raw } : raw;
    const secret = isSecretTemplateVariable(t, raw);
    return {
      key,
      secret,
      generated: spec.generate !== undefined,
      value: secret ? null : (spec.value ?? null),
      description: spec.description ?? null,
    };
  });
}

function toTemplateSource(source: TemplateSource) {
  switch (source.type) {
    case "image":
      return { type: "image" as const, image: source.image };
    case "git":
      return {
        type: "git" as const,
        repo_url: source.repo_url,
        branch: source.branch,
        root_dir: source.root_dir,
      };
    case "database":
      return { type: "database" as const, engine: source.engine, version: source.version ?? null };
  }
}

/**
 * Projects a template for its detail page and deploy form. Secret values are
 * never included; the manifest has none anyway, only generators and inputs.
 *
 * @param t - A template.
 * @returns Its detail view.
 */
export function toTemplateDetail(t: Template): TemplateDetail {
  return {
    ...toTemplateSummary(t),
    inputs: t.inputs.map((i) => ({
      key: i.key,
      label: i.label,
      description: i.description ?? null,
      type: i.type,
      required: i.required,
      default: i.default ?? null,
      options: i.options ?? null,
    })),
    services: t.services.map((s) => {
      const port = s.config?.networking?.port;
      return {
        ref: s.ref,
        name: s.name,
        kind: s.kind,
        icon: s.icon ?? null,
        source: toTemplateSource(s.source),
        port: port === undefined ? DEFAULT_PORT : port,
        public: s.config?.networking?.generated_domain ?? false,
        start_command: s.config?.deploy?.start_command ?? null,
        variables: toTemplateVariables(t, s.variables),
      };
    }),
    shared_variables: toTemplateVariables(t, t.shared_variables),
  };
}

// -----------------------------------------------------------------------------
// Deploying
// -----------------------------------------------------------------------------

/** What the deployer chose, from the request body or tool input. */
export interface TemplateDeployOptions {
  inputs: Record<string, string>;
  /** Start a first deployment of every created service. */
  deploy: boolean;
  confirmWriteOnly: boolean;
  acknowledgePublic: readonly string[];
  /** Extra audit metadata, e.g. `{ via: "mcp", tool }`. */
  auditMetadata?: Record<string, unknown>;
}

/** What a template deploy created; see `TemplateDeploymentSchema`. */
export type TemplateDeployResult = z.infer<typeof TemplateDeploymentSchema>;

const forbidden = (action: string) =>
  new ApiError(403, "forbidden", `Deploying this template needs ${action}, which you lack here`);

/**
 * Checks the actions a deploy needs beyond the route's own, with the same
 * scope (so environment protection applies to an existing environment).
 */
function assertDeployAccess(caller: Caller, deploy: boolean): void {
  if (!caller.allows("services:manage")) throw forbidden("services:manage");
  if (!caller.allows("variables:manage")) throw forbidden("variables:manage");
  if (deploy && !caller.allows("deployments:create")) throw forbidden("deployments:create");
}

function assertSupported(template: Template): void {
  const missing = templateRequirements(template).filter(
    (r) => !SUPPORTED_TEMPLATE_REQUIREMENTS.includes(r),
  );
  if (missing.length) {
    throw new ApiError(
      409,
      "conflict",
      `${template.name} needs ${missing.join(" and ")}, which this control plane doesn't support yet`,
    );
  }
}

function render(template: Template, inputs: Record<string, string>, existingSlugs: string[]) {
  try {
    return renderTemplate(template, {
      inputs,
      existingSlugs,
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    });
  } catch (err) {
    if (!(err instanceof TemplateInputError)) throw err;
    const details: ErrorDetail[] = err.issues.map((i) => ({
      field: `inputs.${i.key}`,
      code: i.code,
      message: i.message,
    }));
    throw new ApiError(
      400,
      "invalid_request",
      `${details[0]!.field}: ${details[0]!.message}`,
      details,
    );
  }
}

function sourceOf(source: Exclude<TemplateSource, { type: "database" }>): ServiceSource {
  switch (source.type) {
    case "image":
      return { type: "image", image: source.image };
    case "git":
      return {
        type: "git",
        repo_url: source.repo_url,
        branch: source.branch,
        root_dir: source.root_dir,
      };
  }
}

/** One variable after the classifier decided its tier. */
interface PlannedVariable {
  target: VariableTarget;
  key: string;
  value: string;
  tier: VariableTier;
  locked: boolean;
}

/**
 * Decides every rendered variable's tier with the shared classifier, the way
 * a variables write does: template secrets ask for `secret`, plain values
 * take the classifier's tier, so a value that looks like a credential is
 * never stored readable.
 *
 * NOTE: This mirrors `putVariables`' rules instead of calling it, because
 * `putVariables` commits its own batch and a template's services and
 * variables must commit together. Template variables are never build-time,
 * so its build-time checks don't apply.
 *
 * @throws {ApiError} 400 with `details`: `invalid_reference`, a tier
 *   decision's code, `public_prefix_secret_value` without acknowledgement,
 *   or `confirmation_required` when secrets would be stored without
 *   `confirm_write_only`.
 */
function planVariables(
  entries: { target: VariableTarget; variables: RenderedVariable[] }[],
  options: TemplateDeployOptions,
): { planned: PlannedVariable[]; warnings: VariableWriteWarning[] } {
  assertValidReferences(entries.flatMap((e) => e.variables));
  const planned: PlannedVariable[] = [];
  const warnings: VariableWriteWarning[] = [];
  const problems: ErrorDetail[] = [];
  const needAck: string[] = [];
  const needConfirm: string[] = [];
  for (const { target, variables: vars } of entries) {
    for (const v of vars) {
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
      // Same rule as a variables write: the short-secret warning follows the
      // stored tier, not the classifier's default one.
      const fromClassifier = classification.warnings.filter(
        (w) => w.code !== "secret_too_short_to_redact" || decision.tier === "secret",
      );
      const lengthWarnings =
        decision.tier === "secret" && classification.tier !== "secret"
          ? secretLengthWarnings(v.key, v.value)
          : [];
      for (const w of [...fromClassifier, ...lengthWarnings]) {
        if (w.code === "public_prefix_secret_value" && !options.acknowledgePublic.includes(v.key)) {
          needAck.push(v.key);
        }
        warnings.push({ key: v.key, code: w.code, message: w.message });
      }
      if (decision.tier === "secret") needConfirm.push(v.key);
      planned.push({ target, key: v.key, value: v.value, ...decision });
    }
  }
  if (problems.length) {
    const first = problems[0]!;
    throw new ApiError(
      400,
      first.code as "invalid_request",
      `${first.field}: ${first.message}`,
      problems,
    );
  }
  if (needAck.length) {
    throw new ApiError(
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
  if (needConfirm.length && !options.confirmWriteOnly) {
    const unique = [...new Set(needConfirm)];
    throw new ApiError(
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

/** Seals each planned value for its new row at version 1, with its fingerprint. */
async function variableRows(key: CryptoKey, planned: PlannedVariable[], actorId: string) {
  return Promise.all(
    planned.map(async (p) => {
      const coordinates: StoredVariable = {
        id: newId("variable"),
        projectId: p.target.projectId,
        environmentId: p.target.environmentId,
        scope: p.target.scope,
        serviceId: p.target.serviceId,
        key: p.key,
        version: 1,
      };
      return {
        ...coordinates,
        ...(await sealVariable(key, coordinates, p.value)),
        tier: p.tier,
        locked: p.locked,
        availableAtBuild: false,
        mountAsFile: false,
        updatedBy: actorId,
      } satisfies typeof variables.$inferInsert;
    }),
  );
}

/** A rendered template laid out as rows for one project. */
interface Plan {
  rendered: RenderedTemplate;
  serviceRows: (typeof services.$inferInsert & { id: string; slug: string })[];
  specs: Map<string, ReturnType<typeof mergeConfig>>;
  planned: PlannedVariable[];
  warnings: VariableWriteWarning[];
  /** Every service's volume, in every environment. */
  volumeRows: (typeof volumes.$inferInsert)[];
  /** Databases, whose credentials are generated per environment. */
  databases: {
    serviceId: string;
    engine: ServiceDatabaseEngine;
    version: string;
    /** Keys the template sets itself. */
    keep: Set<string>;
  }[];
}

function plan(
  template: Template,
  projectId: string,
  environmentId: string,
  envIds: readonly string[],
  existingSlugs: string[],
  options: TemplateDeployOptions,
): Plan {
  const rendered = render(template, options.inputs, existingSlugs);
  const serviceRows: Plan["serviceRows"] = [];
  const specs: Plan["specs"] = new Map();
  const volumeRows: Plan["volumeRows"] = [];
  const databases: Plan["databases"] = [];
  const entries: { target: VariableTarget; variables: RenderedVariable[] }[] = [];
  for (const s of rendered.services) {
    const id = newId("service");
    const declared = template.services.find((t) => t.ref === s.ref)?.volume;
    if (s.source.type === "database") {
      const op = databaseCreateOp({
        ref: "new:1",
        name: s.name,
        database: {
          engine: s.source.engine,
          version: s.source.version,
          ...(declared ? { size_mb: declared.size_mb } : {}),
        },
        config: s.config,
      });
      const database = op.database!;
      serviceRows.push({
        id,
        projectId,
        name: s.name,
        slug: s.slug,
        kind: "database",
        icon: s.icon ?? op.icon ?? null,
        databaseEngine: database.engine,
        databaseVersion: database.version,
      });
      specs.set(id, mergeConfig(defaultServiceConfig(op.source), op.config ?? {}));
      volumeRows.push(
        ...volumeRowsFor({
          projectId,
          serviceId: id,
          environmentIds: envIds,
          mountPath: resolveDatabaseVersion(database.engine, database.version).mountPath,
          sizeMb: database.size_mb,
        }),
      );
      databases.push({
        serviceId: id,
        engine: database.engine,
        version: database.version,
        keep: new Set(s.variables.map((v) => v.key)),
      });
    } else {
      serviceRows.push({ id, projectId, name: s.name, slug: s.slug, kind: s.kind, icon: s.icon });
      const spec = mergeConfig(defaultServiceConfig(sourceOf(s.source)), s.config);
      if (declared && spec.deploy.replicas > 1) throw singleReplicaError();
      specs.set(id, spec);
      if (declared) {
        volumeRows.push(
          ...volumeRowsFor({
            projectId,
            serviceId: id,
            environmentIds: envIds,
            mountPath: declared.mount_path,
            sizeMb: declared.size_mb,
          }),
        );
      }
    }
    entries.push({
      target: { projectId, environmentId, scope: "service", serviceId: id },
      variables: s.variables,
    });
  }
  entries.push({
    target: { projectId, environmentId, scope: "shared", serviceId: null },
    variables: rendered.sharedVariables,
  });
  return {
    rendered,
    serviceRows,
    specs,
    volumeRows,
    databases,
    ...planVariables(entries, options),
  };
}

/**
 * Generated credentials of every database in every environment, as rows. A
 * key the template sets itself is left to the template in the target
 * environment, where its value is written.
 */
async function databaseRows(
  key: CryptoKey,
  p: Plan,
  projectId: string,
  environmentId: string,
  envIds: readonly string[],
  actorId: string,
) {
  const out: Awaited<ReturnType<typeof databaseVariableRows>> = [];
  for (const d of p.databases) {
    for (const envId of envIds) {
      const entries = databaseVariables(d.engine, d.version).filter(
        (v) => envId !== environmentId || !d.keep.has(v.key),
      );
      out.push(
        ...(await databaseVariableRows(
          key,
          { projectId, environmentId: envId, scope: "service", serviceId: d.serviceId },
          entries,
          actorId,
        )),
      );
    }
  }
  return out;
}

/**
 * Applies the build-arg rules of a config save to every created service.
 * A new project has no variables yet, so its args with references are left
 * to the same check at deploy time.
 */
async function checkBuildArgs(
  db: Db,
  keys: KeyEnv,
  projectId: string,
  environmentId: string,
  p: Plan,
  projectExists: boolean,
): Promise<void> {
  for (const row of p.serviceRows) {
    const build = p.specs.get(row.id)!.build;
    const args = projectExists
      ? build.build_args
      : Object.fromEntries(
          Object.entries(build.build_args).filter(
            ([, value]) => parseReferences(value).references.length === 0,
          ),
        );
    await assertPlainBuildArgs(db, keys, {
      projectId,
      environmentId,
      serviceSlug: row.slug,
      build: { build_args: args, secret_build_args: build.secret_build_args },
    });
  }
}

function writeStatements(
  db: Db,
  p: Plan,
  envIds: readonly string[],
  actorId: string,
  rows: readonly (typeof variables.$inferInsert)[],
) {
  return [
    ...p.serviceRows.map((row) => db.insert(services).values(row)),
    ...p.serviceRows.flatMap((row) =>
      envIds.map((environmentId) =>
        configInsert(db, {
          serviceId: row.id,
          environmentId,
          version: 1,
          createdBy: actorId,
          spec: p.specs.get(row.id)!,
        }),
      ),
    ),
    ...rows.map((row) => db.insert(variables).values(row)),
    ...p.volumeRows.map((row) => db.insert(volumes).values(row)),
  ];
}

function auditEntries(
  caller: Caller,
  ip: string | null,
  template: Template,
  project: { id: string; workspaceId: string },
  environmentId: string,
  p: Plan,
  options: TemplateDeployOptions,
): AuditEntry[] {
  const base = { workspaceId: project.workspaceId, ...caller.actor, ip };
  const extra = options.auditMetadata ?? {};
  const keysBy = (serviceId: string | null) =>
    p.planned.filter((v) => v.target.serviceId === serviceId).map((v) => v.key);
  return [
    ...p.serviceRows.map(
      (row): AuditEntry => ({
        ...base,
        action: "service.created",
        targetType: "service",
        targetId: row.id,
        metadata: {
          project_id: project.id,
          name: row.name,
          slug: row.slug,
          source: p.specs.get(row.id)!.source.type,
          template_id: template.id,
          ...extra,
        },
      }),
    ),
    {
      ...base,
      action: "template.deployed",
      targetType: "project",
      targetId: project.id,
      metadata: {
        name: template.name,
        template_id: template.id,
        template_version: template.version,
        environment_id: environmentId,
        services: p.serviceRows.map((row) => ({
          id: row.id,
          slug: row.slug,
          variables: keysBy(row.id),
        })),
        shared_variables: keysBy(null),
        secret_keys: p.planned.filter((v) => v.tier === "secret").map((v) => v.key),
        inputs: Object.keys(options.inputs),
        deploy: options.deploy,
        ...extra,
      },
    },
  ];
}

/**
 * Starts the first deployment of each created service, auditing each, and
 * collects the ones that couldn't start.
 */
async function startDeployments(
  c: AppContext,
  caller: Caller,
  project: { id: string; workspaceId: string },
  environmentId: string,
  rows: Plan["serviceRows"],
  options: TemplateDeployOptions,
) {
  const db = c.get("db");
  const started: TemplateDeployResult["deployments"] = [];
  const failed: TemplateDeployResult["deploy_errors"] = [];
  if (!options.deploy) return { started, failed };
  for (const row of rows) {
    try {
      const deployment = await createDeployment(
        { db, env: c.env },
        {
          projectId: project.id,
          serviceId: row.id,
          environmentId,
          trigger: "template",
          triggeredBy: caller.user.id,
          origin: originOf(c),
        },
      );
      await recordAudit(db, {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action: "deployment.created",
        targetType: "deployment",
        targetId: deployment.id,
        metadata: {
          service_id: row.id,
          environment_id: environmentId,
          config_version: deployment.configVersion,
          ...(options.auditMetadata ?? {}),
        },
        ip: clientIp(c),
      });
      started.push(toApiDeployment(deployment, null, project.id));
    } catch (err) {
      if (!(err instanceof ApiError)) console.error("template first deploy failed", err);
      failed.push({
        service_id: row.id,
        message: err instanceof ApiError ? err.message : "Could not start the deploy pipeline",
      });
    }
  }
  return { started, failed };
}

async function syncDomains(
  db: Db,
  p: Plan,
  envs: readonly { id: string; slug: string }[],
): Promise<void> {
  const ingress = await getIngressSettings(db);
  for (const row of p.serviceRows) {
    for (const e of envs) {
      await syncGeneratedDomain(
        db,
        {
          serviceId: row.id,
          serviceSlug: row.slug,
          environmentId: e.id,
          environmentSlug: e.slug,
          spec: p.specs.get(row.id)!,
        },
        ingress,
      );
    }
  }
}

async function loadServices(db: Db, ids: string[]) {
  const rows = await db.query.services.findMany({
    where: (s, { inArray }) => inArray(s.id, ids),
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)!);
}

/** Slug conflicts between reading the taken slugs and the batch get this many retries. */
const SLUG_ATTEMPTS = 4;

/**
 * Creates a project with its production environment from a template.
 *
 * The caller passed `projects:create` on the workspace; this also requires
 * `services:manage`, `variables:manage` and, when deploying,
 * `deployments:create`, checked workspace-wide, which is exactly what a new
 * project with no grants gives them.
 *
 * @param c - Request context.
 * @param caller - From `requireWorkspace(…, "projects:create")`.
 * @param keys - The keyring bindings, for the new project's data key.
 * @param template - The template.
 * @param project - Name, optional slug and description.
 * @param options - Inputs, deploy flag, confirmations and audit extras.
 * @returns What was created.
 */
export async function createProjectFromTemplate(
  c: AppContext,
  caller: Caller,
  keys: KeyEnv,
  template: Template,
  project: { name?: string; slug?: string; description?: string },
  options: TemplateDeployOptions,
): Promise<TemplateDeployResult> {
  assertSupported(template);
  assertDeployAccess(caller, options.deploy);
  const db = c.get("db");
  const workspaceId = caller.workspaceId;
  const name = project.name ?? template.name;
  const id = newId("project");
  const envId = newId("environment");
  const keyRow = await newProjectKeyRow(keys, id, workspaceId);
  const key = await openDataKey(keys, keyRow.dekSealed, workspaceId, id);
  const p = plan(template, id, envId, [envId], [], options);
  await checkBuildArgs(db, keys, id, envId, p, false);
  const rows = [
    ...(await variableRows(key, p.planned, caller.user.id)),
    ...(await databaseRows(key, p, id, envId, [envId], caller.user.id)),
  ];
  const ip = clientIp(c);

  await insertWithFreeSlug({
    base: project.slug ?? slugFor(name, "project"),
    uniqueOn: "projects",
    taken: async () =>
      (
        await db
          .select({ slug: projects.slug })
          .from(projects)
          .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
      ).map((t) => t.slug),
    insert: (slug) =>
      db.batch([
        db.insert(projects).values({
          id,
          workspaceId,
          name,
          slug,
          description: project.description || null,
        }),
        db.insert(environments).values({
          id: envId,
          projectId: id,
          name: DEFAULT_ENVIRONMENT.name,
          slug: DEFAULT_ENVIRONMENT.slug,
          kind: "production",
          // ADR 0014: production starts protected (DEFAULT_PROTECTION_RULES).
          protected: true,
        }),
        db.insert(projectKeys).values(keyRow),
        ...writeStatements(db, p, [envId], caller.user.id, rows),
        auditInsert(db, {
          workspaceId,
          ...caller.actor,
          action: "project.created",
          targetType: "project",
          targetId: id,
          metadata: { name, slug, template_id: template.id, ...(options.auditMetadata ?? {}) },
          ip,
        }),
        ...auditEntries(caller, ip, template, { id, workspaceId }, envId, p, options).map((e) =>
          auditInsert(db, e),
        ),
      ]),
  });

  const projectRow = (await db.query.projects.findFirst({ where: eq(projects.id, id) }))!;
  const env = (await db.query.environments.findFirst({ where: eq(environments.id, envId) }))!;
  await syncDomains(db, p, [env]);
  const deployed = await startDeployments(
    c,
    caller,
    { id, workspaceId },
    envId,
    p.serviceRows,
    options,
  );
  return {
    template: { id: template.id, version: template.version },
    project: toApiProject(projectRow),
    environment: toApiEnvironment(env),
    services: (
      await loadServices(
        db,
        p.serviceRows.map((r) => r.id),
      )
    ).map(toApiService),
    deployments: deployed.started,
    deploy_errors: deployed.failed,
    warnings: p.warnings,
  };
}

/**
 * Adds a template's services to an existing project. Each service gets
 * config version 1 in every environment, like a service created by hand;
 * variables go to `environment` only.
 *
 * The caller passed `services:manage` scoped to the project and target
 * environment; this also requires `variables:manage` and, when deploying,
 * `deployments:create` there, so environment protection applies to all
 * three.
 *
 * @param c - Request context.
 * @param caller - From `projectScope(…, "services:manage", environmentId)`.
 * @param keys - The keyring bindings.
 * @param template - The template.
 * @param project - The live project.
 * @param environment - The target environment of the project.
 * @param options - Inputs, deploy flag, confirmations and audit extras.
 * @returns What was created.
 * @throws {ApiError} 409 when slugs kept colliding with concurrent creates.
 */
export async function deployTemplateIntoProject(
  c: AppContext,
  caller: Caller,
  keys: KeyEnv,
  template: Template,
  project: typeof projects.$inferSelect,
  environment: typeof environments.$inferSelect,
  options: TemplateDeployOptions,
): Promise<TemplateDeployResult> {
  assertSupported(template);
  assertDeployAccess(caller, options.deploy);
  const db = c.get("db");
  const key = await projectKey(db, keys, project.id);
  const envs = await db
    .select()
    .from(environments)
    .where(eq(environments.projectId, project.id))
    .orderBy(asc(environments.id));
  const ip = clientIp(c);

  let p: Plan | undefined;
  for (let attempt = 1; !p; attempt++) {
    const taken = (
      await db
        .select({ slug: services.slug })
        .from(services)
        .where(and(eq(services.projectId, project.id), isNull(services.deletedAt)))
    ).map((r) => r.slug);
    const envIds = envs.map((e) => e.id);
    const candidate = plan(template, project.id, environment.id, envIds, taken, options);
    await checkBuildArgs(db, keys, project.id, environment.id, candidate, true);
    const rows = [
      ...(await variableRows(key, candidate.planned, caller.user.id)),
      ...(await databaseRows(key, candidate, project.id, environment.id, envIds, caller.user.id)),
    ];
    try {
      const statements = [
        ...writeStatements(
          db,
          candidate,
          envs.map((e) => e.id),
          caller.user.id,
          rows,
        ),
        ...auditEntries(caller, ip, template, project, environment.id, candidate, options).map(
          (e) => auditInsert(db, e),
        ),
      ];
      await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
      p = candidate;
    } catch (err) {
      if (!isUniqueViolation(err, "services")) throw err;
      if (attempt >= SLUG_ATTEMPTS) {
        throw new ApiError(409, "conflict", "Could not allocate free service slugs; retry");
      }
    }
  }

  await syncDomains(db, p, envs);
  const created = await loadServices(
    db,
    p.serviceRows.map((r) => r.id),
  );
  for (const s of created) {
    await publish(c.env, project.id, { type: "service.updated", service: toApiService(s) });
  }
  const deployed = await startDeployments(
    c,
    caller,
    project,
    environment.id,
    p.serviceRows,
    options,
  );
  return {
    template: { id: template.id, version: template.version },
    project: toApiProject(project),
    environment: toApiEnvironment(environment),
    services: created.map(toApiService),
    deployments: deployed.started,
    deploy_errors: deployed.failed,
    warnings: p.warnings,
  };
}

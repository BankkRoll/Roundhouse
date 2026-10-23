/**
 * MSW handlers for the canvas and change set routes (`CHANGE_ROUTES` in
 * `apps/api/src/contracts/changes.ts`) against the in-memory {@link db}.
 * `contract.test.ts` validates every response against the API's schemas.
 *
 * They mirror the API's order: the route's own zod schemas (400), then 401 without a
 * session, 404 for missing rows or non-members, 403 when the role lacks an op's action,
 * then 409 for a stale revision or a closed set. Staging coalesces with the shared
 * `stageOp`, diffs configs with `configDiff` and shows variables by fingerprint only;
 * applying checks drift (rebasing disjoint config edits, refusing overlapping ones),
 * writes configs, services and variables, deploys the affected services and records the
 * API's audit entries.
 *
 * @module
 */
import {
  type Action,
  affectedServices,
  classifyVariable,
  configDiff,
  conflictingPointers,
  decideVariableTier,
  defaultServiceConfig,
  describeOp,
  freeSlug,
  isNewServiceRef,
  mergeConfigPatches,
  opAction,
  patchPointers,
  RESERVED_SERVICE_SLUGS,
  type ServiceConfigPatch,
  type ServiceConfigSpec,
  type StagedOp,
  serviceOfOp,
  slugify,
  stageOp,
  targetKeyOf,
  variableDependencies,
} from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import { CHANGE_ROUTES, policyOf } from "../../../api/src/contracts";
import type { StagedOpInput } from "../lib/api/changes-types";
import type { Environment, Service, ServiceConfig } from "../lib/api/deploy-types";
import {
  type DbChangeSet,
  type DbStagedChange,
  mockFingerprint,
  toChangeSet,
  toSummary,
} from "./changes-db";
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
  startDeployment,
} from "./deploy-handlers";

// -----------------------------------------------------------------------------
// Validation with the contract's schemas
// -----------------------------------------------------------------------------

type RouteName = keyof typeof CHANGE_ROUTES;

interface Schema {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

interface RouteRequest {
  params?: Schema;
  query?: Schema;
  body?: { content: { "application/json": { schema: Schema } } };
}

function issueResponse(issues: { path: PropertyKey[]; message: string }[]): Response {
  const issue = issues[0];
  const where = issue?.path.length ? `${issue.path.map(String).join(".")}: ` : "";
  return invalid(`${where}${issue?.message ?? "invalid"}`);
}

async function validate<B = Record<string, unknown>, Q = Record<string, unknown>>(
  name: RouteName,
  request: Request,
  params: Record<string, string | readonly string[] | undefined>,
): Promise<
  | { ok: true; params: Record<string, string>; query: Q; body: B }
  | { ok: false; response: Response }
> {
  const spec = (CHANGE_ROUTES[name] as { request?: RouteRequest }).request ?? {};
  const parsedParams = spec.params?.safeParse(params);
  if (parsedParams && !parsedParams.success) {
    return { ok: false, response: issueResponse(parsedParams.error.issues) };
  }
  const url = new URL(request.url);
  const parsedQuery = spec.query?.safeParse(Object.fromEntries(url.searchParams));
  if (parsedQuery && !parsedQuery.success) {
    return { ok: false, response: issueResponse(parsedQuery.error.issues) };
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
    query: (parsedQuery?.data ?? {}) as Q,
    body: body as B,
  };
}

function mswPath(name: RouteName): string {
  return `*${CHANGE_ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;
}

function actionOf(name: RouteName): Action {
  return policyOf(CHANGE_ROUTES[name]).action as Action;
}

const changed = (revision: number) =>
  apiError(
    409,
    "change_set_changed",
    `The change set changed since you reviewed it; it is at revision ${revision}. Reload and review again`,
  );
const closed = (set: DbChangeSet) =>
  apiError(409, "conflict", `The change set is ${set.status} and can't be changed`);
const forbidden = (role: string, action: string) =>
  apiError(403, "forbidden", `Your role (${role}) cannot perform ${action}`);

// -----------------------------------------------------------------------------
// Lookups
// -----------------------------------------------------------------------------

type Scope =
  | { ok: true; environment: Environment; workspaceId: string; userId: string; role: string }
  | { ok: false; response: Response };

function environmentScope(environmentId: string, action: Action): Scope {
  if (!currentUser()) return { ok: false, response: unauthorized() };
  const environment = db.deploy.environments.find((e) => e.id === environmentId);
  const project = environment
    ? db.deploy.projects.find((p) => p.id === environment.project_id && !p.deleted)
    : undefined;
  if (!environment || !project) return { ok: false, response: notFound("Environment") };
  const guard = requireWorkspace(project.workspace_id, action);
  if (!guard.ok) {
    return {
      ok: false,
      response: guard.response.status === 404 ? notFound("Environment") : guard.response,
    };
  }
  return {
    ok: true,
    environment,
    workspaceId: project.workspace_id,
    userId: guard.user.id,
    role: guard.membership.role,
  };
}

function setScope(
  setId: string,
  action: Action,
): (Scope & { ok: true; set: DbChangeSet }) | { ok: false; response: Response } {
  if (!currentUser()) return { ok: false, response: unauthorized() };
  const set = db.changes.sets.find((s) => s.id === setId);
  if (!set) return { ok: false, response: notFound("Change set") };
  const scope = environmentScope(set.environment_id, action);
  if (!scope.ok) {
    return {
      ok: false,
      response: scope.response.status === 404 ? notFound("Change set") : scope.response,
    };
  }
  return { ...scope, set };
}

function allows(workspaceId: string, action: Action): boolean {
  return requireWorkspace(workspaceId, action).ok;
}

function liveServices(projectId: string): Service[] {
  return db.deploy.services.filter((s) => s.project_id === projectId && !s.deleted);
}

function latestConfig(serviceId: string, environmentId: string, version?: number) {
  return db.deploy.configs
    .filter(
      (c) =>
        c.service_id === serviceId &&
        c.environment_id === environmentId &&
        (version === undefined || c.version === version),
    )
    .sort((a, b) => b.version - a.version)[0];
}

function specOf(config: ServiceConfig): ServiceConfigSpec {
  return {
    source: config.source,
    build: config.build,
    deploy: config.deploy,
    resources: config.resources,
    healthcheck: config.healthcheck,
    networking: config.networking,
    placement: config.placement,
  };
}

function merge(spec: ServiceConfigSpec, patch: ServiceConfigPatch): ServiceConfigSpec {
  const next = { ...spec } as Record<string, unknown>;
  for (const [part, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    next[part] =
      part === "source" || part === "healthcheck" || value === null
        ? value
        : { ...(spec[part as keyof ServiceConfigSpec] as object), ...(value as object) };
  }
  return next as unknown as ServiceConfigSpec;
}

function variableRow(
  environment: Environment,
  op: { scope: string; service?: string; key: string },
) {
  const owner = op.scope === "shared" ? environment.project_id : op.service;
  return db.deploy.variables.find(
    (v) =>
      v.scope === op.scope &&
      v.owner_id === owner &&
      v.environment_id === environment.id &&
      v.key === op.key,
  );
}

function draftOf(environmentId: string) {
  return db.changes.sets.find(
    (s) => s.environment_id === environmentId && s.is_draft && s.status === "open",
  );
}

function nameOf(set: DbChangeSet) {
  return (ref: string) => {
    const service = db.deploy.services.find((s) => s.id === ref);
    if (service) return service.slug;
    const create = set.changes.find((c) => c.op.type === "service.create" && c.op.ref === ref);
    return create && create.op.type === "service.create" ? (create.op.slug ?? create.op.name) : ref;
  };
}

function touch(set: DbChangeSet) {
  set.revision += 1;
  set.updated_at = Date.now();
  set.error = null;
  broadcastRealtime(set.project_id, { type: "change_set.updated", change_set: toSummary(set) });
}

// -----------------------------------------------------------------------------
// Staging
// -----------------------------------------------------------------------------

function prepare(
  set: DbChangeSet,
  environment: Environment,
  input: StagedOpInput,
): { op: StagedOp; diff: DbStagedChange["diff"]; base: number | null; value?: string } | Response {
  const pending = set.changes.filter((c) => c.status !== "applied");
  const live = (id: string) => liveServices(environment.project_id).find((s) => s.id === id);
  switch (input.type) {
    case "service.create": {
      // NOTE: the mock API doesn't render database services from the registry.
      if (!input.source) return apiError(400, "invalid_request", "Databases aren't mocked");
      const op = { ...input, kind: input.kind ?? "app" } as StagedOp;
      const spec = merge(
        defaultServiceConfig(input.source),
        (input.config ?? {}) as ServiceConfigPatch,
      );
      return {
        op,
        base: null,
        diff: [
          {
            path: "/service",
            before: null,
            after: {
              name: input.name,
              slug: input.slug ?? slugify(input.name, 40, "service"),
              kind: input.kind ?? "app",
            },
          },
          ...configDiff(null, spec),
        ],
      };
    }
    case "service.update": {
      const service = live(input.service_id);
      if (!service) return notFound("Service");
      const diff = (["name", "slug", "icon"] as const)
        .filter((f) => input[f] !== undefined)
        .map((f) => ({ path: `/${f}`, before: service[f], after: input[f] }));
      return { op: input as StagedOp, base: null, diff };
    }
    case "service.delete": {
      const service = live(input.service_id);
      if (!service) return notFound("Service");
      return {
        op: input,
        base: null,
        diff: [
          { path: "/service", before: { name: service.name, slug: service.slug }, after: null },
        ],
      };
    }
    case "config.patch": {
      if (isNewServiceRef(input.service)) {
        const create = pending.find(
          (c) => c.op.type === "service.create" && c.op.ref === input.service,
        );
        if (create?.op.type !== "service.create")
          return invalid(`No staged service is called ${input.service}`);
        const { source, ...rest } = input.patch as ServiceConfigPatch;
        return prepare(set, environment, {
          ...create.op,
          ...(source ? { source } : {}),
          config: mergeConfigPatches((create.op.config ?? {}) as ServiceConfigPatch, rest),
        } as StagedOpInput);
      }
      const service = live(input.service);
      if (!service) return notFound("Service");
      const prior = pending.find((c) => c.target_key === `config:${service.id}`);
      const patch =
        prior && prior.op.type === "config.patch"
          ? mergeConfigPatches(prior.op.patch, input.patch as ServiceConfigPatch)
          : (input.patch as ServiceConfigPatch);
      const base = prior?.base_version ?? latestConfig(service.id, environment.id)?.version ?? null;
      const config = base === null ? undefined : latestConfig(service.id, environment.id, base);
      if (!config) return notFound("Service config");
      const before = specOf(config);
      const after = merge(before, patch);
      if (after.deploy.replicas > 20)
        return invalid("deploy.replicas: Too big: expected number to be <=20");
      return {
        op: { type: "config.patch", service: service.id, patch },
        base: config.version,
        diff: configDiff(before, after),
      };
    }
    case "variable.set": {
      if (input.scope === "service" && !isNewServiceRef(input.service!) && !live(input.service!)) {
        return notFound("Service");
      }
      const prior = isNewServiceRef(input.service ?? "")
        ? undefined
        : variableRow(environment, input);
      const classification = classifyVariable(input.key, input.value);
      const decision = decideVariableTier({
        classification,
        ...(input.tier ? { requested: input.tier } : {}),
        ...(prior ? { previous: prior.tier } : {}),
        valueProvided: true,
      });
      if (!decision.ok) return apiError(400, decision.code, `${input.key}: ${decision.message}`);
      if (decision.tier === "secret" && prior?.tier !== "secret" && !input.confirm_write_only) {
        return apiError(
          400,
          "confirmation_required",
          `${input.key} will be write-only: nobody can read it back. Stage it with confirm_write_only to continue`,
          [{ field: input.key, code: "confirmation_required", message: "Becomes write-only" }],
        );
      }
      const fingerprint = mockFingerprint(input.value);
      const { value, ...rest } = input;
      const op = {
        ...rest,
        confirm_write_only: input.confirm_write_only ?? false,
        acknowledge_public: input.acknowledge_public ?? false,
        fingerprint,
        staged_tier: decision.tier,
      } as StagedOp;
      const priorStaged = pending.find((c) => c.target_key === targetKeyOf(op));
      return {
        op,
        value,
        base: priorStaged?.base_version ?? prior?.version ?? null,
        diff: [
          {
            path: `/variables/${input.key}`,
            before: prior ? { tier: prior.tier, fingerprint: mockFingerprint(prior.value) } : null,
            after: { tier: decision.tier, fingerprint },
          },
        ],
      };
    }
    case "variable.delete": {
      const prior = variableRow(environment, input);
      if (!prior) return notFound("Variable");
      return {
        op: input,
        base: prior.version,
        diff: [
          {
            path: `/variables/${input.key}`,
            before: { tier: prior.tier, fingerprint: mockFingerprint(prior.value) },
            after: null,
          },
        ],
      };
    }
    default:
      // NOTE: volume and domain ops are exercised against the real API, not this mock.
      return apiError(400, "invalid_request", `${input.type} isn't mocked`);
  }
}

function stageInto(
  set: DbChangeSet,
  scope: Extract<Scope, { ok: true }>,
  input: StagedOpInput,
  expectedRevision: number | undefined,
): Response | null {
  if (set.status !== "open") return closed(set);
  if (expectedRevision !== undefined && expectedRevision !== set.revision)
    return changed(set.revision);
  const action = opAction(input as StagedOp);
  if (!allows(scope.workspaceId, action)) return forbidden(scope.role, action);
  const prepared = prepare(set, scope.environment, input);
  if (prepared instanceof Response) return prepared;
  const pending = set.changes.filter((c) => c.status !== "applied");
  const result = stageOp(
    pending.map((c) => ({ target_key: c.target_key, op: c.op as StagedOp })),
    prepared.op,
  );
  if (!result.ok)
    return result.code === "too_many_ops"
      ? apiError(409, "conflict", result.message)
      : invalid(result.message);
  set.changes = set.changes.filter(
    (c) => !result.drop.includes(c.target_key) || c.status === "applied",
  );
  const now = Date.now();
  const existing = set.changes.find(
    (c) => c.target_key === result.entry.target_key && c.status !== "applied",
  );
  const describe = nameOf(set);
  const row: DbStagedChange = {
    id: existing?.id ?? nextId("stg"),
    seq: existing?.seq ?? set.changes.reduce((m, c) => Math.max(m, c.seq), 0) + 1,
    target_key: result.entry.target_key,
    op: result.entry.op as DbStagedChange["op"],
    summary: describeOp(result.entry.op, describe),
    diff: prepared.diff,
    status: "pending",
    conflict: null,
    created_by: scope.userId,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    base_version: prepared.base,
    ...(prepared.value !== undefined ? { value: prepared.value } : {}),
  };
  set.changes = existing
    ? set.changes.map((c) => (c === existing ? row : c))
    : [...set.changes, row];
  touch(set);
  return null;
}

function openSet(
  scope: Extract<Scope, { ok: true }>,
  fields: { is_draft: boolean; source: DbChangeSet["source"]; title: string | null },
): DbChangeSet {
  const now = Date.now();
  const set: DbChangeSet = {
    id: nextId("chs"),
    project_id: scope.environment.project_id,
    environment_id: scope.environment.id,
    status: "open",
    is_draft: fields.is_draft,
    source: fields.source,
    title: fields.title,
    revision: 1,
    created_by: scope.userId,
    created_by_token: null,
    applied_by: null,
    applied_at: null,
    error: null,
    created_at: now,
    updated_at: now,
    changes: [],
  };
  db.changes.sets.push(set);
  return set;
}

// -----------------------------------------------------------------------------
// Drift and apply
// -----------------------------------------------------------------------------

function drift(set: DbChangeSet, environment: Environment) {
  const conflicts: { id: string; conflict: NonNullable<DbStagedChange["conflict"]> }[] = [];
  const rebases: string[] = [];
  for (const change of set.changes) {
    if (change.status === "applied") continue;
    const op = change.op as StagedOp;
    if (op.type === "config.patch" && !isNewServiceRef(op.service)) {
      const latest = latestConfig(op.service, environment.id);
      if (!latest || latest.version === change.base_version) continue;
      const base =
        change.base_version === null
          ? undefined
          : latestConfig(op.service, environment.id, change.base_version);
      const theirs = configDiff(base ? specOf(base) : null, specOf(latest));
      const overlap = conflictingPointers(
        patchPointers(op.patch),
        theirs.map((d) => d.path),
      );
      if (overlap.length) {
        conflicts.push({
          id: change.id,
          conflict: {
            theirs: theirs.filter((d) => overlap.includes(d.path)),
            paths: overlap,
            base_version: change.base_version,
            current_version: latest.version,
          },
        });
      } else rebases.push(change.id);
    }
    if (
      (op.type === "variable.set" || op.type === "variable.delete") &&
      !isNewServiceRef(op.service ?? "")
    ) {
      const row = variableRow(environment, op);
      const now = row?.version ?? null;
      if (now !== change.base_version) {
        conflicts.push({
          id: change.id,
          conflict: {
            theirs: row ? { tier: row.tier, fingerprint: mockFingerprint(row.value) } : null,
            base_version: change.base_version,
            current_version: now,
          },
        });
      }
    }
  }
  return { conflicts, rebases };
}

function plannedDeploys(set: DbChangeSet, environment: Environment) {
  const live = liveServices(environment.project_id);
  const slugOf = new Map(live.map((s) => [s.id, s.slug]));
  const vars = (owner: string, scope: DbVariable["scope"]) =>
    Object.fromEntries(
      db.deploy.variables
        .filter(
          (v) => v.scope === scope && v.owner_id === owner && v.environment_id === environment.id,
        )
        .map((v) => [v.key, v.value]),
    );
  const services: Record<string, Record<string, string>> = {};
  for (const s of live) services[s.slug] = vars(s.id, "service");
  const changedVariables: string[] = [];
  const changedServices: string[] = [];
  const reasons = new Map<string, "config" | "variables" | "created">();
  for (const change of set.changes.filter((c) => c.status !== "applied")) {
    const op = change.op as StagedOp;
    if (op.type === "service.create") {
      const slug = op.slug ?? slugify(op.name, 40, "service");
      slugOf.set(op.ref, slug);
      services[slug] = {};
      changedServices.push(slug);
      reasons.set(slug, "created");
    }
  }
  for (const change of set.changes.filter((c) => c.status !== "applied")) {
    const op = change.op as StagedOp;
    if (op.type === "config.patch") {
      const slug = slugOf.get(op.service);
      if (slug) {
        changedServices.push(slug);
        if (!reasons.has(slug)) reasons.set(slug, "config");
      }
    }
    if (op.type === "variable.set" || op.type === "variable.delete") {
      const ns = op.scope === "shared" ? "shared" : slugOf.get(op.service ?? "");
      if (!ns) continue;
      if (ns !== "shared") {
        if (op.type === "variable.set") services[ns]![op.key] = change.value ?? "";
        else delete services[ns]![op.key];
        if (!reasons.has(ns)) reasons.set(ns, "variables");
      }
      changedVariables.push(`${ns}.${op.key}`);
    }
  }
  const idOf = new Map([...slugOf].map(([id, slug]) => [slug, id]));
  return affectedServices({
    services,
    shared: vars(environment.project_id, "shared"),
    changedVariables,
    changedServices,
  }).map((slug) => ({
    service: idOf.get(slug) ?? slug,
    name: live.find((s) => s.slug === slug)?.name ?? slug,
    reason: reasons.get(slug) ?? ("references" as const),
  }));
}

function applySet(
  set: DbChangeSet,
  scope: Extract<Scope, { ok: true }>,
  deploy: "affected" | "none",
): Response | { deployment_ids: string[]; skipped: { service_id: string; reason: string }[] } {
  const environment = scope.environment;
  const pending = set.changes.filter((c) => c.status !== "applied");
  if (!pending.length) return invalid("Nothing is staged");
  for (const change of pending) {
    const action = opAction(change.op as StagedOp);
    if (!allows(scope.workspaceId, action)) {
      return apiError(
        403,
        "forbidden",
        `You can't apply this change set: ${change.summary} needs ${action}`,
        [{ field: change.id, code: "forbidden", message: `${change.summary} needs ${action}` }],
      );
    }
  }
  const { conflicts } = drift(set, environment);
  if (conflicts.length) {
    for (const c of conflicts) {
      const row = set.changes.find((x) => x.id === c.id)!;
      row.status = "conflicted";
      row.conflict = c.conflict;
    }
    touch(set);
    return apiError(
      409,
      "change_set_conflict",
      `${conflicts.length} staged change${conflicts.length === 1 ? "" : "s"} conflict with changes made since; resolve them and review again`,
      conflicts.map((c) => ({
        field: c.id,
        code: "conflict",
        message: `${set.changes.find((x) => x.id === c.id)!.summary}: changed since it was staged`,
      })),
    );
  }
  const planned = plannedDeploys(set, environment);
  if (deploy === "affected" && planned.length && !allows(scope.workspaceId, "deployments:create")) {
    return forbidden(scope.role, "deployments:create");
  }

  const refs = new Map<string, string>();
  const now = Date.now();
  for (const change of pending) {
    const op = change.op as StagedOp;
    if (op.type === "service.create") {
      const taken = new Set(liveServices(environment.project_id).map((s) => s.slug));
      const service: Service = {
        id: nextId("svc"),
        project_id: environment.project_id,
        name: op.name,
        slug: freeSlug(taken, op.slug ?? slugify(op.name, 40, "service"), RESERVED_SERVICE_SLUGS),
        kind: op.kind,
        icon: op.icon ?? null,
        created_at: now,
        updated_at: now,
      };
      db.deploy.services.push(service);
      db.deploy.configs.push(
        ...createConfigs(
          service,
          op.source,
          (op.config ?? {}) as Record<string, Record<string, unknown>>,
          scope.userId,
        ),
      );
      refs.set(op.ref, service.id);
      recordAudit({
        workspaceId: scope.workspaceId,
        actorType: "user",
        actorId: scope.userId,
        action: "service.created",
        targetType: "service",
        targetId: service.id,
        metadata: {
          project_id: service.project_id,
          name: service.name,
          slug: service.slug,
          change_set_id: set.id,
        },
      });
    }
  }
  const resolve = (ref: string) => refs.get(ref) ?? ref;
  for (const change of pending) {
    const op = change.op as StagedOp;
    if (op.type === "config.patch") {
      const latest = latestConfig(op.service, environment.id);
      if (!latest) continue;
      db.deploy.configs.push({
        ...latest,
        ...merge(specOf(latest), op.patch),
        id: nextId("cfg"),
        version: latest.version + 1,
        created_by: scope.userId,
        created_at: now,
      });
      recordAudit({
        workspaceId: scope.workspaceId,
        actorType: "user",
        actorId: scope.userId,
        action: "service.updated",
        targetType: "service",
        targetId: op.service,
        metadata: {
          changes: Object.keys(op.patch),
          environment_id: environment.id,
          change_set_id: set.id,
        },
      });
    } else if (op.type === "service.update") {
      const service = db.deploy.services.find((s) => s.id === op.service_id);
      if (service)
        Object.assign(service, {
          ...(op.name ? { name: op.name } : {}),
          ...(op.slug ? { slug: op.slug } : {}),
          ...(op.icon !== undefined ? { icon: op.icon } : {}),
          updated_at: now,
        });
    } else if (op.type === "service.delete") {
      const service = db.deploy.services.find((s) => s.id === op.service_id);
      if (service) service.deleted = true;
      recordAudit({
        workspaceId: scope.workspaceId,
        actorType: "user",
        actorId: scope.userId,
        action: "service.deleted",
        targetType: "service",
        targetId: op.service_id,
        metadata: { change_set_id: set.id },
      });
    } else if (op.type === "variable.set" || op.type === "variable.delete") {
      const owner = op.scope === "shared" ? environment.project_id : resolve(op.service!);
      const existing = db.deploy.variables.find(
        (v) =>
          v.scope === op.scope &&
          v.owner_id === owner &&
          v.environment_id === environment.id &&
          v.key === op.key,
      );
      if (op.type === "variable.delete") {
        db.deploy.variables = db.deploy.variables.filter((v) => v !== existing);
      } else if (existing) {
        Object.assign(existing, {
          value: change.value ?? "",
          tier: op.staged_tier,
          version: existing.version + 1,
          updated_at: now,
          updated_by: scope.userId,
        });
      } else {
        db.deploy.variables.push({
          scope: op.scope,
          owner_id: owner,
          environment_id: environment.id,
          key: op.key,
          value: change.value ?? "",
          tier: op.staged_tier,
          locked: false,
          available_at_build: op.available_at_build ?? false,
          mount_as_file: op.mount_as_file ?? false,
          version: 1,
          updated_at: now,
          updated_by: scope.userId,
        });
      }
      recordAudit({
        workspaceId: scope.workspaceId,
        actorType: "user",
        actorId: scope.userId,
        action: "variables.updated",
        targetType: op.scope === "shared" ? "project" : "service",
        targetId: owner,
        metadata: {
          environment_id: environment.id,
          [op.type === "variable.set" ? "set" : "deleted"]: [op.key],
          change_set_id: set.id,
        },
      });
    }
    change.status = "applied";
    change.target_key = `applied:${change.id}`;
    delete change.value;
  }

  const deployment_ids: string[] = [];
  const skipped: { service_id: string; reason: string }[] = [];
  if (deploy === "affected") {
    for (const p of planned) {
      const service = db.deploy.services.find((s) => s.id === resolve(p.service) && !s.deleted);
      const config = service ? latestConfig(service.id, environment.id) : undefined;
      if (!service || !config) continue;
      if (config.deploy.replicas === 0) {
        skipped.push({
          service_id: service.id,
          reason: "The service has 0 replicas; scale it up before deploying",
        });
        continue;
      }
      const row = startDeployment(
        service,
        environment.id,
        config,
        undefined,
        "change_set",
        scope.userId,
      );
      announceDeployment(row);
      deployment_ids.push(row.id);
    }
  }
  set.status = "applied";
  set.applied_by = scope.userId;
  set.applied_at = now;
  set.revision += 1;
  set.updated_at = now;
  recordAudit({
    workspaceId: scope.workspaceId,
    actorType: "user",
    actorId: scope.userId,
    action: "change_set.applied",
    targetType: "change_set",
    targetId: set.id,
    metadata: { environment_id: environment.id, deploy, ops: pending.map((c) => c.summary) },
  });
  broadcastRealtime(set.project_id, {
    type: "change_set.applied",
    change_set_id: set.id,
    environment_id: environment.id,
    deployment_ids,
  });
  broadcastRealtime(set.project_id, { type: "change_set.updated", change_set: toSummary(set) });
  return { deployment_ids, skipped };
}

// -----------------------------------------------------------------------------
// Canvas
// -----------------------------------------------------------------------------

function canvasOf(environment: Environment) {
  const projectId = environment.project_id;
  const live = liveServices(projectId);
  const draft = draftOf(environment.id);
  const pending = draft?.changes.filter((c) => c.status !== "applied") ?? [];
  const nodes = live.map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    kind: s.kind,
    icon: s.icon,
    staged: null as "create" | "update" | "delete" | null,
    staged_ops: 0,
    database: null,
    volume: null,
    domains: [],
  }));
  for (const c of pending) {
    const op = c.op as StagedOp;
    if (op.type === "service.create") {
      nodes.push({
        id: op.ref,
        name: op.name,
        slug: op.slug ?? slugify(op.name, 40, "service"),
        kind: op.kind,
        icon: op.icon ?? null,
        staged: "create",
        staged_ops: 0,
        database: null,
        volume: null,
        domains: [],
      });
    }
  }
  for (const c of pending) {
    const id = serviceOfOp(c.op as StagedOp);
    const node = nodes.find((n) => n.id === id);
    if (!node) continue;
    node.staged_ops += 1;
    if (c.op.type === "service.delete") node.staged = "delete";
    else if (node.staged === null) node.staged = "update";
  }
  const values = (ownerId: string) =>
    Object.fromEntries(
      db.deploy.variables
        .filter(
          (v) =>
            v.scope === "service" && v.owner_id === ownerId && v.environment_id === environment.id,
        )
        .map((v) => [v.key, v.value]),
    );
  const before: Record<string, Record<string, string>> = {};
  const idOf = new Map<string, string>();
  for (const s of live) {
    before[s.slug] = values(s.id);
    idOf.set(s.slug, s.id);
  }
  const after: Record<string, Record<string, string>> = structuredClone(before);
  for (const n of nodes) {
    if (n.staged === "create") {
      after[n.slug] = {};
      idOf.set(n.slug, n.id);
    }
  }
  for (const c of pending) {
    const op = c.op as StagedOp;
    if ((op.type === "variable.set" || op.type === "variable.delete") && op.scope === "service") {
      const slug = nodes.find((n) => n.id === op.service)?.slug;
      if (!slug || !after[slug]) continue;
      if (op.type === "variable.set") after[slug]![op.key] = c.value ?? "";
      else delete after[slug]![op.key];
    }
  }
  const edges = new Map<
    string,
    { from: string; to: string; variables: Set<string>; before: boolean; after: boolean }
  >();
  const add = (graph: Record<string, Record<string, string>>, side: "before" | "after") => {
    for (const d of variableDependencies(graph)) {
      const from = idOf.get(d.from);
      const to = idOf.get(d.to);
      if (!from || !to) continue;
      const key = `${from}->${to}`;
      const edge = edges.get(key) ?? {
        from,
        to,
        variables: new Set(),
        before: false,
        after: false,
      };
      for (const v of d.variables) edge.variables.add(v);
      edge[side] = true;
      edges.set(key, edge);
    }
  };
  add(before, "before");
  add(after, "after");
  const layout = db.changes.layouts[projectId] ?? { positions: {}, version: 0 };
  return {
    project_id: projectId,
    environment_id: environment.id,
    environment_protected: false,
    environment_requires_approval: false,
    staging: true,
    nodes,
    edges: [...edges].map(([id, e]) => {
      const variables = [...e.variables].sort();
      return {
        id,
        from: e.from,
        to: e.to,
        kind: variables.some((v) => v.endsWith(".ROUNDHOUSE_PRIVATE_DOMAIN"))
          ? ("private_network" as const)
          : ("reference" as const),
        variables,
        state:
          e.before && e.after
            ? ("current" as const)
            : e.after
              ? ("staged" as const)
              : ("removed" as const),
      };
    }),
    positions: Object.fromEntries(
      Object.entries(layout.positions).filter(([id]) => live.some((s) => s.id === id)),
    ),
    layout_version: layout.version,
    draft: draft ? toSummary(draft) : null,
  };
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

/** Canvas and change set handlers, in the order of `CHANGE_ROUTES`. */
export const changeHandlers = [
  http.get(mswPath("getCanvas"), async ({ request, params }) => {
    const input = await validate<unknown, { environment_id: string }>("getCanvas", request, params);
    if (!input.ok) return input.response;
    const project = db.deploy.projects.find((p) => p.id === input.params.projectId && !p.deleted);
    if (!currentUser()) return unauthorized();
    if (!project) return notFound("Project");
    const guard = requireWorkspace(project.workspace_id, actionOf("getCanvas"));
    if (!guard.ok) return guard.response.status === 404 ? notFound("Project") : guard.response;
    const environment = db.deploy.environments.find(
      (e) => e.id === input.query.environment_id && e.project_id === project.id,
    );
    if (!environment) return notFound("Environment");
    return HttpResponse.json(canvasOf(environment));
  }),

  http.patch(mswPath("updateCanvasLayout"), async ({ request, params }) => {
    const input = await validate<{
      positions: Record<string, { x: number; y: number } | null>;
      expected_version: number;
    }>("updateCanvasLayout", request, params);
    if (!input.ok) return input.response;
    const project = db.deploy.projects.find((p) => p.id === input.params.projectId && !p.deleted);
    if (!currentUser()) return unauthorized();
    if (!project) return notFound("Project");
    const guard = requireWorkspace(project.workspace_id, actionOf("updateCanvasLayout"));
    if (!guard.ok) return guard.response.status === 404 ? notFound("Project") : guard.response;
    const stored = db.changes.layouts[project.id] ?? { positions: {}, version: 0 };
    if (stored.version !== input.body.expected_version) {
      return apiError(
        409,
        "conflict",
        `The layout changed; it is at version ${stored.version}. Reload and try again`,
      );
    }
    const live = new Set(liveServices(project.id).map((s) => s.id));
    const positions: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of Object.entries({ ...stored.positions, ...input.body.positions })) {
      if (p && live.has(id)) positions[id] = { x: Math.round(p.x), y: Math.round(p.y) };
    }
    const next = { positions, version: stored.version + 1 };
    db.changes.layouts[project.id] = next;
    broadcastRealtime(project.id, {
      type: "canvas.layout_updated",
      positions,
      version: next.version,
      by_user_id: guard.user.id,
    });
    return HttpResponse.json(next);
  }),

  http.get(mswPath("listChangeSets"), async ({ request, params }) => {
    const input = await validate<unknown, { status: "open" | "all" }>(
      "listChangeSets",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const scope = environmentScope(input.params.environmentId ?? "", actionOf("listChangeSets"));
    if (!scope.ok) return scope.response;
    const sets = db.changes.sets
      .filter(
        (s) =>
          s.environment_id === scope.environment.id &&
          (input.query.status === "all" || s.status === "open" || s.status === "applying"),
      )
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    return HttpResponse.json({ change_sets: sets.map(toSummary) });
  }),

  http.post(mswPath("createChangeSet"), async ({ request, params }) => {
    const input = await validate<{
      title?: string;
      source: DbChangeSet["source"];
      ops: StagedOpInput[];
    }>("createChangeSet", request, params);
    if (!input.ok) return input.response;
    const scope = environmentScope(input.params.environmentId ?? "", actionOf("createChangeSet"));
    if (!scope.ok) return scope.response;
    const set = openSet(scope, {
      is_draft: false,
      source: input.body.source,
      title: input.body.title ?? null,
    });
    for (const op of input.body.ops) {
      const refused = stageInto(set, scope, op, undefined);
      if (refused) {
        db.changes.sets = db.changes.sets.filter((s) => s !== set);
        return refused;
      }
    }
    recordAudit({
      workspaceId: scope.workspaceId,
      actorType: "user",
      actorId: scope.userId,
      action: "change_set.created",
      targetType: "change_set",
      targetId: set.id,
      metadata: { environment_id: scope.environment.id, ops: input.body.ops.length },
    });
    return HttpResponse.json(toChangeSet(set), { status: 201 });
  }),

  http.get(mswPath("getDraft"), async ({ request, params }) => {
    const input = await validate("getDraft", request, params);
    if (!input.ok) return input.response;
    const scope = environmentScope(input.params.environmentId ?? "", actionOf("getDraft"));
    if (!scope.ok) return scope.response;
    const draft = draftOf(scope.environment.id);
    return HttpResponse.json({ change_set: draft ? toChangeSet(draft) : null });
  }),

  http.post(mswPath("stageDraftOp"), async ({ request, params }) => {
    const input = await validate<{ op: StagedOpInput; expected_revision?: number }>(
      "stageDraftOp",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const scope = environmentScope(input.params.environmentId ?? "", actionOf("stageDraftOp"));
    if (!scope.ok) return scope.response;
    const action = opAction(input.body.op as StagedOp);
    if (!allows(scope.workspaceId, action)) return forbidden(scope.role, action);
    const set =
      draftOf(scope.environment.id) ??
      openSet(scope, { is_draft: true, source: "dashboard", title: null });
    const refused = stageInto(set, scope, input.body.op, input.body.expected_revision);
    return refused ?? HttpResponse.json(toChangeSet(set));
  }),

  http.get(mswPath("getChangeSet"), async ({ request, params }) => {
    const input = await validate("getChangeSet", request, params);
    if (!input.ok) return input.response;
    const scope = setScope(input.params.changeSetId ?? "", actionOf("getChangeSet"));
    if (!scope.ok) return scope.response;
    return HttpResponse.json(toChangeSet(scope.set));
  }),

  http.get(mswPath("reviewChangeSet"), async ({ request, params }) => {
    const input = await validate("reviewChangeSet", request, params);
    if (!input.ok) return input.response;
    const scope = setScope(input.params.changeSetId ?? "", actionOf("reviewChangeSet"));
    if (!scope.ok) return scope.response;
    const { conflicts, rebases } = drift(scope.set, scope.environment);
    return HttpResponse.json({
      change_set: toChangeSet(scope.set),
      rebases,
      conflicts,
      deploys: plannedDeploys(scope.set, scope.environment),
      approval: { required: false, approved: false, authors: [] },
    });
  }),

  http.post(mswPath("stageOp"), async ({ request, params }) => {
    const input = await validate<{ op: StagedOpInput; expected_revision?: number }>(
      "stageOp",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const scope = setScope(input.params.changeSetId ?? "", actionOf("stageOp"));
    if (!scope.ok) return scope.response;
    const refused = stageInto(scope.set, scope, input.body.op, input.body.expected_revision);
    return refused ?? HttpResponse.json(toChangeSet(scope.set));
  }),

  http.delete(mswPath("unstageOp"), async ({ request, params }) => {
    const input = await validate<unknown, { expected_revision?: number }>(
      "unstageOp",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const scope = setScope(input.params.changeSetId ?? "", actionOf("unstageOp"));
    if (!scope.ok) return scope.response;
    const set = scope.set;
    if (set.status !== "open") return closed(set);
    if (
      input.query.expected_revision !== undefined &&
      input.query.expected_revision !== set.revision
    ) {
      return changed(set.revision);
    }
    const row = set.changes.find((c) => c.id === input.params.opId && c.status !== "applied");
    if (!row) return notFound("Staged change");
    const action = opAction(row.op as StagedOp);
    if (!allows(scope.workspaceId, action)) return forbidden(scope.role, action);
    const ref = row.op.type === "service.create" ? row.op.ref : null;
    set.changes = set.changes.filter(
      (c) =>
        c !== row &&
        (ref === null || serviceOfOp(c.op as StagedOp) !== ref || c.status === "applied"),
    );
    touch(set);
    return HttpResponse.json(toChangeSet(set));
  }),

  http.post(mswPath("resolveOp"), async ({ request, params }) => {
    const input = await validate<{ keep: "mine" | "theirs"; expected_revision: number }>(
      "resolveOp",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const scope = setScope(input.params.changeSetId ?? "", actionOf("resolveOp"));
    if (!scope.ok) return scope.response;
    const set = scope.set;
    if (set.status !== "open") return closed(set);
    if (input.body.expected_revision !== set.revision) return changed(set.revision);
    const row = set.changes.find((c) => c.id === input.params.opId);
    if (!row) return notFound("Staged change");
    if (row.status !== "conflicted")
      return apiError(409, "conflict", "That change has no conflict");
    if (input.body.keep === "theirs") {
      set.changes = set.changes.filter((c) => c !== row);
    } else {
      const op = row.op as StagedOp;
      if (op.type === "config.patch") {
        const latest = latestConfig(op.service, scope.environment.id);
        if (latest) {
          row.base_version = latest.version;
          row.diff = configDiff(specOf(latest), merge(specOf(latest), op.patch));
        }
      } else if (op.type === "variable.set" || op.type === "variable.delete") {
        row.base_version = variableRow(scope.environment, op)?.version ?? null;
      }
      row.status = "pending";
      row.conflict = null;
    }
    touch(set);
    return HttpResponse.json(toChangeSet(set));
  }),

  http.post(mswPath("applyChangeSet"), async ({ request, params }) => {
    const input = await validate<{ expected_revision: number; deploy: "affected" | "none" }>(
      "applyChangeSet",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const scope = setScope(input.params.changeSetId ?? "", actionOf("applyChangeSet"));
    if (!scope.ok) return scope.response;
    const set = scope.set;
    if (set.status !== "open") return closed(set);
    if (input.body.expected_revision !== set.revision) return changed(set.revision);
    const result = applySet(set, scope, input.body.deploy);
    if (result instanceof Response) return result;
    return HttpResponse.json({ change_set: toChangeSet(set), ...result });
  }),

  http.post(mswPath("discardChangeSet"), async ({ request, params }) => {
    const input = await validate<{ expected_revision?: number }>(
      "discardChangeSet",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const scope = setScope(input.params.changeSetId ?? "", actionOf("discardChangeSet"));
    if (!scope.ok) return scope.response;
    const set = scope.set;
    if (
      !allows(scope.workspaceId, "services:manage") &&
      !allows(scope.workspaceId, "variables:manage")
    ) {
      return forbidden(scope.role, "services:manage");
    }
    if (set.status !== "open") return closed(set);
    if (
      input.body.expected_revision !== undefined &&
      input.body.expected_revision !== set.revision
    ) {
      return changed(set.revision);
    }
    const ops = set.changes.filter((c) => c.status !== "applied").map((c) => c.summary);
    for (const c of set.changes) delete c.value;
    set.status = "discarded";
    touch(set);
    recordAudit({
      workspaceId: scope.workspaceId,
      actorType: "user",
      actorId: scope.userId,
      action: "change_set.discarded",
      targetType: "change_set",
      targetId: set.id,
      metadata: { environment_id: scope.environment.id, ops },
    });
    return HttpResponse.json(toChangeSet(set));
  }),
];

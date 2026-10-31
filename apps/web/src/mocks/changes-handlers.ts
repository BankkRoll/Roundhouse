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
 * writes configs, services, variables, volumes and custom domains, deploys the affected
 * services and records the API's audit entries.
 *
 * Review mirrors `apps/api/src/lib/changes/review.ts`: submitting asks for a review,
 * approving or rejecting binds the set's revision and is refused to its authors
 * (`self_review`), and any later edit (stage, unstage, resolve, rebase) moves an approved
 * or rejected set back to `submitted`. Applying refuses a rejected set (409
 * `change_set_rejected`) and, where the environment requires approval (see
 * {@link requireApprovalIn}), a set not approved at its revision (403
 * `approval_required`) or one the applier approved (403 `forbidden`).
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
  MAX_SERVICE_EDGES,
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
  VOLUME_DELETE_GRACE_MS,
  variableDependencies,
} from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import { CHANGE_ROUTES, policyOf, type ServiceEdge } from "../../../api/src/contracts";
import type { CanvasNode, StagedOpInput } from "../lib/api/changes-types";
import type { Volume } from "../lib/api/data-client";
import type { Environment, Service, ServiceConfig } from "../lib/api/deploy-types";
import {
  type DbChangeSet,
  type DbStagedChange,
  hasValidApproval,
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
import { makeVolume } from "./data-db";
import { db, nextId } from "./db";
import type { DbVariable } from "./deploy-db";
import {
  announceDeployment,
  broadcastRealtime,
  createConfigs,
  startDeployment,
} from "./deploy-handlers";
import { checkCustomHostname, hostnameTaken, newCustomDomain } from "./domains-mock";
import { syncCertificates } from "./tls-mock";

// -----------------------------------------------------------------------------
// Approval knob
// -----------------------------------------------------------------------------

/**
 * Makes applying change sets in an environment need an approval, as `PUT
 * /v1/environments/{id}/protection` with `require_approval: true` would. The
 * environment is marked protected too, since the setting only counts on protected
 * environments. Call it after `resetDb()`; the next reset turns it off.
 *
 * @param environmentId - Environment id, e.g. `SEED.production`.
 * @param required - `false` turns it off again.
 * @example
 * resetDb();
 * requireApprovalIn(SEED.production);
 */
export function requireApprovalIn(environmentId: string, required = true): void {
  db.changes.requireApproval[environmentId] = required;
  const environment = db.deploy.environments.find((e) => e.id === environmentId);
  if (environment && required) environment.protected = true;
}

function requiresApproval(environment: Environment): boolean {
  return environment.protected && db.changes.requireApproval[environment.id] === true;
}

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

function projectScope(
  projectId: string,
  action: Action,
):
  | { ok: true; project: (typeof db.deploy.projects)[number]; userId: string }
  | { ok: false; response: Response } {
  if (!currentUser()) return { ok: false, response: unauthorized() };
  const project = db.deploy.projects.find((p) => p.id === projectId && !p.deleted);
  if (!project) return { ok: false, response: notFound("Project") };
  const guard = requireWorkspace(project.workspace_id, action);
  if (!guard.ok) {
    return {
      ok: false,
      response: guard.response.status === 404 ? notFound("Project") : guard.response,
    };
  }
  return { ok: true, project, userId: guard.user.id };
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

function publish(set: DbChangeSet) {
  broadcastRealtime(set.project_id, { type: "change_set.updated", change_set: toSummary(set) });
}

/** Mirrors the API's `bumpRevision`: an edit voids any review decision. */
function touch(set: DbChangeSet) {
  set.revision += 1;
  set.updated_at = Date.now();
  set.error = null;
  if (set.review_status && set.review_status !== "none") set.review_status = "submitted";
  set.approved_by = null;
  set.approved_at = null;
  set.approved_revision = null;
  set.rejected_by = null;
  set.rejected_at = null;
  publish(set);
}

/** Who opened the set or staged one of its pending ops: none of them may review it. */
function authorsOf(set: DbChangeSet): string[] {
  const ids = new Set<string>();
  if (set.created_by) ids.add(set.created_by);
  for (const c of set.changes) if (c.status !== "applied" && c.created_by) ids.add(c.created_by);
  return [...ids].sort();
}

function canEdit(workspaceId: string): boolean {
  return allows(workspaceId, "services:manage") || allows(workspaceId, "variables:manage");
}

const cannotEdit = () =>
  apiError(403, "forbidden", "Editing staged changes needs services:manage or variables:manage");

const nothingStaged = () => apiError(409, "conflict", "Nothing is staged in this change set");

function volumeOf(serviceId: string, environmentId: string): Volume | undefined {
  return db.data.volumes.find(
    (v) =>
      v.service_id === serviceId &&
      v.environment_id === environmentId &&
      v.status !== "deleted" &&
      v.status !== "abandoned",
  );
}

function volumeDiff(
  current: Volume | undefined,
  after: { mount_path: string; size_mb: number } | null,
): DbStagedChange["diff"] {
  if (current && after) {
    return [{ path: "/volume/size_mb", before: current.size_mb, after: after.size_mb }];
  }
  return [
    {
      path: "/volume",
      before: current ? { mount_path: current.mount_path, size_mb: current.size_mb } : null,
      after,
    },
  ];
}

const volumeScheduledForDeletion = () =>
  apiError(
    409,
    "conflict",
    "The service's volume is scheduled for deletion; undelete it before changing it",
  );

// -----------------------------------------------------------------------------
// Staging
// -----------------------------------------------------------------------------

function prepare(
  set: DbChangeSet,
  environment: Environment,
  input: StagedOpInput,
):
  | {
      op: StagedOp;
      diff: DbStagedChange["diff"];
      base: number | null;
      value?: string;
      /** Instead of staging, take out the staged op with this target key. */
      unstage?: string;
    }
  | Response {
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
    case "volume.set": {
      const service = live(input.service);
      if (!service) return notFound("Service");
      const current = volumeOf(service.id, environment.id);
      if (current?.status === "pending_deletion") return volumeScheduledForDeletion();
      if (current) {
        if (input.mount_path !== undefined && input.mount_path !== current.mount_path) {
          return invalid(
            `A volume's mount path can't change; it is mounted at ${current.mount_path}`,
          );
        }
        if (input.size_mb < current.size_mb) {
          return apiError(
            422,
            "volume_shrink_unsupported",
            `Volumes only grow; it is ${current.size_mb} MiB`,
          );
        }
        if (input.size_mb === current.size_mb) {
          return invalid(`The volume already is ${current.size_mb} MiB`);
        }
      } else {
        if (!input.mount_path) return invalid("mount_path: Required for a new volume");
        if ((latestConfig(service.id, environment.id)?.deploy.replicas ?? 1) > 1) {
          return apiError(
            422,
            "volume_requires_single_replica",
            "A service with a volume runs at most one replica",
          );
        }
      }
      const mountPath = current?.mount_path ?? input.mount_path!;
      return {
        op: {
          type: "volume.set",
          service: service.id,
          size_mb: input.size_mb,
          ...(current ? {} : { mount_path: mountPath }),
        },
        base: null,
        diff: volumeDiff(current, { mount_path: mountPath, size_mb: input.size_mb }),
      };
    }
    case "volume.delete": {
      const service = live(input.service);
      if (!service) return notFound("Service");
      const op: StagedOp = { type: "volume.delete", service: service.id };
      const key = targetKeyOf(op);
      const current = volumeOf(service.id, environment.id);
      if (!current || current.status === "pending_deletion") {
        // Deleting a volume that is only staged takes the staged one out.
        if (pending.some((c) => c.target_key === key && c.op.type === "volume.set")) {
          return { op, base: null, diff: [], unstage: key };
        }
        return current ? volumeScheduledForDeletion() : notFound("Volume");
      }
      return { op, base: null, diff: volumeDiff(current, null) };
    }
    case "domain.add": {
      const service = live(input.service);
      if (!service) return notFound("Service");
      const checked = checkCustomHostname(input.hostname);
      if (checked instanceof Response) return checked;
      const { hostname } = checked;
      const op: StagedOp = { type: "domain.add", service: service.id, hostname };
      const prior = pending.find((c) => c.target_key === targetKeyOf(op));
      if (prior?.op.type === "domain.remove" && prior.op.service === service.id) {
        // Adding back a domain staged for removal just keeps it.
        return { op, base: null, diff: [], unstage: prior.target_key };
      }
      const taken = hostnameTaken(hostname);
      if (taken) return taken;
      return {
        op,
        base: null,
        diff: [{ path: `/domains/${hostname}`, before: null, after: { hostname } }],
      };
    }
    case "domain.remove": {
      const domain = db.deploy.domains.find((d) => d.id === input.domain_id);
      if (!domain || domain.environment_id !== environment.id) return notFound("Domain");
      if (!live(domain.service_id)) return notFound("Service");
      if (domain.type !== "custom") {
        return apiError(409, "conflict", "Turn off the generated domain under Networking instead");
      }
      return {
        op: {
          type: "domain.remove",
          domain_id: domain.id,
          hostname: domain.hostname,
          service: domain.service_id,
        },
        base: null,
        diff: [
          {
            path: `/domains/${domain.hostname}`,
            before: { hostname: domain.hostname, status: domain.status },
            after: null,
          },
        ],
      };
    }
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
  if (prepared.unstage !== undefined) {
    set.changes = set.changes.filter(
      (c) => c.target_key !== prepared.unstage || c.status === "applied",
    );
    touch(set);
    return null;
  }
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

/** Moves an op onto the current state: new base, recomputed diff, no conflict. */
function rebaseRow(row: DbStagedChange, environment: Environment) {
  const op = row.op as StagedOp;
  if (op.type === "config.patch") {
    const latest = latestConfig(op.service, environment.id);
    if (latest) {
      row.base_version = latest.version;
      row.diff = configDiff(specOf(latest), merge(specOf(latest), op.patch));
    }
  } else if (op.type === "variable.set" || op.type === "variable.delete") {
    row.base_version = variableRow(environment, op)?.version ?? null;
  }
  row.status = "pending";
  row.conflict = null;
  row.updated_at = Date.now();
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
  const reasons = new Map<string, "config" | "variables" | "created" | "volume">();
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
    // Only a new deployment mounts a new volume; growing one needs none.
    if (op.type === "volume.set" && !volumeOf(op.service, environment.id)) {
      const slug = slugOf.get(op.service);
      if (slug) {
        changedServices.push(slug);
        if (!reasons.has(slug)) reasons.set(slug, "volume");
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

/** Mirrors the API's `applyBlocker` for a signed-in person (the mock has no token callers). */
function applyBlocker(set: DbChangeSet, environment: Environment, userId: string): Response | null {
  if (set.review_status === "rejected") {
    return apiError(
      409,
      "change_set_rejected",
      "This change set was rejected; change it, or ask for another review, first",
    );
  }
  if (!requiresApproval(environment)) return null;
  if (!hasValidApproval(set)) {
    return apiError(
      403,
      "approval_required",
      `${environment.name} requires an approval before changes apply; submit the change set for review`,
    );
  }
  if (set.approved_by === userId) {
    return apiError(
      403,
      "forbidden",
      "You approved this change set, so someone else must apply it",
    );
  }
  return null;
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
  const blocked = applyBlocker(set, environment, scope.userId);
  if (blocked) return blocked;
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
        health: "ok",
        health_reason: null,
        health_node: null,
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
          available_at_build: op.available_at_build ?? existing.available_at_build,
          mount_as_file: op.mount_as_file ?? existing.mount_as_file,
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
    } else if (op.type === "volume.set") {
      const current = volumeOf(op.service, environment.id);
      if (current) {
        Object.assign(current, { size_mb: op.size_mb, updated_at: now });
      } else {
        db.data.volumes.push(
          makeVolume({
            id: nextId("vol"),
            project_id: environment.project_id,
            environment_id: environment.id,
            service_id: op.service,
            mount_path: op.mount_path ?? "/data",
            size_mb: op.size_mb,
          }),
        );
      }
    } else if (op.type === "volume.delete") {
      const current = volumeOf(op.service, environment.id);
      if (current) {
        Object.assign(current, {
          status: "pending_deletion",
          delete_after: now + VOLUME_DELETE_GRACE_MS,
          updated_at: now,
        });
      }
    } else if (op.type === "domain.add") {
      const port = latestConfig(op.service, environment.id)?.networking.port ?? 8080;
      const domain = newCustomDomain(op.service, environment.id, op.hostname, port);
      db.deploy.domains.push(domain);
      syncCertificates(now);
      recordAudit({
        workspaceId: scope.workspaceId,
        actorType: "user",
        actorId: scope.userId,
        action: "domain.added",
        targetType: "domain",
        targetId: domain.id,
        metadata: { hostname: domain.hostname, change_set_id: set.id },
      });
    } else if (op.type === "domain.remove") {
      db.deploy.domains = db.deploy.domains.filter((d) => d.id !== op.domain_id);
      syncCertificates(now);
      recordAudit({
        workspaceId: scope.workspaceId,
        actorType: "user",
        actorId: scope.userId,
        action: "domain.removed",
        targetType: "domain",
        targetId: op.domain_id,
        metadata: { hostname: op.hostname, change_set_id: set.id },
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
  // The API's apply lock bumps the revision without changing an op, so an approval of
  // the reviewed revision follows it.
  if (set.approved_revision === set.revision) set.approved_revision = set.revision + 1;
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
  const nodes: CanvasNode[] = live.map((s) => {
    const volume = volumeOf(s.id, environment.id);
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      kind: s.kind,
      icon: s.icon,
      staged: null,
      staged_ops: 0,
      database: s.database ? { engine: s.database.engine, version: s.database.version } : null,
      volume: volume
        ? {
            id: volume.id,
            mount_path: volume.mount_path,
            size_mb: volume.size_mb,
            status: volume.status,
            delete_after: volume.delete_after,
            staged: null,
            staged_size_mb: null,
          }
        : null,
      domains: db.deploy.domains
        .filter(
          (d) =>
            d.service_id === s.id && d.environment_id === environment.id && d.type === "custom",
        )
        .sort((a, b) => (a.hostname < b.hostname ? -1 : 1))
        .map((d) => ({ id: d.id, hostname: d.hostname, status: d.status, staged: null })),
    };
  });
  for (const c of pending) {
    const op = c.op as StagedOp;
    if (op.type === "service.create") {
      const database = op.database;
      nodes.push({
        id: op.ref,
        name: op.name,
        slug: op.slug ?? slugify(op.name, 40, "service"),
        kind: op.kind,
        icon: op.icon ?? null,
        staged: "create",
        staged_ops: 0,
        database: database ? { engine: database.engine, version: database.version } : null,
        volume: database
          ? {
              id: null,
              mount_path: "",
              size_mb: database.size_mb,
              status: null,
              delete_after: null,
              staged: "create",
              staged_size_mb: database.size_mb,
            }
          : null,
        domains: [],
      });
    }
  }
  for (const c of pending) {
    const op = c.op as StagedOp;
    const id = serviceOfOp(op);
    const node = nodes.find((n) => n.id === id);
    if (!node) continue;
    node.staged_ops += 1;
    if (op.type === "service.delete") node.staged = "delete";
    else if (node.staged === null) node.staged = "update";
    if (op.type === "volume.set") {
      node.volume = node.volume
        ? { ...node.volume, staged: "resize", staged_size_mb: op.size_mb }
        : {
            id: null,
            mount_path: op.mount_path ?? "",
            size_mb: op.size_mb,
            status: null,
            delete_after: null,
            staged: "create",
            staged_size_mb: op.size_mb,
          };
    } else if (op.type === "volume.delete" && node.volume) {
      node.volume = { ...node.volume, staged: "delete" };
    } else if (op.type === "domain.add") {
      node.domains.push({ id: null, hostname: op.hostname, status: null, staged: "add" });
    } else if (op.type === "domain.remove") {
      const domain = node.domains.find((d) => d.id === op.domain_id);
      if (domain) domain.staged = "remove";
    }
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
  const workspaceId = db.deploy.projects.find((p) => p.id === projectId)?.workspace_id;
  const workspace = db.workspaces.find((w) => w.id === workspaceId);
  const liveIds = new Set(live.map((s) => s.id));
  return {
    project_id: projectId,
    environment_id: environment.id,
    environment_protected: environment.protected,
    environment_requires_approval: requiresApproval(environment),
    // NOTE: Seeded workspaces leave the flag unset and stage, like `GET /v1/workspaces/{id}`.
    staging: workspace?.staged_changes ?? true,
    nodes,
    edges: [
      ...edgesOf(edges),
      ...db.changes.edges
        .filter(
          (e) =>
            e.project_id === projectId &&
            liveIds.has(e.from_service_id) &&
            liveIds.has(e.to_service_id),
        )
        .map((e) => ({
          id: e.id,
          from: e.from_service_id,
          to: e.to_service_id,
          kind: "explicit" as const,
          variables: [],
          state: "current" as const,
        })),
    ],
    positions: Object.fromEntries(
      Object.entries(layout.positions).filter(([id]) => live.some((s) => s.id === id)),
    ),
    layout_version: layout.version,
    draft: draft ? toSummary(draft) : null,
  };
}

function edgesOf(
  edges: Map<
    string,
    { from: string; to: string; variables: Set<string>; before: boolean; after: boolean }
  >,
) {
  return [...edges].map(([id, e]) => {
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
  });
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
    return HttpResponse.json({
      change_sets: sets.map(toSummary),
      environment_requires_approval: requiresApproval(scope.environment),
    });
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
      approval: {
        required: requiresApproval(scope.environment),
        approved: hasValidApproval(scope.set),
        authors: authorsOf(scope.set),
      },
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
      rebaseRow(row, scope.environment);
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

  http.post(mswPath("submitChangeSet"), async ({ request, params }) => {
    const input = await validate<{ expected_revision?: number; note?: string }>(
      "submitChangeSet",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const scope = setScope(input.params.changeSetId ?? "", actionOf("submitChangeSet"));
    if (!scope.ok) return scope.response;
    if (!canEdit(scope.workspaceId)) return cannotEdit();
    const set = scope.set;
    if (set.status !== "open") return closed(set);
    if (
      input.body.expected_revision !== undefined &&
      input.body.expected_revision !== set.revision
    ) {
      return changed(set.revision);
    }
    const pending = set.changes.filter((c) => c.status !== "applied");
    if (!pending.length) return nothingStaged();
    // Submitting twice is harmless: a set waiting for (or holding) a decision stays as is.
    if (set.review_status !== "submitted" && !hasValidApproval(set)) {
      const now = Date.now();
      Object.assign(set, {
        review_status: "submitted",
        submitted_by: scope.userId,
        submitted_at: now,
        rejected_by: null,
        rejected_at: null,
        review_note: input.body.note ?? null,
        updated_at: now,
      });
      recordAudit({
        workspaceId: scope.workspaceId,
        actorType: "user",
        actorId: scope.userId,
        action: "change_set.submitted",
        targetType: "change_set",
        targetId: set.id,
        metadata: {
          project_id: set.project_id,
          environment_id: set.environment_id,
          revision: set.revision,
          ops: pending.map((c) => c.summary),
        },
      });
    }
    publish(set);
    return HttpResponse.json(toChangeSet(set));
  }),

  decide("approve"),
  decide("reject"),

  http.post(mswPath("rebaseChangeSet"), async ({ request, params }) => {
    const input = await validate<{ expected_revision: number }>("rebaseChangeSet", request, params);
    if (!input.ok) return input.response;
    const scope = setScope(input.params.changeSetId ?? "", actionOf("rebaseChangeSet"));
    if (!scope.ok) return scope.response;
    if (!canEdit(scope.workspaceId)) return cannotEdit();
    const set = scope.set;
    if (set.status !== "open") return closed(set);
    if (input.body.expected_revision !== set.revision) return changed(set.revision);
    const { conflicts, rebases } = drift(set, scope.environment);
    const settled = new Set([...conflicts.map((c) => c.id), ...rebases]);
    const cleared = set.changes.filter((c) => c.status === "conflicted" && !settled.has(c.id));
    const fresh = conflicts.filter((c) => {
      const row = set.changes.find((x) => x.id === c.id);
      return (
        row?.status !== "conflicted" || JSON.stringify(row.conflict) !== JSON.stringify(c.conflict)
      );
    });
    if (rebases.length || cleared.length || fresh.length) {
      for (const id of rebases) {
        const row = set.changes.find((c) => c.id === id);
        if (row) rebaseRow(row, scope.environment);
      }
      for (const row of cleared) {
        row.status = "pending";
        row.conflict = null;
      }
      for (const c of fresh) {
        const row = set.changes.find((x) => x.id === c.id)!;
        row.status = "conflicted";
        row.conflict = c.conflict;
      }
      touch(set);
    } else {
      publish(set);
    }
    return HttpResponse.json({ change_set: toChangeSet(set), rebased: rebases, conflicts });
  }),

  http.post(mswPath("addServiceEdge"), async ({ request, params }) => {
    const input = await validate<{ from_service_id: string; to_service_id: string }>(
      "addServiceEdge",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const scope = projectScope(input.params.projectId ?? "", actionOf("addServiceEdge"));
    if (!scope.ok) return scope.response;
    const { project, userId } = scope;
    const { from_service_id: from, to_service_id: to } = input.body;
    const live = new Set(liveServices(project.id).map((s) => s.id));
    if (!live.has(from) || !live.has(to)) return notFound("Service");
    const existing = db.changes.edges.filter((e) => e.project_id === project.id);
    if (existing.length >= MAX_SERVICE_EDGES) {
      return apiError(409, "conflict", `A project holds at most ${MAX_SERVICE_EDGES} connections`);
    }
    if (existing.some((e) => e.from_service_id === from && e.to_service_id === to)) {
      return apiError(409, "conflict", "These services are already connected");
    }
    const edge: ServiceEdge = {
      id: nextId("edg"),
      project_id: project.id,
      from_service_id: from,
      to_service_id: to,
      created_by: userId,
      created_at: Date.now(),
    };
    db.changes.edges.push(edge);
    recordAudit({
      workspaceId: project.workspace_id,
      actorType: "user",
      actorId: userId,
      action: "canvas.edge_added",
      targetType: "project",
      targetId: project.id,
      metadata: { edge_id: edge.id, from, to },
    });
    broadcastRealtime(project.id, { type: "canvas.edges_updated", by_user_id: userId });
    return HttpResponse.json(edge, { status: 201 });
  }),

  http.delete(mswPath("removeServiceEdge"), async ({ request, params }) => {
    const input = await validate("removeServiceEdge", request, params);
    if (!input.ok) return input.response;
    const scope = projectScope(input.params.projectId ?? "", actionOf("removeServiceEdge"));
    if (!scope.ok) return scope.response;
    const { project, userId } = scope;
    const edge = db.changes.edges.find(
      (e) => e.id === input.params.edgeId && e.project_id === project.id,
    );
    if (!edge) return notFound("Connection");
    db.changes.edges = db.changes.edges.filter((e) => e !== edge);
    recordAudit({
      workspaceId: project.workspace_id,
      actorType: "user",
      actorId: userId,
      action: "canvas.edge_removed",
      targetType: "project",
      targetId: project.id,
      metadata: { edge_id: edge.id, from: edge.from_service_id, to: edge.to_service_id },
    });
    broadcastRealtime(project.id, { type: "canvas.edges_updated", by_user_id: userId });
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(mswPath("listWorkspaceChangeSets"), async ({ request, params }) => {
    const input = await validate<unknown, { review: "open" | "pending" }>(
      "listWorkspaceChangeSets",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const workspaceId = input.params.workspaceId ?? "";
    const guard = requireWorkspace(workspaceId, actionOf("listWorkspaceChangeSets"));
    if (!guard.ok) return guard.response;
    const projects = new Map(
      db.deploy.projects
        .filter((p) => p.workspace_id === workspaceId && !p.deleted)
        .map((p) => [p.id, p]),
    );
    const change_sets = db.changes.sets
      .filter((s) => projects.has(s.project_id) && (s.status === "open" || s.status === "applying"))
      .map(toSummary)
      .filter((s) => input.query.review !== "pending" || s.review_status === "submitted")
      .sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? 1 : -1))
      .slice(0, 100)
      .flatMap((s) => {
        const environment = db.deploy.environments.find((e) => e.id === s.environment_id);
        if (!environment) return [];
        return [
          {
            ...s,
            project_name: projects.get(s.project_id)!.name,
            environment_name: environment.name,
            environment_requires_approval: requiresApproval(environment),
          },
        ];
      })
      // A draft nothing is staged in yet is noise in a review queue.
      .filter((s) => s.op_count > 0);
    return HttpResponse.json({ change_sets });
  }),
];

/** The approve and reject handlers, which differ only in the decision they record. */
function decide(decision: "approve" | "reject") {
  const name = decision === "approve" ? "approveChangeSet" : "rejectChangeSet";
  return http.post(mswPath(name), async ({ request, params }) => {
    const input = await validate<{ expected_revision: number; note?: string }>(
      name,
      request,
      params,
    );
    if (!input.ok) return input.response;
    const scope = setScope(input.params.changeSetId ?? "", actionOf(name));
    if (!scope.ok) return scope.response;
    const set = scope.set;
    if (set.status !== "open") return closed(set);
    if (input.body.expected_revision !== set.revision) return changed(set.revision);
    const pending = set.changes.filter((c) => c.status !== "applied");
    if (!pending.length) return nothingStaged();
    // SECURITY: Mirrors the API: whoever opened the set or staged an op can't review it.
    if (authorsOf(set).includes(scope.userId)) {
      return apiError(
        403,
        "self_review",
        "You opened this change set or staged changes in it, so someone else must review it",
      );
    }
    const now = Date.now();
    const approve = decision === "approve";
    Object.assign(set, {
      review_status: approve ? "approved" : "rejected",
      approved_by: approve ? scope.userId : null,
      approved_at: approve ? now : null,
      approved_revision: approve ? set.revision : null,
      rejected_by: approve ? null : scope.userId,
      rejected_at: approve ? null : now,
      review_note: input.body.note ?? null,
      submitted_at: set.submitted_at ?? now,
      updated_at: now,
    });
    recordAudit({
      workspaceId: scope.workspaceId,
      actorType: "user",
      actorId: scope.userId,
      action: approve ? "change_set.approved" : "change_set.rejected",
      targetType: "change_set",
      targetId: set.id,
      metadata: {
        project_id: set.project_id,
        environment_id: set.environment_id,
        revision: set.revision,
        ops: pending.map((c) => c.summary),
        has_note: input.body.note !== undefined,
      },
    });
    publish(set);
    return HttpResponse.json(toChangeSet(set));
  });
}

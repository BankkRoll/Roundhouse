/**
 * Reviewing and applying a change set (ADR 0006 "Conflicts" and "Apply").
 *
 * Apply runs, in order:
 * 1. **Authorize** every op for the applier, in the set's environment, with
 *    the same per-action checks as the direct routes (ADR 0014): config,
 *    variable, volume and domain ops against the environment, so its
 *    protection applies; service creation and renames against the project; a
 *    deletion against every environment of the project. Then review: a
 *    rejected set never applies, an environment whose protection requires
 *    approval needs one from someone other than the applier, and an API
 *    token needs `changes:auto_apply` unless a person approved the set
 *    (`./review`). Nothing is locked yet, so a refusal leaves the set
 *    untouched.
 * 2. **Lock** with a guarded `open → applying` update on the reviewed
 *    revision, so a set is applied exactly as reviewed and only once.
 * 3. **Rebase**: ops whose base drifted either merge (a config patch on
 *    disjoint pointers) or become `conflicted`, which refuses the apply.
 * 4. **Validate the result**: slugs, merged configs, the variable
 *    classifier's rules against the current values, and every reference of
 *    every service the set affects.
 * 5. **Commit**: services and config versions in one `db.batch` (one D1
 *    transaction) with their audit rows (a database also gets its volume
 *    and generated credentials in every environment in that batch, so it
 *    never exists without them); then variables through `putVariables`,
 *    the normal write path, one batch per scope; then volumes and custom
 *    domains through the same functions as their direct routes.
 * 6. **Deploy** the affected services with `createDeployment`.
 *
 * Steps 5's two phases are separate transactions because variables must go
 * through `putVariables`. Each applied op is marked as it commits, so if the
 * second phase fails the set returns to `open` with `error` set and only its
 * remaining ops apply on the next try. Step 4 runs the same refusals first,
 * so in practice that only happens on a concurrent write.
 *
 * SECURITY: Staged values are unsealed only here, only to hand them to
 * `putVariables` and the reference check, and sealed values are erased from
 * staged rows once applied. Audit metadata carries keys and op summaries,
 * never values.
 *
 * @module
 */
import {
  changeSets,
  type Db,
  deployments,
  domains,
  environments,
  type StagedBase,
  type StagedConflict,
  services,
  stagedChanges,
  variables,
  volumes,
} from "@roundhouse/db";
import {
  affectedServices,
  BUILTIN_VARIABLES,
  type BuiltinVariable,
  type ConfigPatchOp,
  configDiff,
  conflictingPointers,
  type DiffEntry,
  type DomainAddOp,
  type DomainRemoveOp,
  defaultServiceConfig,
  describeOp,
  isNewServiceRef,
  LIVE_VOLUME_STATUSES,
  newId,
  opAction,
  patchPointers,
  RESERVED_SERVICE_SLUGS,
  resolveVariables,
  type ServiceConfigSpec,
  type ServiceCreateOp,
  type ServiceSource,
  SHARED_NAMESPACE,
  type VariableDeleteOp,
  type VariableSetOp,
  type VolumeDeleteOp,
  type VolumeSetOp,
} from "@roundhouse/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type AppContext, clientIp, originOf, requireKeys } from "../../context";
import type { Env } from "../../env";
import { auditInsert, recordAudit } from "../audit";
import type { KeyEnv, Sealed } from "../crypto";
import { databaseVariableRows, databaseVariables, resolveDatabaseVersion } from "../databases";
import { createDeployment } from "../deployments";
import { refreshNodes } from "../desired-state";
import {
  addCustomDomain,
  assertDomainCapacity,
  assertHostnameFree,
  checkCustomHostname,
  type DomainRow,
  domainPort,
  removeCustomDomain,
} from "../domains/manage";
import { ApiError, conflict, type ErrorDetail, isUniqueViolation } from "../errors";
import { assertSourceInstallation } from "../github";
import {
  configInsert,
  freeSlug,
  mergeConfig,
  slugFor,
  specOf,
  syncGeneratedDomain,
  tearDownServices,
} from "../projects";
import { publish } from "../realtime";
import { type Caller, projectScope } from "../scope";
import { toApiService } from "../serialize";
import { getIngressSettings } from "../settings";
import {
  loadEnvironmentVariables,
  projectKey,
  putVariables,
  type VariableSetEntry,
  type VariableTarget,
} from "../variables";
import {
  assertSingleReplica,
  resizeVolume,
  singleReplicaError,
  deleteVolume as softDeleteVolume,
  type VolumeRow,
  volumeInUse,
  volumeOf,
  volumeRowsFor,
} from "../volumes";
import { applyBlocker, authorsOf, requiresApproval } from "./review";
import { openStagedValue } from "./secrets";
import {
  checkVariableWrite,
  configAt,
  currentVariable,
  recordConflicts,
  storedFingerprint,
  variableSide,
  variableTargetOf,
} from "./staging";
import {
  type ChangeSetRow,
  changeSetChanged,
  type EnvironmentRow,
  hasValidApproval,
  loadOps,
  notOpen,
  type ProjectRow,
  publishChangeSet,
  type StagedRow,
  serviceNamer,
} from "./store";

type ServiceRow = typeof services.$inferSelect;

/** What reviewing and applying need. */
export interface ApplyContext {
  c: AppContext;
  db: Db;
  env: Env;
  project: ProjectRow;
  environment: EnvironmentRow;
}

// -----------------------------------------------------------------------------
// Drift
// -----------------------------------------------------------------------------

/** What changed underneath a set's ops since they were staged. */
export interface Drift {
  /** Ops that merge cleanly, with their new base and diff. */
  rebases: Map<string, { base: StagedBase; diff: DiffEntry[] }>;
  /** Ops that need a decision. */
  conflicts: Map<string, StagedConflict>;
  /** Conflicted ops whose conflict went away (the other side was reverted). */
  cleared: string[];
}

async function serviceRow(db: Db, id: string) {
  return db.query.services.findFirst({ where: eq(services.id, id) });
}

/**
 * Checks every unapplied op against the current state (ADR 0006 "Conflicts").
 *
 * @param ctx - Database, project and environment.
 * @param rows - The set's ops.
 * @returns Rebases, conflicts and cleared conflicts.
 */
export async function checkDrift(
  ctx: Pick<ApplyContext, "db" | "project" | "environment"> & { keys: KeyEnv },
  rows: readonly StagedRow[],
): Promise<Drift> {
  const { db, environment } = ctx;
  const drift: Drift = { rebases: new Map(), conflicts: new Map(), cleared: [] };
  const deleted = (base: number | null, current: number | null = null): StagedConflict => ({
    theirs: null,
    base_version: base,
    current_version: current,
    deleted: true,
  });
  for (const row of rows) {
    if (row.status === "applied") continue;
    const op = row.op;
    let found: StagedConflict | null = null;
    switch (op.type) {
      case "service.create":
        break;
      case "service.delete": {
        const svc = await serviceRow(db, op.service_id);
        if (!svc || svc.deletedAt) found = deleted(null);
        break;
      }
      case "service.update": {
        const svc = await serviceRow(db, op.service_id);
        if (!svc || svc.deletedAt) {
          found = deleted(null);
          break;
        }
        const theirs: Record<string, unknown> = {};
        for (const [field, was] of Object.entries(row.base.service ?? {})) {
          const now = svc[field as "name" | "slug" | "icon"];
          if (now !== was) theirs[field] = now;
        }
        if (Object.keys(theirs).length) {
          found = {
            theirs,
            paths: Object.keys(theirs).map((f) => `/${f}`),
            base_version: null,
            current_version: null,
          };
        }
        break;
      }
      case "config.patch": {
        if (isNewServiceRef(op.service)) break;
        const svc = await serviceRow(db, op.service);
        const base = row.base.config_version ?? null;
        if (!svc || svc.deletedAt) {
          found = deleted(base);
          break;
        }
        const latest = await configAt(db, op.service, environment.id);
        if (!latest) {
          found = deleted(base);
          break;
        }
        if (latest.version === base) break;
        const baseRow =
          base === null ? undefined : await configAt(db, op.service, environment.id, base);
        const theirs = configDiff(baseRow ? specOf(baseRow) : null, specOf(latest));
        const overlap = conflictingPointers(
          patchPointers(op.patch),
          theirs.map((d) => d.path),
        );
        if (overlap.length) {
          found = {
            theirs: theirs.filter((d) =>
              overlap.some(
                (p) => d.path === p || d.path.startsWith(`${p}/`) || p.startsWith(`${d.path}/`),
              ),
            ),
            paths: overlap,
            base_version: base,
            current_version: latest.version,
          };
        } else {
          const before = specOf(latest);
          drift.rebases.set(row.id, {
            base: { config_version: latest.version },
            diff: configDiff(before, mergeConfig(before, op.patch)),
          });
        }
        break;
      }
      case "variable.set":
      case "variable.delete": {
        const target = variableTargetOf(ctx.project, environment, op.scope, op.service);
        if (!target) break;
        if (target.serviceId) {
          const svc = await serviceRow(db, target.serviceId);
          if (!svc || svc.deletedAt) {
            found = deleted(row.base.variable_version ?? null);
            break;
          }
        }
        const current = await currentVariable(db, target, op.key);
        const base = row.base.variable_version ?? null;
        const now = current?.version ?? null;
        if (now !== base) {
          found = {
            theirs: current
              ? variableSide(current.tier, await storedFingerprint(ctx, current))
              : null,
            base_version: base,
            current_version: now,
          };
        }
        break;
      }
      case "volume.set":
      case "volume.delete": {
        const svc = await serviceRow(db, op.service);
        if (!svc || svc.deletedAt) {
          found = deleted(null);
          break;
        }
        const base = row.base.volume ?? null;
        const current = await volumeOf(db, op.service, environment.id);
        const live = current && current.status !== "pending_deletion" ? current : undefined;
        if (base === null && !live) break;
        if (base !== null && live?.id === base.id && live.sizeMb === base.size_mb) break;
        if (base !== null && live?.id !== base.id) {
          found = deleted(base.size_mb, live?.sizeMb ?? null);
          break;
        }
        found = {
          theirs: live ? { mount_path: live.mountPath, size_mb: live.sizeMb } : null,
          paths: ["/volume/size_mb"],
          base_version: base?.size_mb ?? null,
          current_version: live?.sizeMb ?? null,
        };
        break;
      }
      case "domain.add": {
        const svc = await serviceRow(db, op.service);
        if (!svc || svc.deletedAt) found = deleted(null);
        break;
      }
      case "domain.remove": {
        const domain = await db.query.domains.findFirst({ where: eq(domains.id, op.domain_id) });
        if (!domain) found = deleted(null);
        break;
      }
    }
    if (found) drift.conflicts.set(row.id, found);
    else if (row.status === "conflicted") drift.cleared.push(row.id);
  }
  return drift;
}

// -----------------------------------------------------------------------------
// The post-apply model
// -----------------------------------------------------------------------------

interface PlannedCreate {
  row: StagedRow;
  op: ServiceCreateOp;
  id: string;
  slug: string;
  spec: ServiceConfigSpec;
  /** A database's generated variables, per environment ID. */
  credentials?: Map<string, VariableSetEntry[]>;
}

interface PlannedPatch {
  row: StagedRow;
  op: ConfigPatchOp;
  service: ServiceRow;
  version: number;
  spec: ServiceConfigSpec;
}

interface PlannedVariable {
  row: StagedRow;
  op: VariableSetOp | VariableDeleteOp;
  /** Resolved service ID; `null` for shared. */
  serviceId: string | null;
  /** Unsealed value of a `variable.set`. */
  value?: string;
}

interface PlannedVolume {
  row: StagedRow;
  op: VolumeSetOp | VolumeDeleteOp;
  service: ServiceRow;
  /** The volume as it is; `undefined` when a `volume.set` creates one. */
  current: VolumeRow | undefined;
}

interface PlannedDomain {
  row: StagedRow;
  op: DomainAddOp | DomainRemoveOp;
  service: ServiceRow;
  /** The domain a `domain.remove` removes. */
  domain?: DomainRow;
}

/** Why an apply deploys a service. */
type DeployReason = "config" | "variables" | "created" | "references" | "volume";

/** Everything an apply will write, resolved and validated. */
interface Plan {
  live: ServiceRow[];
  creates: PlannedCreate[];
  updates: {
    row: StagedRow;
    service: ServiceRow;
    name?: string;
    slug?: string;
    icon?: string | null;
  }[];
  deletes: { row: StagedRow; service: ServiceRow }[];
  patches: PlannedPatch[];
  vars: PlannedVariable[];
  volumes: PlannedVolume[];
  domains: PlannedDomain[];
  /** Nodes holding a volume the apply changed, whose desired state must be refreshed. */
  nodeIds: Set<string>;
  /** Final slug of every service that exists after the apply, by ID. */
  slugOf: Map<string, string>;
  /** Slugs to deploy with `deploy: "affected"`, and why. */
  affected: { slug: string; reason: DeployReason }[];
}

function resolveRefs(rows: readonly StagedRow[]): Map<string, string> {
  const refs = new Map<string, string>();
  for (const r of rows) {
    if (r.status === "applied" && r.op.type === "service.create" && r.result?.service_id) {
      refs.set(r.op.ref, String(r.result.service_id));
    }
  }
  return refs;
}

/**
 * The refusals of the volume routes, for a staged volume op against the
 * volume as it is and the config the apply leaves.
 *
 * @param db - Database client.
 * @param op - The op.
 * @param service - Its service.
 * @param found - The service's volume in the environment, live or soft-deleted.
 * @param spec - The service's config after the apply.
 * @throws {ApiError} 409 for a volume being deleted, in use or missing; 422 to shrink or with replicas.
 */
async function checkVolumeOp(
  db: Db,
  op: VolumeSetOp | VolumeDeleteOp,
  service: ServiceRow,
  found: VolumeRow | undefined,
  spec: ServiceConfigSpec | null,
): Promise<void> {
  const live = (s: VolumeRow) => (LIVE_VOLUME_STATUSES as readonly string[]).includes(s.status);
  if (found?.status === "pending_deletion") {
    throw conflict(`${service.name}'s volume is scheduled for deletion; undelete it first`);
  }
  if (op.type === "volume.delete") {
    if (!found || !live(found)) throw conflict(`${service.name} has no volume to delete here`);
    if (await volumeInUse(db, found)) {
      throw conflict(`${service.name} still runs here; scale it to 0 or delete it first`);
    }
    return;
  }
  if (found) {
    if (!live(found))
      throw conflict(`${service.name}'s volume is ${found.status.replace(/_/g, " ")}`);
    if (op.size_mb < found.sizeMb) {
      throw new ApiError(
        422,
        "volume_shrink_unsupported",
        `Volumes only grow; ${service.name}'s is ${found.sizeMb} MiB`,
      );
    }
    return;
  }
  if (!op.mount_path)
    throw new ApiError(400, "invalid_request", "mount_path: Required for a new volume");
  if ((spec?.deploy.replicas ?? 1) > 1) throw singleReplicaError();
}

/**
 * Builds and validates the post-apply model of the set's environment.
 *
 * @param ctx - Context.
 * @param rows - The set's ops (applied ones are only used to resolve refs).
 * @param options - `strict` refuses invalid states (apply); off, a review just reports what it can.
 * @returns The plan.
 * @throws {ApiError} 400/409/422 for an invalid result, in strict mode.
 */
async function buildPlan(
  ctx: ApplyContext,
  rows: readonly StagedRow[],
  options: { strict: boolean },
): Promise<Plan> {
  const { db, project, environment } = ctx;
  const keys = requireKeys(ctx.c);
  const pending = rows.filter((r) => r.status !== "applied");
  const refs = resolveRefs(rows);
  const live = await db.query.services.findMany({
    where: (s, { and: a, eq: e, isNull: n }) => a(e(s.projectId, project.id), n(s.deletedAt)),
    orderBy: (s, { asc: up }) => [up(s.id)],
  });
  const byId = new Map(live.map((s) => [s.id, s]));
  const plan: Plan = {
    live,
    creates: [],
    updates: [],
    deletes: [],
    patches: [],
    vars: [],
    volumes: [],
    domains: [],
    nodeIds: new Set(),
    slugOf: new Map(live.map((s) => [s.id, s.slug])),
    affected: [],
  };

  const envIds = (
    await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.projectId, project.id))
  ).map((e) => e.id);

  // Services: deletions, renames, then creations take the slugs left over.
  for (const row of pending) {
    if (row.op.type !== "service.delete") continue;
    const service = byId.get(row.op.service_id);
    if (!service) continue;
    plan.deletes.push({ row, service });
    plan.slugOf.delete(service.id);
  }
  const deleted = new Set(plan.deletes.map((d) => d.service.id));
  for (const row of pending) {
    if (row.op.type !== "service.update") continue;
    const service = byId.get(row.op.service_id);
    if (!service || deleted.has(service.id)) continue;
    const { name, slug, icon } = row.op;
    let newSlug: string | undefined;
    if (slug !== undefined && slug !== service.slug) {
      const others = new Set(
        [...plan.slugOf].filter(([id]) => id !== service.id).map(([, s]) => s),
      );
      if ((RESERVED_SERVICE_SLUGS as readonly string[]).includes(slug)) {
        newSlug = freeSlug(others, slug, RESERVED_SERVICE_SLUGS);
      } else if (others.has(slug)) {
        if (options.strict) throw conflict(`A service with slug ${slug} exists`);
      } else newSlug = slug;
      if (newSlug) plan.slugOf.set(service.id, newSlug);
    }
    plan.updates.push({
      row,
      service,
      ...(name !== undefined ? { name } : {}),
      ...(newSlug !== undefined ? { slug: newSlug } : {}),
      ...(icon !== undefined ? { icon } : {}),
    });
  }
  for (const row of pending) {
    if (row.op.type !== "service.create") continue;
    const op = row.op;
    const spec = mergeConfig(defaultServiceConfig(op.source), op.config ?? {});
    const slug = freeSlug(
      new Set(plan.slugOf.values()),
      op.slug ?? slugFor(op.name, "service"),
      RESERVED_SERVICE_SLUGS,
    );
    const id = newId("service");
    refs.set(op.ref, id);
    plan.slugOf.set(id, slug);
    const credentials = op.database
      ? new Map(
          envIds.map((e) => [e, databaseVariables(op.database!.engine, op.database!.version)]),
        )
      : undefined;
    plan.creates.push({ row, op, id, slug, spec, ...(credentials ? { credentials } : {}) });
  }
  const resolve = (ref: string) => (isNewServiceRef(ref) ? refs.get(ref) : ref);

  // Config patches.
  for (const row of pending) {
    if (row.op.type !== "config.patch") continue;
    const serviceId = resolve(row.op.service);
    const service = serviceId ? byId.get(serviceId) : undefined;
    if (!service || deleted.has(service.id)) continue;
    const latest = await configAt(db, service.id, environment.id);
    if (!latest) continue;
    const merged = mergeConfig(specOf(latest), row.op.patch);
    if (options.strict) await assertSingleReplica(db, service, merged.deploy.replicas);
    plan.patches.push({
      row,
      op: row.op,
      service,
      version: latest.version + 1,
      spec: merged,
    });
  }

  // Volumes and domains, checked against the config the apply leaves.
  const specAfter = async (service: ServiceRow): Promise<ServiceConfigSpec | null> => {
    const patched = plan.patches.find((p) => p.service.id === service.id);
    if (patched) return patched.spec;
    const latest = await configAt(db, service.id, environment.id);
    return latest ? specOf(latest) : null;
  };
  for (const row of pending) {
    const op = row.op;
    if (op.type !== "volume.set" && op.type !== "volume.delete") continue;
    const service = byId.get(op.service);
    if (!service || deleted.has(service.id)) continue;
    const found = await volumeOf(db, service.id, environment.id);
    const current = found && found.status !== "pending_deletion" ? found : undefined;
    if (options.strict) await checkVolumeOp(db, op, service, found, await specAfter(service));
    plan.volumes.push({ row, op, service, current });
  }
  const adding = new Map<string, number>();
  for (const row of pending) {
    const op = row.op;
    if (op.type !== "domain.add" && op.type !== "domain.remove") continue;
    const service = byId.get(op.service);
    if (!service || deleted.has(service.id)) continue;
    if (op.type === "domain.remove") {
      const domain = await db.query.domains.findFirst({ where: eq(domains.id, op.domain_id) });
      if (!domain) {
        if (options.strict) throw conflict(`${op.hostname} was already removed`);
        continue;
      }
      adding.set(service.id, (adding.get(service.id) ?? 0) - 1);
      plan.domains.push({ row, op, service, domain });
      continue;
    }
    adding.set(service.id, (adding.get(service.id) ?? 0) + 1);
    if (options.strict) {
      await checkCustomHostname(ctx.c, db, op.hostname);
      await assertHostnameFree(db, op.hostname, Date.now());
      domainPort((await specAfter(service))?.networking.port, {
        service: service.name,
        environment: environment.name,
      });
    }
    plan.domains.push({ row, op, service });
  }
  if (options.strict) {
    for (const [serviceId, n] of adding) {
      if (n > 0) await assertDomainCapacity(db, serviceId, environment.id, n);
    }
  }

  // Variables: the environment as it is, moved to the final slugs, with the staged ops on top.
  const dek = await projectKey(db, keys, project.id);
  const current = await loadEnvironmentVariables(db, dek, project.id, environment.id);
  const slugNow = new Map(live.map((s) => [s.id, s.slug]));
  const after: Record<string, Record<string, string>> = {};
  for (const [id, slug] of plan.slugOf) {
    const was = slugNow.get(id);
    after[slug] = { ...(was ? (current.services[was] ?? {}) : {}) };
  }
  for (const create of plan.creates) {
    for (const v of create.credentials?.get(environment.id) ?? []) {
      after[create.slug]![v.key] = v.value!;
    }
  }
  const shared = { ...current.shared };
  const changedVariables: string[] = [];
  const refusals: ErrorDetail[] = [];
  for (const row of pending) {
    const op = row.op;
    if (op.type !== "variable.set" && op.type !== "variable.delete") continue;
    const serviceId = op.scope === "service" ? (resolve(op.service!) ?? null) : null;
    if (op.scope === "service" && (!serviceId || !plan.slugOf.has(serviceId))) continue;
    const ns = serviceId ? plan.slugOf.get(serviceId)! : SHARED_NAMESPACE;
    const bag = serviceId ? after[ns]! : shared;
    const planned: PlannedVariable = { row, op, serviceId };
    if (op.type === "variable.set") {
      if (!row.valueSealed) {
        if (options.strict)
          throw new ApiError(
            409,
            "conflict",
            `${describeOp(op)} has no staged value; stage it again`,
          );
        continue;
      }
      planned.value = await openStagedValue(
        dek,
        {
          changeSetId: row.changeSetId,
          stagedChangeId: row.id,
          scope: op.scope,
          service: op.scope === "service" ? op.service! : null,
          key: op.key,
        },
        row.valueSealed as Sealed,
      );
      bag[op.key] = planned.value;
      if (options.strict) {
        const target: VariableTarget | null =
          serviceId && !byId.has(serviceId)
            ? null
            : { projectId: project.id, environmentId: environment.id, scope: op.scope, serviceId };
        const prior = target ? await currentVariable(db, target, op.key) : undefined;
        try {
          checkVariableWrite({
            key: op.key,
            value: planned.value,
            ...(op.tier ? { tier: op.tier } : {}),
            ...(prior ? { previous: prior.tier } : {}),
            confirmWriteOnly: op.confirm_write_only,
            acknowledgePublic: op.acknowledge_public,
          });
        } catch (err) {
          if (!(err instanceof ApiError) || !err.details) throw err;
          refusals.push(...err.details);
        }
      }
    } else {
      delete bag[op.key];
    }
    changedVariables.push(`${ns}.${op.key}`);
    plan.vars.push(planned);
  }
  if (refusals.length) {
    const first = refusals[0]!;
    throw new ApiError(400, first.code as never, `${first.field}: ${first.message}`, refusals);
  }

  // Which services the set redeploys. A new volume is only mounted by a new deployment.
  const mounted = new Set(
    plan.volumes
      .filter((v) => v.op.type === "volume.set" && !v.current)
      .map((v) => plan.slugOf.get(v.service.id)!),
  );
  const changedServices = [
    ...plan.patches.map((p) => plan.slugOf.get(p.service.id)!),
    ...plan.creates.map((c) => c.slug),
    ...mounted,
  ];
  const affected = affectedServices({ services: after, shared, changedVariables, changedServices });
  const ownVars = new Set(
    plan.vars.flatMap((v) => (v.serviceId ? [plan.slugOf.get(v.serviceId)!] : [])),
  );
  const created = new Set(plan.creates.map((c) => c.slug));
  const patched = new Set(plan.patches.map((p) => plan.slugOf.get(p.service.id)!));
  plan.affected = affected.map((slug) => ({
    slug,
    reason: created.has(slug)
      ? "created"
      : patched.has(slug)
        ? "config"
        : mounted.has(slug)
          ? "volume"
          : ownVars.has(slug)
            ? "variables"
            : "references",
  }));

  // Every reference of every service whose environment changes must still resolve.
  if (options.strict) {
    const reshaped = plan.deletes.length > 0 || plan.updates.some((u) => u.slug !== undefined);
    const check = reshaped ? Object.keys(after) : affected;
    const builtins: Record<string, Partial<Record<BuiltinVariable, string>>> = {};
    for (const slug of Object.keys(after)) {
      builtins[slug] = Object.fromEntries(BUILTIN_VARIABLES.map((b) => [b, "x"]));
    }
    const details: ErrorDetail[] = [];
    for (const slug of check) {
      const result = resolveVariables({ service: slug, services: after, shared, builtins });
      if (result.ok) continue;
      for (const e of result.errors) {
        if (e.code === "value_too_large") continue;
        details.push({
          field: `${e.variable.namespace}.${e.variable.name}`,
          code: e.code,
          message: e.message,
          ...(e.start !== undefined ? { start: e.start } : {}),
          ...(e.end !== undefined ? { end: e.end } : {}),
        });
      }
    }
    if (details.length) {
      const first = details[0]!;
      throw new ApiError(422, "invalid_references", `${first.field}: ${first.message}`, details);
    }
  }
  return plan;
}

// -----------------------------------------------------------------------------
// Review
// -----------------------------------------------------------------------------

/**
 * Checks a set against the current state without changing anything.
 *
 * @param ctx - Context.
 * @param set - The set.
 * @returns Its ops, which would rebase or conflict, and what an apply would deploy.
 */
export async function reviewSet(ctx: ApplyContext, set: ChangeSetRow) {
  const keys = requireKeys(ctx.c);
  const rows = await loadOps(ctx.db, set.id);
  const drift = await checkDrift({ ...ctx, keys }, rows);
  let deploys: { service: string; name: string; reason: DeployReason }[] = [];
  try {
    const plan = await buildPlan(ctx, rows, { strict: false });
    const idOf = new Map([...plan.slugOf].map(([id, slug]) => [slug, id]));
    const nameOf = new Map<string, string>([
      ...plan.live.map((s) => [s.id, s.name] as const),
      ...plan.creates.map((c) => [c.id, c.op.name] as const),
    ]);
    const refOf = new Map(plan.creates.map((c) => [c.id, c.op.ref]));
    deploys = plan.affected.map((a) => {
      const id = idOf.get(a.slug)!;
      return { service: refOf.get(id) ?? id, name: nameOf.get(id) ?? a.slug, reason: a.reason };
    });
  } catch (err) {
    // A set that doesn't validate still gets reviewed; apply reports the problem.
    if (!(err instanceof ApiError)) throw err;
  }
  return {
    rows,
    rebases: [...drift.rebases.keys()],
    conflicts: [...drift.conflicts].map(([id, c]) => ({ id, conflict: c })),
    deploys,
    approval: {
      required: requiresApproval(ctx.environment),
      approved: hasValidApproval(set),
      authors: authorsOf(set, rows),
    },
  };
}

// -----------------------------------------------------------------------------
// Apply
// -----------------------------------------------------------------------------

/** Options of {@link applySet}. */
export interface ApplyOptions {
  expectedRevision: number;
  deploy: "affected" | "none";
  /** Extra audit metadata, e.g. `{ via: "mcp", tool }`. */
  auditMetadata?: Record<string, unknown>;
  /**
   * The set carries out a direct route's request (`POST …/databases`), which
   * like every direct edit needs no review (ADR 0006 "Rollout"). Per-op
   * authorization still applies.
   */
  direct?: boolean;
}

/** Result of {@link applySet}. */
export interface ApplyResult {
  set: ChangeSetRow;
  deploymentIds: string[];
  skipped: { service_id: string; reason: string }[];
}

/**
 * Checks that the caller may apply every op of the set (ADR 0014 rules,
 * exactly as the direct routes check them). Throws before anything changes.
 *
 * @param ctx - Context.
 * @param rows - Unapplied ops.
 * @returns The caller resolved in the set's environment.
 * @throws {ApiError} 403 listing each refused op.
 */
async function authorizeApply(ctx: ApplyContext, rows: readonly StagedRow[]): Promise<Caller> {
  const { c, db, project, environment } = ctx;
  const inEnv = (await projectScope(c, project.id, "projects:read", environment.id)).caller;
  const inProject = (await projectScope(c, project.id, "projects:read")).caller;
  const everyEnv = new Map<string, Caller>();
  const denied: ErrorDetail[] = [];
  const nameOf = await serviceNamer(db, project.id, rows);
  for (const row of rows) {
    const op = row.op;
    const action = opAction(op);
    let ok: boolean;
    if (op.type === "service.create" || op.type === "service.update") {
      ok = inProject.allows(action);
    } else if (op.type === "service.delete") {
      // Deleting a service removes it from every environment, so each one's rules apply.
      if (!everyEnv.size) {
        const envs = await db
          .select({ id: environments.id })
          .from(environments)
          .where(eq(environments.projectId, project.id));
        for (const e of envs) {
          everyEnv.set(e.id, (await projectScope(c, project.id, "projects:read", e.id)).caller);
        }
      }
      ok = [...everyEnv.values()].every((caller) => caller.allows(action));
    } else {
      ok = inEnv.allows(action);
    }
    if (!ok) {
      denied.push({
        field: row.id,
        code: "forbidden",
        message: `${describeOp(op, nameOf)} needs ${action}${environment.protected ? ` in protected environment ${environment.name}` : ""}`,
      });
    }
  }
  if (denied.length) {
    throw new ApiError(
      403,
      "forbidden",
      `You can't apply this change set: ${denied[0]!.message}`,
      denied,
    );
  }
  return inEnv;
}

async function checkSource(ctx: ApplyContext, source: ServiceSource): Promise<void> {
  if (source.type !== "git" || !source.github_installation_id) return;
  requireKeys(ctx.c);
  await assertSourceInstallation(ctx.db, ctx.c.env, ctx.project.workspaceId, source);
}

function appliedRow(db: Db, row: StagedRow, result: Record<string, unknown> | null = null) {
  // The coalescing key is freed so the same target can be staged again in this set.
  return db
    .update(stagedChanges)
    .set({
      status: "applied",
      targetKey: `applied:${row.id}`,
      valueSealed: null,
      conflict: null,
      result,
      updatedAt: new Date(),
    })
    .where(eq(stagedChanges.id, row.id));
}

/**
 * Applies a change set exactly as reviewed. See the module docs for the steps.
 *
 * @param ctx - Context.
 * @param set - The set as loaded.
 * @param options - Reviewed revision and deploy mode.
 * @returns The applied set and the deployments it started.
 * @throws {ApiError} 403, 409 `change_set_changed` / `change_set_conflict`, 400/422 for invalid results.
 */
export async function applySet(
  ctx: ApplyContext,
  set: ChangeSetRow,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const { c, db, project, environment } = ctx;
  const keys = requireKeys(c);
  if (set.status !== "open") throw notOpen(set);
  if (set.revision !== options.expectedRevision) throw changeSetChanged(set.revision);
  const rows = await loadOps(db, set.id);
  const pending = rows.filter((r) => r.status !== "applied");
  if (!rows.length) throw new ApiError(400, "invalid_request", "Nothing is staged");
  const caller = await authorizeApply(ctx, pending);
  if (!options.direct) {
    const blocker = applyBlocker(set, environment, caller);
    if (blocker) {
      throw new ApiError(
        blocker.code === "change_set_rejected" ? 409 : 403,
        blocker.code,
        blocker.message,
      );
    }
  }

  const [locked] = await db
    .update(changeSets)
    .set({
      status: "applying",
      revision: set.revision + 1,
      // The lock bumps the revision but changes no op, so an approval of the
      // reviewed revision follows it; a failed apply keeps it.
      approvedRevision: sql`CASE WHEN ${changeSets.approvedRevision} = ${changeSets.revision} THEN ${changeSets.revision} + 1 ELSE ${changeSets.approvedRevision} END`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(changeSets.id, set.id),
        eq(changeSets.status, "open"),
        eq(changeSets.revision, options.expectedRevision),
      ),
    )
    .returning();
  if (!locked) {
    const now = await db.query.changeSets.findFirst({ where: eq(changeSets.id, set.id) });
    if (now && now.status !== "open") throw notOpen(now);
    throw changeSetChanged(now?.revision ?? set.revision);
  }

  const nameOf = await serviceNamer(db, project.id, rows);
  const audit = (
    entry: Omit<Parameters<typeof auditInsert>[1], "workspaceId" | "actorType" | "actorId" | "ip">,
  ) =>
    auditInsert(db, {
      ...entry,
      workspaceId: project.workspaceId,
      ...caller.actor,
      metadata: { ...entry.metadata, change_set_id: set.id, ...options.auditMetadata },
      ip: clientIp(c),
    });
  let plan: Plan;
  try {
    // Rebase.
    const drift = await checkDrift({ ...ctx, keys }, rows);
    if (drift.conflicts.size) {
      await recordConflicts(db, drift.conflicts);
      const details = [...drift.conflicts].map(([id, conflictOf]) => {
        const row = rows.find((r) => r.id === id)!;
        return {
          field: id,
          code: "conflict",
          message: `${describeOp(row.op, nameOf)}: ${conflictOf.deleted ? "its target no longer exists" : "changed since it was staged"}`,
        };
      });
      throw new ApiError(
        409,
        "change_set_conflict",
        `${details.length} staged change${details.length === 1 ? "" : "s"} conflict with changes made since; resolve them and review again`,
        details,
      );
    }
    if (drift.rebases.size || drift.cleared.length) {
      const writes = [
        ...[...drift.rebases].map(([id, r]) =>
          db
            .update(stagedChanges)
            .set({ ...r, updatedAt: new Date() })
            .where(eq(stagedChanges.id, id)),
        ),
        ...drift.cleared.map((id) =>
          db
            .update(stagedChanges)
            .set({ status: "pending", conflict: null })
            .where(eq(stagedChanges.id, id)),
        ),
      ];
      await db.batch(writes as [(typeof writes)[number], ...typeof writes]);
      for (const r of rows) {
        const rebased = drift.rebases.get(r.id);
        if (rebased) r.base = rebased.base;
      }
    }

    // Validate.
    plan = await buildPlan(ctx, rows, { strict: true });
    for (const create of plan.creates) await checkSource(ctx, create.spec.source);
    for (const patch of plan.patches)
      if (patch.op.patch.source) await checkSource(ctx, patch.spec.source);
    if (
      options.deploy === "affected" &&
      plan.affected.length &&
      !caller.allows("deployments:create")
    ) {
      throw new ApiError(
        403,
        "forbidden",
        `Deploying the affected services needs deployments:create in ${environment.name}; apply with deploy: "none" instead`,
      );
    }

    // Commit services and configs as one transaction.
    const envs = await db
      .select()
      .from(environments)
      .where(eq(environments.projectId, project.id))
      .orderBy(asc(environments.id));
    const statements = [];
    const now = new Date();
    for (const create of plan.creates) {
      statements.push(
        db.insert(services).values({
          id: create.id,
          projectId: project.id,
          name: create.op.name,
          slug: create.slug,
          kind: create.op.kind,
          icon: create.op.icon ?? null,
          databaseEngine: create.op.database?.engine ?? null,
          databaseVersion: create.op.database?.version ?? null,
        }),
        ...envs.map((e) =>
          configInsert(db, {
            serviceId: create.id,
            environmentId: e.id,
            version: 1,
            createdBy: caller.user.id,
            spec: create.spec,
          }),
        ),
        appliedRow(db, create.row, { service_id: create.id, slug: create.slug }),
        audit({
          action: "service.created",
          targetType: "service",
          targetId: create.id,
          metadata: {
            project_id: project.id,
            name: create.op.name,
            slug: create.slug,
            source: create.op.source.type,
            ...(create.op.database
              ? { engine: create.op.database.engine, version: create.op.database.version }
              : {}),
          },
        }),
      );
      if (create.op.database && create.credentials) {
        const db0 = create.op.database;
        statements.push(
          ...volumeRowsFor({
            projectId: project.id,
            serviceId: create.id,
            environmentIds: envs.map((e) => e.id),
            mountPath: resolveDatabaseVersion(db0.engine, db0.version).mountPath,
            sizeMb: db0.size_mb,
          }).map((v) => db.insert(volumes).values(v)),
        );
        const dek = await projectKey(db, keys, project.id);
        for (const e of envs) {
          const entries = create.credentials.get(e.id) ?? [];
          const rows = await databaseVariableRows(
            dek,
            { projectId: project.id, environmentId: e.id, scope: "service", serviceId: create.id },
            entries,
            caller.user.id,
          );
          statements.push(
            ...rows.map((r) => db.insert(variables).values(r)),
            audit({
              action: "variables.updated",
              targetType: "service",
              targetId: create.id,
              metadata: {
                environment_id: e.id,
                set: entries.map((v) => v.key),
                deleted: [],
                generated: true,
              },
            }),
          );
        }
      }
    }
    for (const update of plan.updates) {
      statements.push(
        db
          .update(services)
          .set({
            ...(update.name !== undefined ? { name: update.name } : {}),
            ...(update.slug !== undefined ? { slug: update.slug } : {}),
            ...(update.icon !== undefined ? { icon: update.icon } : {}),
            updatedAt: now,
          })
          .where(eq(services.id, update.service.id)),
        appliedRow(db, update.row),
        audit({
          action: "service.updated",
          targetType: "service",
          targetId: update.service.id,
          metadata: {
            changes: (["name", "slug", "icon"] as const).filter((f) => update[f] !== undefined),
          },
        }),
      );
    }
    for (const patch of plan.patches) {
      statements.push(
        configInsert(db, {
          serviceId: patch.service.id,
          environmentId: environment.id,
          version: patch.version,
          createdBy: caller.user.id,
          spec: patch.spec,
        }),
        db.update(services).set({ updatedAt: now }).where(eq(services.id, patch.service.id)),
        appliedRow(db, patch.row, { config_version: patch.version }),
        audit({
          action: "service.updated",
          targetType: "service",
          targetId: patch.service.id,
          metadata: {
            changes: Object.keys(patch.op.patch),
            environment_id: environment.id,
            version: patch.version,
          },
        }),
      );
    }
    for (const del of plan.deletes) {
      statements.push(
        db
          .update(services)
          .set({ deletedAt: now, updatedAt: now })
          .where(eq(services.id, del.service.id)),
        appliedRow(db, del.row),
        audit({
          action: "service.deleted",
          targetType: "service",
          targetId: del.service.id,
          metadata: { name: del.service.name, slug: del.service.slug, project_id: project.id },
        }),
      );
    }
    if (statements.length) {
      try {
        await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
      } catch (err) {
        if (isUniqueViolation(err, "services") || isUniqueViolation(err, "service_configs")) {
          throw conflict(
            "Someone else changed these services at the same time; review and apply again",
          );
        }
        throw err;
      }
    }

    // Variables, through the normal write path: one atomic call per scope.
    const dek = await projectKey(db, keys, project.id);
    const groups = new Map<string, PlannedVariable[]>();
    for (const v of plan.vars) {
      const key = v.serviceId ?? SHARED_NAMESPACE;
      groups.set(key, [...(groups.get(key) ?? []), v]);
    }
    for (const group of groups.values()) {
      const serviceId = group[0]!.serviceId;
      const target: VariableTarget = {
        projectId: project.id,
        environmentId: environment.id,
        scope: serviceId ? "service" : "shared",
        serviceId,
      };
      const set: VariableSetEntry[] = [];
      const del: string[] = [];
      const ack: string[] = [];
      for (const v of group) {
        if (v.op.type === "variable.delete") {
          del.push(v.op.key);
          continue;
        }
        const op = v.op;
        const base = v.row.base.variable_version;
        set.push({
          key: op.key,
          value: v.value!,
          ...(op.tier ? { tier: op.tier } : {}),
          ...(op.available_at_build !== undefined
            ? { available_at_build: op.available_at_build }
            : {}),
          ...(op.mount_as_file !== undefined ? { mount_as_file: op.mount_as_file } : {}),
          ...(typeof base === "number" ? { expected_version: base } : {}),
        });
        if (op.acknowledge_public) ack.push(op.key);
      }
      const changed = await putVariables(
        db,
        dek,
        target,
        {
          set,
          delete: del,
          // SECURITY: `buildPlan` already refused any op that becomes
          // write-only without its own confirmation, against the same prior
          // versions `expected_version` pins here; the scope-wide flag only
          // carries those per-op confirmations into one atomic write.
          confirm_write_only: group.some(
            (v) => v.op.type === "variable.set" && v.op.confirm_write_only,
          ),
          acknowledge_public: ack,
        },
        caller.user.id,
      );
      const marks = [
        ...group.map((v) => appliedRow(db, v.row)),
        audit({
          action: "variables.updated",
          ...(serviceId
            ? { targetType: "service", targetId: serviceId }
            : { targetType: "project", targetId: project.id }),
          metadata: {
            environment_id: environment.id,
            ...(serviceId ? {} : { scope: "shared" }),
            set: changed.set,
            deleted: changed.deleted,
          },
        }),
      ];
      await db.batch(marks as [(typeof marks)[number], ...typeof marks]);
    }

    // Volumes and domains, through the direct routes' functions.
    const auditExtra = { change_set_id: set.id, ...options.auditMetadata };
    for (const v of plan.volumes) {
      const meta = { service_id: v.service.id, environment_id: environment.id };
      if (v.op.type === "volume.delete") {
        const row = await softDeleteVolume(db, v.current!);
        if (row.nodeId) plan.nodeIds.add(row.nodeId);
        await db.batch([
          appliedRow(db, v.row, { volume_id: row.id }),
          audit({
            action: "volume.deleted",
            targetType: "volume",
            targetId: row.id,
            metadata: { ...meta, delete_after: row.deleteAfter ? +row.deleteAfter : null },
          }),
        ]);
      } else if (v.current) {
        const row = await resizeVolume(db, v.current, v.op.size_mb);
        if (row.nodeId) plan.nodeIds.add(row.nodeId);
        await db.batch([
          appliedRow(db, v.row, { volume_id: row.id }),
          audit({
            action: "volume.resized",
            targetType: "volume",
            targetId: row.id,
            metadata: { ...meta, from_mb: v.current.sizeMb, to_mb: row.sizeMb },
          }),
        ]);
      } else {
        const [row] = volumeRowsFor({
          projectId: project.id,
          serviceId: v.service.id,
          environmentIds: [environment.id],
          mountPath: v.op.mount_path!,
          sizeMb: v.op.size_mb,
        });
        await db.batch([
          db.insert(volumes).values(row!),
          appliedRow(db, v.row, { volume_id: row!.id }),
          audit({
            action: "volume.created",
            targetType: "volume",
            targetId: row!.id,
            metadata: { ...meta, mount_path: row!.mountPath, size_mb: row!.sizeMb },
          }),
        ]);
      }
    }
    for (const d of plan.domains) {
      if (d.op.type === "domain.add") {
        const row = await addCustomDomain(c, {
          workspaceId: project.workspaceId,
          service: d.service,
          environment,
          hostname: d.op.hostname,
          actor: caller.actor,
          auditMetadata: auditExtra,
        });
        await appliedRow(db, d.row, { domain_id: row.id });
      } else {
        await removeCustomDomain(c, {
          workspaceId: project.workspaceId,
          domain: d.domain!,
          actor: caller.actor,
          auditMetadata: auditExtra,
        });
        await appliedRow(db, d.row);
      }
    }

    const [done] = await db
      .update(changeSets)
      .set({
        status: "applied",
        appliedBy: caller.user.id,
        appliedAt: new Date(),
        error: null,
        updatedAt: new Date(),
      })
      .where(and(eq(changeSets.id, set.id), eq(changeSets.status, "applying")))
      .returning();
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "change_set.applied",
      targetType: "change_set",
      targetId: set.id,
      metadata: {
        project_id: project.id,
        environment_id: environment.id,
        deploy: options.deploy,
        ops: pending.map((r) => describeOp(r.op, nameOf)),
        ...options.auditMetadata,
      },
      ip: clientIp(c),
    });
    return await finish(ctx, done ?? locked, plan, caller, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Apply failed";
    const code = err instanceof ApiError ? err.code : "internal";
    const [reverted] = await db
      .update(changeSets)
      .set({ status: "open", error: { code, message }, updatedAt: new Date() })
      .where(and(eq(changeSets.id, set.id), eq(changeSets.status, "applying")))
      .returning();
    if (reverted) await publishChangeSet(ctx.env, db, reverted);
    throw err;
  }
}

/**
 * Everything after the commit, none of which can undo it: domain sync,
 * teardown of deleted services, deployments, and realtime.
 */
async function finish(
  ctx: ApplyContext,
  set: ChangeSetRow,
  plan: Plan,
  caller: Caller,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const { c, db, project, environment } = ctx;
  const lifecycle = { db, env: ctx.env };
  const ingress = await getIngressSettings(db);
  const envs = await db.select().from(environments).where(eq(environments.projectId, project.id));
  for (const create of plan.creates) {
    for (const e of envs) {
      await syncGeneratedDomain(
        db,
        {
          serviceId: create.id,
          serviceSlug: create.slug,
          environmentId: e.id,
          environmentSlug: e.slug,
          spec: create.spec,
        },
        ingress,
      );
    }
  }
  for (const patch of plan.patches) {
    await syncGeneratedDomain(
      db,
      {
        serviceId: patch.service.id,
        serviceSlug: plan.slugOf.get(patch.service.id) ?? patch.service.slug,
        environmentId: environment.id,
        environmentSlug: environment.slug,
        spec: patch.spec,
      },
      ingress,
    );
  }
  if (plan.nodeIds.size) await refreshNodes(ctx.env, db, [...plan.nodeIds]);
  if (plan.deletes.length) {
    await tearDownServices(
      lifecycle,
      project.id,
      plan.deletes.map((d) => d.service.id),
    );
  }

  const deploymentIds: string[] = [];
  const skipped: ApplyResult["skipped"] = [];
  if (options.deploy === "affected") {
    const idOf = new Map([...plan.slugOf].map(([id, slug]) => [slug, id]));
    const kinds = new Map<string, string>([
      ...plan.live.map((s) => [s.id, s.kind] as const),
      ...plan.creates.map((cr) => [cr.id, cr.op.kind] as const),
    ]);
    // Databases first, so the services that reference them start after them.
    const order = plan.affected
      .map((a) => idOf.get(a.slug)!)
      .sort((a, b) => Number(kinds.get(b) === "database") - Number(kinds.get(a) === "database"));
    for (const serviceId of order) {
      try {
        const row = await createDeployment(lifecycle, {
          projectId: project.id,
          serviceId,
          environmentId: environment.id,
          trigger: "change_set",
          triggeredBy: caller.user.id,
          origin: originOf(c),
        });
        await db.batch([
          db.update(deployments).set({ changeSetId: set.id }).where(eq(deployments.id, row.id)),
          auditInsert(db, {
            workspaceId: project.workspaceId,
            ...caller.actor,
            action: "deployment.created",
            targetType: "deployment",
            targetId: row.id,
            metadata: {
              service_id: serviceId,
              environment_id: environment.id,
              config_version: row.configVersion,
              change_set_id: set.id,
              ...options.auditMetadata,
            },
            ip: clientIp(c),
          }),
        ]);
        deploymentIds.push(row.id);
      } catch (err) {
        skipped.push({
          service_id: serviceId,
          reason: err instanceof ApiError ? err.message : "Could not start the deploy pipeline",
        });
      }
    }
  }

  const touched = [
    ...plan.creates.map((cr) => cr.id),
    ...plan.updates.map((u) => u.service.id),
    ...plan.patches.map((p) => p.service.id),
    ...plan.deletes.map((d) => d.service.id),
  ];
  if (touched.length) {
    const rows = await db
      .select()
      .from(services)
      .where(inArray(services.id, [...new Set(touched)]));
    for (const row of rows) {
      await publish(ctx.env, project.id, { type: "service.updated", service: toApiService(row) });
    }
  }
  await publish(ctx.env, project.id, {
    type: "change_set.applied",
    change_set_id: set.id,
    environment_id: environment.id,
    deployment_ids: deploymentIds,
  });
  await publishChangeSet(ctx.env, db, set);
  return { set, deploymentIds, skipped };
}

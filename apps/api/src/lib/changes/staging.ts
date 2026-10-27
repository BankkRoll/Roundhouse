/**
 * Staging into a change set (ADR 0006 "Staged changes"): turning a client's
 * op into a stored one with its base and value-free diff, coalescing it with
 * what the set already holds, and the edits that follow (unstage, resolve,
 * discard).
 *
 * Each mutation bumps the set's revision first, guarded on the revision the
 * caller loaded, so two people editing one set never lose an edit silently.
 *
 * Volume and domain ops are checked with the same rules as their direct
 * routes when staged (grow-only volumes, one replica, hostname rules and
 * uniqueness), and again when applied.
 *
 * SECURITY: A `variable.set` value is checked with the same classifier rules
 * as a direct write, sealed at once under the project DEK with an AAD bound
 * to the staged change ({@link stagedValueAad}), and from then on appears
 * only as its fingerprint. Discarding a set erases its sealed values.
 *
 * @module
 */

import type { z } from "@hono/zod-openapi";
import {
  changeSets,
  type Db,
  domains,
  type StagedBase,
  type StagedConflict,
  serviceConfigs,
  services,
  stagedChanges,
  variables,
} from "@roundhouse/db";
import {
  classifyVariable,
  stageOp as coalesce,
  configDiff,
  type DiffEntry,
  decideVariableTier,
  defaultServiceConfig,
  describeOp,
  isNewServiceRef,
  mergeConfigPatches,
  newId,
  opAction,
  type ServiceCreateOp,
  type StagedEntry,
  type StagedOp,
  serviceOfOp,
  targetKeyOf,
  type VariableScope,
  type VariableTier,
} from "@roundhouse/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AppContext } from "../../context";
import type { StagedOpInputSchema } from "../../contracts/changes";
import { auditInsert } from "../audit";
import type { KeyEnv, Sealed } from "../crypto";
import { databaseCreateOp } from "../databases";
import { assertHostnameFree, checkCustomHostname } from "../domains/manage";
import { ApiError, type ErrorCode, notFound } from "../errors";
import { mergeConfig, slugFor, specOf } from "../projects";
import type { Caller } from "../scope";
import { assertValidReferences, openVariable, projectKey, type VariableTarget } from "../variables";
import {
  assertNotMoving,
  assertSingleReplica,
  singleReplicaError,
  type VolumeRow,
  volumeOf,
} from "../volumes";
import { fingerprintOf, sealStagedValue } from "./secrets";
import {
  bumpRevision,
  type ChangeSetRow,
  changeSetChanged,
  type EnvironmentRow,
  loadOps,
  notOpen,
  type ProjectRow,
  type StagedRow,
  serviceNamer,
} from "./store";

/** An op as a validated staging request carries it. */
export type StagedOpRequest = z.output<typeof StagedOpInputSchema>;

/** What staging needs to know about where and who. */
export interface StagingContext {
  /** For checks that depend on the request, such as the install's own hostnames. */
  c: AppContext;
  db: Db;
  keys: KeyEnv;
  project: ProjectRow;
  environment: EnvironmentRow;
  /** Resolved against the project, not the environment: see {@link authorizeStaging}. */
  caller: Caller;
}

/** An op ready to store. */
interface Prepared {
  op: StagedOp;
  base: StagedBase;
  diff: DiffEntry[];
  /** Seals the value of a `variable.set` for the row it ends up in. */
  seal?: (changeSetId: string, stagedChangeId: string) => Promise<Sealed>;
  /** Staging this op only takes an older one out (deleting a variable that is merely staged). */
  unstage?: string;
}

// -----------------------------------------------------------------------------
// Authorization
// -----------------------------------------------------------------------------

/**
 * Checks that the caller may propose `op` at all: their project role (and
 * token scopes) must grant the op's action. Protection is deliberately not
 * checked here: a developer may propose a change to a protected environment
 * that only an admin can apply, and apply checks the applier in the
 * environment (ADR 0006 "Security").
 *
 * @param caller - Resolved against the project.
 * @param op - The op being staged.
 * @throws {ApiError} 403 when the role or token can't perform the op's action.
 */
export function authorizeStaging(caller: Caller, op: { type: StagedOp["type"] }): void {
  const action = opAction(op as StagedOp);
  if (!caller.allows(action)) {
    const token = caller.principal.token;
    throw new ApiError(
      403,
      "forbidden",
      token && !token.scopes.includes(action)
        ? `This API token lacks the ${action} scope`
        : `Your role (${caller.projectRole ?? caller.role}) cannot perform ${action}`,
    );
  }
}

// -----------------------------------------------------------------------------
// Variable rules
// -----------------------------------------------------------------------------

/**
 * The refusals `putVariables` applies to one value, checked without
 * writing anything, so a staged value that a direct write would refuse is
 * refused when it is staged, and again before an apply writes anything.
 *
 * @param input - Key, value, requested tier, the variable's current tier and the confirmations.
 * @returns The tier the write would store.
 * @throws {ApiError} 400 `tier_locked`, `value_required`, `public_prefix_secret_value` or `confirmation_required`.
 */
export function checkVariableWrite(input: {
  key: string;
  value: string;
  tier?: VariableTier;
  previous?: VariableTier;
  confirmWriteOnly: boolean;
  acknowledgePublic: boolean;
}): VariableTier {
  const classification = classifyVariable(input.key, input.value);
  const decision = decideVariableTier({
    classification,
    ...(input.tier ? { requested: input.tier } : {}),
    ...(input.previous ? { previous: input.previous } : {}),
    valueProvided: true,
  });
  const detail = (code: string, message: string) => [{ field: input.key, code, message }];
  if (!decision.ok) {
    throw new ApiError(
      400,
      decision.code as ErrorCode,
      `${input.key}: ${decision.message}`,
      detail(decision.code, decision.message),
    );
  }
  if (
    !input.acknowledgePublic &&
    classification.warnings.some((w) => w.code === "public_prefix_secret_value")
  ) {
    throw new ApiError(
      400,
      "public_prefix_secret_value" as ErrorCode,
      `${input.key} will ship to every browser but looks like a credential; stage it with acknowledge_public to store anyway`,
      detail("public_prefix_secret_value", "Looks like a credential"),
    );
  }
  if (decision.tier === "secret" && input.previous !== "secret" && !input.confirmWriteOnly) {
    throw new ApiError(
      400,
      "confirmation_required" as ErrorCode,
      `${input.key} will be write-only: nobody can read it back. Stage it with confirm_write_only to continue`,
      detail("confirmation_required", "Becomes write-only"),
    );
  }
  return decision.tier;
}

/**
 * A variable as stored now, if it exists.
 *
 * @param db - Database client.
 * @param t - Its scope.
 * @param key - Its name.
 * @returns The row, or `undefined`.
 */
export async function currentVariable(db: Db, t: VariableTarget, key: string) {
  const [row] = await db
    .select()
    .from(variables)
    .where(
      and(
        eq(variables.projectId, t.projectId),
        eq(variables.environmentId, t.environmentId),
        eq(variables.scope, t.scope),
        t.serviceId === null ? isNull(variables.serviceId) : eq(variables.serviceId, t.serviceId),
        eq(variables.key, key),
      ),
    )
    .limit(1);
  return row;
}

/**
 * A stored variable's fingerprint: the stored one, or computed from the
 * value for rows written before fingerprints were filled in. Only the
 * fingerprint leaves this function.
 *
 * @param ctx - Database, keys and scope.
 * @param row - The variable row.
 * @returns 8 hex characters.
 */
export async function storedFingerprint(
  ctx: Pick<StagingContext, "db" | "keys" | "project">,
  row: typeof variables.$inferSelect,
): Promise<string> {
  if (row.fingerprint) return row.fingerprint;
  const dek = await projectKey(ctx.db, ctx.keys, ctx.project.id);
  return fingerprintOf(
    dek,
    await openVariable(dek, { ...row, valueSealed: row.valueSealed as Sealed }),
  );
}

/**
 * The value-free side of a variable in a diff.
 *
 * @param tier - Its tier.
 * @param fingerprint - Its fingerprint.
 * @returns `{ tier, fingerprint }`.
 */
export const variableSide = (tier: VariableTier, fingerprint: string) => ({ tier, fingerprint });

/**
 * The variable scope an op targets, or `null` while its service is only staged.
 *
 * @param project - The project.
 * @param environment - The environment.
 * @param scope - `service` or `shared`.
 * @param service - Service ID or `new:<n>`.
 * @returns The scope, or `null` for a service that doesn't exist yet.
 */
export function variableTargetOf(
  project: ProjectRow,
  environment: EnvironmentRow,
  scope: VariableScope,
  service: string | undefined,
): VariableTarget | null {
  if (scope === "service" && (!service || isNewServiceRef(service))) return null;
  return {
    projectId: project.id,
    environmentId: environment.id,
    scope,
    serviceId: scope === "service" ? service! : null,
  };
}

// -----------------------------------------------------------------------------
// Preparing ops
// -----------------------------------------------------------------------------

async function liveService(db: Db, projectId: string, serviceId: string) {
  const [row] = await db
    .select()
    .from(services)
    .where(
      and(
        eq(services.id, serviceId),
        eq(services.projectId, projectId),
        isNull(services.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Service");
  return row;
}

/**
 * A service's config in an environment at a version, or the latest one.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @param version - Exact version; the latest when omitted.
 * @returns The row, or `undefined`.
 */
export async function configAt(db: Db, serviceId: string, environmentId: string, version?: number) {
  const rows = await db
    .select()
    .from(serviceConfigs)
    .where(
      and(
        eq(serviceConfigs.serviceId, serviceId),
        eq(serviceConfigs.environmentId, environmentId),
        ...(version !== undefined ? [eq(serviceConfigs.version, version)] : []),
      ),
    );
  return rows.sort((a, b) => b.version - a.version)[0];
}

function prepareCreate(op: ServiceCreateOp): Prepared {
  const spec = mergeConfig(defaultServiceConfig(op.source), op.config ?? {});
  return {
    op,
    base: {},
    diff: [
      {
        path: "/service",
        before: null,
        after: { name: op.name, slug: op.slug ?? slugFor(op.name, "service"), kind: op.kind },
      },
      ...configDiff(null, spec),
    ],
  };
}

async function prepare(
  ctx: StagingContext,
  entries: readonly StagedEntry[],
  rows: readonly StagedRow[],
  input: StagedOpRequest,
): Promise<Prepared> {
  const { db, project, environment } = ctx;
  const rowOf = (key: string) => rows.find((r) => r.targetKey === key && r.status !== "applied");

  switch (input.type) {
    case "service.create": {
      const { type, ref, name, slug, kind, icon, source, config, database } = input;
      if (database) {
        return prepareCreate(databaseCreateOp({ ref, name, slug, icon, database, config }));
      }
      if (!source) throw new ApiError(400, "invalid_request", "source: Required");
      const op: ServiceCreateOp = {
        type,
        ref,
        name,
        kind: kind ?? "app",
        source,
        ...(slug !== undefined ? { slug } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(config !== undefined ? { config } : {}),
      };
      return prepareCreate(op);
    }

    case "service.update": {
      const svc = await liveService(db, project.id, input.service_id);
      const prior = rowOf(`service:${svc.id}`);
      const merged: StagedOp =
        prior?.op.type === "service.update"
          ? { ...prior.op, ...stripUndefined(input) }
          : { ...stripUndefined(input), type: "service.update", service_id: svc.id };
      if (merged.type !== "service.update") throw new Error("unreachable");
      const base: StagedBase = {
        service: { ...(prior?.op.type === "service.update" ? prior.base.service : {}) },
      };
      const diff: DiffEntry[] = [];
      for (const field of ["name", "slug", "icon"] as const) {
        if (merged[field] === undefined) continue;
        if (!(field in base.service!)) {
          (base.service as Record<string, unknown>)[field] = svc[field];
        }
        diff.push({ path: `/${field}`, before: svc[field], after: merged[field] });
      }
      return { op: merged, base, diff };
    }

    case "service.delete": {
      const svc = await liveService(db, project.id, input.service_id);
      return {
        op: { type: "service.delete", service_id: svc.id },
        base: {},
        diff: [{ path: "/service", before: { name: svc.name, slug: svc.slug }, after: null }],
      };
    }

    case "config.patch": {
      if (isNewServiceRef(input.service)) {
        // A staged service has no config yet: the patch folds into its creation.
        const create = entries.find(
          (e) => e.op.type === "service.create" && e.op.ref === input.service,
        )?.op as ServiceCreateOp | undefined;
        if (!create) {
          throw new ApiError(
            400,
            "invalid_request",
            `No staged service is called ${input.service}`,
          );
        }
        const { source, ...rest } = input.patch;
        if (create.database) {
          if (source) {
            throw new ApiError(
              400,
              "invalid_request",
              "A database's image comes from the registry",
            );
          }
          if ((rest.deploy?.replicas ?? 1) > 1) throw singleReplicaError();
        }
        return prepareCreate({
          ...create,
          ...(source ? { source } : {}),
          config: mergeConfigPatches(create.config ?? {}, rest),
        });
      }
      const svc = await liveService(db, project.id, input.service);
      const prior = rowOf(`config:${svc.id}`);
      const patch =
        prior?.op.type === "config.patch"
          ? mergeConfigPatches(prior.op.patch, input.patch)
          : input.patch;
      const baseVersion =
        prior?.base.config_version ?? (await configAt(db, svc.id, environment.id))?.version;
      if (baseVersion === undefined || baseVersion === null) throw notFound("Service config");
      const baseRow =
        (await configAt(db, svc.id, environment.id, baseVersion)) ??
        (await configAt(db, svc.id, environment.id));
      if (!baseRow) throw notFound("Service config");
      const before = specOf(baseRow);
      const after = mergeConfig(before, patch);
      await assertSingleReplica(db, svc, after.deploy.replicas);
      return {
        op: { type: "config.patch", service: svc.id, patch },
        base: { config_version: baseRow.version },
        diff: configDiff(before, after),
      };
    }

    case "variable.set": {
      if (input.scope === "service" && !isNewServiceRef(input.service!)) {
        await liveService(db, project.id, input.service!);
      }
      assertValidReferences([{ key: input.key, value: input.value }]);
      const target = variableTargetOf(project, environment, input.scope, input.service);
      const prior = target ? await currentVariable(db, target, input.key) : undefined;
      const tier = checkVariableWrite({
        key: input.key,
        value: input.value,
        ...(input.tier ? { tier: input.tier } : {}),
        ...(prior ? { previous: prior.tier } : {}),
        confirmWriteOnly: input.confirm_write_only ?? false,
        acknowledgePublic: input.acknowledge_public ?? false,
      });
      const dek = await projectKey(db, ctx.keys, project.id);
      const fingerprint = await fingerprintOf(dek, input.value);
      const op: StagedOp = {
        type: "variable.set",
        scope: input.scope,
        ...(input.scope === "service" ? { service: input.service! } : {}),
        key: input.key,
        ...(input.tier ? { tier: input.tier } : {}),
        ...(input.available_at_build !== undefined
          ? { available_at_build: input.available_at_build }
          : {}),
        ...(input.mount_as_file !== undefined ? { mount_as_file: input.mount_as_file } : {}),
        confirm_write_only: input.confirm_write_only ?? false,
        acknowledge_public: input.acknowledge_public ?? false,
        fingerprint,
        staged_tier: tier,
      };
      const priorEntry = rowOf(targetKeyOf(op));
      const value = input.value;
      return {
        op,
        base: priorEntry?.base ?? { variable_version: prior?.version ?? null },
        diff: [
          {
            path: `/variables/${input.key}`,
            before:
              prior && target
                ? variableSide(prior.tier, await storedFingerprint(ctx, prior))
                : null,
            after: variableSide(tier, fingerprint),
          },
        ],
        seal: (changeSetId, stagedChangeId) =>
          sealStagedValue(
            dek,
            {
              changeSetId,
              stagedChangeId,
              scope: input.scope,
              service: input.scope === "service" ? input.service! : null,
              key: input.key,
            },
            value,
          ),
      };
    }

    case "volume.set": {
      const svc = await liveService(db, project.id, input.service);
      const current = await currentVolume(db, svc.id, environment.id);
      if (current?.status === "pending_deletion") throw volumeScheduledForDeletion();
      if (current) await assertNotMoving(db, current);
      if (current) {
        if (input.mount_path !== undefined && input.mount_path !== current.mountPath) {
          throw new ApiError(
            400,
            "invalid_request",
            `A volume's mount path can't change; it is mounted at ${current.mountPath}`,
          );
        }
        if (input.size_mb < current.sizeMb) {
          throw new ApiError(
            422,
            "volume_shrink_unsupported",
            `Volumes only grow; it is ${current.sizeMb} MiB`,
          );
        }
        if (input.size_mb === current.sizeMb) {
          throw new ApiError(400, "invalid_request", `The volume already is ${current.sizeMb} MiB`);
        }
      } else {
        if (!input.mount_path) {
          throw new ApiError(400, "invalid_request", "mount_path: Required for a new volume");
        }
        const latest = await configAt(db, svc.id, environment.id);
        if (latest && specOf(latest).deploy.replicas > 1) throw singleReplicaError();
      }
      const mountPath = current?.mountPath ?? input.mount_path!;
      return {
        op: {
          type: "volume.set",
          service: svc.id,
          size_mb: input.size_mb,
          ...(current ? {} : { mount_path: mountPath }),
        },
        base: { volume: volumeBase(current) },
        diff: volumeDiff(current, { mount_path: mountPath, size_mb: input.size_mb }),
      };
    }

    case "volume.delete": {
      const svc = await liveService(db, project.id, input.service);
      const op: StagedOp = { type: "volume.delete", service: svc.id };
      const key = targetKeyOf(op);
      const current = await currentVolume(db, svc.id, environment.id);
      if (!current || current.status === "pending_deletion") {
        // Deleting a volume that is only staged takes the staged one out.
        if (rowOf(key)?.op.type === "volume.set") return { op, base: {}, diff: [], unstage: key };
        if (current) throw volumeScheduledForDeletion();
        throw notFound("Volume");
      }
      await assertNotMoving(db, current);
      return { op, base: { volume: volumeBase(current) }, diff: volumeDiff(current, null) };
    }

    case "domain.add": {
      const svc = await liveService(db, project.id, input.service);
      const hostname = await checkCustomHostname(ctx.c, db, input.hostname);
      const op: StagedOp = { type: "domain.add", service: svc.id, hostname };
      const prior = rowOf(targetKeyOf(op));
      if (prior?.op.type === "domain.remove" && prior.op.service === svc.id) {
        // Adding back a domain staged for removal just keeps it.
        return { op, base: {}, diff: [], unstage: prior.targetKey };
      }
      await assertHostnameFree(db, hostname, Date.now());
      return {
        op,
        base: {},
        diff: [{ path: `/domains/${hostname}`, before: null, after: { hostname } }],
      };
    }

    case "domain.remove": {
      const domain = await db.query.domains.findFirst({ where: eq(domains.id, input.domain_id) });
      if (!domain || domain.environmentId !== environment.id) throw notFound("Domain");
      const svc = await liveService(db, project.id, domain.serviceId);
      if (domain.type !== "custom") {
        throw new ApiError(
          409,
          "conflict",
          "Turn off the generated domain under Networking instead",
        );
      }
      return {
        op: {
          type: "domain.remove",
          domain_id: domain.id,
          hostname: domain.hostname,
          service: svc.id,
        },
        base: {},
        diff: [
          {
            path: `/domains/${domain.hostname}`,
            before: { hostname: domain.hostname, status: domain.status },
            after: null,
          },
        ],
      };
    }

    case "variable.delete": {
      if (input.scope === "service" && !isNewServiceRef(input.service!)) {
        await liveService(db, project.id, input.service!);
      }
      const op: StagedOp = {
        type: "variable.delete",
        scope: input.scope,
        ...(input.scope === "service" ? { service: input.service! } : {}),
        key: input.key,
      };
      const key = targetKeyOf(op);
      const target = variableTargetOf(project, environment, input.scope, input.service);
      const prior = target ? await currentVariable(db, target, input.key) : undefined;
      if (!prior || !target) {
        if (rowOf(key)) return { op, base: {}, diff: [], unstage: key };
        throw notFound("Variable");
      }
      return {
        op,
        base: rowOf(key)?.base ?? { variable_version: prior.version },
        diff: [
          {
            path: `/variables/${input.key}`,
            before: variableSide(prior.tier, await storedFingerprint(ctx, prior)),
            after: null,
          },
        ],
      };
    }
  }
}

/**
 * The base a volume op records: the volume as it is, or `null`.
 *
 * @param volume - The service's volume in the environment.
 * @returns The `StagedBase.volume` value.
 */
export function volumeBase(volume: VolumeRow | undefined): StagedBase["volume"] {
  return volume ? { id: volume.id, size_mb: volume.sizeMb } : null;
}

/**
 * The volume a volume op acts on: live or soft-deleted, but not gone.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @returns The row, or `undefined`.
 */
export function currentVolume(db: Db, serviceId: string, environmentId: string) {
  return volumeOf(db, serviceId, environmentId);
}

/**
 * The value-free review entry of a volume op.
 *
 * @param current - The volume as it is.
 * @param after - What the op leaves, or `null` for a deletion.
 * @returns Diff entries.
 */
export function volumeDiff(
  current: VolumeRow | undefined,
  after: { mount_path: string; size_mb: number } | null,
): DiffEntry[] {
  if (current && after) {
    return [{ path: "/volume/size_mb", before: current.sizeMb, after: after.size_mb }];
  }
  return [
    {
      path: "/volume",
      before: current ? { mount_path: current.mountPath, size_mb: current.sizeMb } : null,
      after,
    },
  ];
}

const volumeScheduledForDeletion = () =>
  new ApiError(
    409,
    "conflict",
    "The service's volume is scheduled for deletion; undelete it before changing it",
  );

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// -----------------------------------------------------------------------------
// Mutations
// -----------------------------------------------------------------------------

/** Most times staging reloads and retries after losing a race, when the caller didn't pin a revision. */
const STAGE_ATTEMPTS = 3;

async function reload(db: Db, set: ChangeSetRow): Promise<ChangeSetRow> {
  const row = await db.query.changeSets.findFirst({
    where: (t, { eq: e }) => e(t.id, set.id),
  });
  if (!row) throw notFound("Change set");
  return row;
}

function assertEditable(set: ChangeSetRow, expectedRevision: number | undefined): void {
  if (set.status !== "open") throw notOpen(set);
  if (expectedRevision !== undefined && expectedRevision !== set.revision) {
    throw changeSetChanged(set.revision);
  }
}

/**
 * Retries `attempt` after a lost revision race when the caller didn't pin
 * one; with `expectedRevision`, the 409 goes to the caller.
 */
async function withRetry<T>(
  expectedRevision: number | undefined,
  attempt: () => Promise<T>,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      const raced = err instanceof ApiError && err.code === "change_set_changed";
      if (!raced || expectedRevision !== undefined || i >= STAGE_ATTEMPTS) throw err;
    }
  }
}

/**
 * Stages an op into an open set, coalescing it with what the set holds.
 *
 * @param ctx - Database, keys, project, environment and caller.
 * @param set - The set.
 * @param input - The validated op.
 * @param expectedRevision - Refuse unless the set is still at this revision.
 * @returns The set after the change.
 * @throws {ApiError} 400 for invalid ops, 403, 404 for unknown targets, 409 when the set moved on or is closed.
 */
export async function stageIntoSet(
  ctx: StagingContext,
  set: ChangeSetRow,
  input: StagedOpRequest,
  expectedRevision?: number,
): Promise<ChangeSetRow> {
  authorizeStaging(ctx.caller, input);
  const { db } = ctx;
  return withRetry(expectedRevision, async () => {
    const current = await reload(db, set);
    assertEditable(current, expectedRevision);
    const rows = await loadOps(db, current.id);
    const pending = rows.filter((r) => r.status !== "applied");
    const entries: StagedEntry[] = pending.map((r) => ({ target_key: r.targetKey, op: r.op }));
    const prepared = await prepare(ctx, entries, rows, input);

    if (prepared.unstage) {
      const bumped = await bumpRevision(db, current);
      await db
        .delete(stagedChanges)
        .where(
          and(
            eq(stagedChanges.changeSetId, current.id),
            eq(stagedChanges.targetKey, prepared.unstage),
          ),
        );
      return bumped;
    }

    const result = coalesce(entries, prepared.op);
    if (!result.ok) {
      throw new ApiError(
        result.code === "too_many_ops" ? 409 : 400,
        result.code === "too_many_ops" ? "conflict" : "invalid_request",
        result.message,
      );
    }
    const prior = pending.find((r) => r.targetKey === result.entry.target_key);
    const id = prior?.id ?? newId("stagedChange");
    const valueSealed = prepared.seal ? await prepared.seal(current.id, id) : null;
    const bumped = await bumpRevision(db, current);
    const now = new Date();
    const writes = [];
    if (result.drop.length) {
      writes.push(
        db
          .delete(stagedChanges)
          .where(
            and(
              eq(stagedChanges.changeSetId, current.id),
              inArray(stagedChanges.targetKey, result.drop),
            ),
          ),
      );
    }
    if (prior) {
      writes.push(
        db
          .update(stagedChanges)
          .set({
            op: result.entry.op,
            valueSealed,
            base: prepared.base,
            diff: prepared.diff,
            status: "pending",
            conflict: null,
            createdBy: ctx.caller.user.id,
            updatedAt: now,
          })
          .where(eq(stagedChanges.id, prior.id)),
      );
    } else {
      writes.push(
        db.insert(stagedChanges).values({
          id,
          changeSetId: current.id,
          seq: rows.reduce((max, r) => Math.max(max, r.seq), 0) + 1,
          targetKey: result.entry.target_key,
          op: result.entry.op,
          valueSealed,
          base: prepared.base,
          diff: prepared.diff,
          status: "pending",
          createdBy: ctx.caller.user.id,
        }),
      );
    }
    await db.batch(writes as [(typeof writes)[number], ...typeof writes]);
    return bumped;
  });
}

/**
 * Removes an op, and with a `service.create` every op on the service it would create.
 *
 * @param db - Database client.
 * @param set - The set.
 * @param opId - The staged change.
 * @param expectedRevision - Refuse unless the set is still at this revision.
 * @returns The set after the change.
 */
export async function unstage(
  db: Db,
  set: ChangeSetRow,
  opId: string,
  expectedRevision?: number,
): Promise<ChangeSetRow> {
  return withRetry(expectedRevision, async () => {
    const current = await reload(db, set);
    assertEditable(current, expectedRevision);
    const rows = await loadOps(db, current.id);
    const row = rows.find((r) => r.id === opId && r.status !== "applied");
    if (!row) throw notFound("Staged change");
    const ids = [row.id];
    if (row.op.type === "service.create") {
      const ref = row.op.ref;
      for (const r of rows) {
        if (r.status !== "applied" && r.id !== row.id && serviceOfOp(r.op) === ref) ids.push(r.id);
      }
    }
    const bumped = await bumpRevision(db, current);
    await db.delete(stagedChanges).where(inArray(stagedChanges.id, ids));
    return bumped;
  });
}

/**
 * Settles a conflicted op. `theirs` drops it; `mine` rebases it onto the
 * current state, recomputing its diff, and keeps its values.
 *
 * @param ctx - Database, keys, project, environment and caller.
 * @param set - The set.
 * @param opId - The conflicted op.
 * @param keep - Which side wins.
 * @param expectedRevision - The revision the caller reviewed.
 * @returns The set after the change.
 * @throws {ApiError} 409 when the op isn't conflicted, or `mine` targets something that no longer exists.
 */
export async function resolveConflict(
  ctx: StagingContext,
  set: ChangeSetRow,
  opId: string,
  keep: "mine" | "theirs",
  expectedRevision: number,
): Promise<ChangeSetRow> {
  const { db } = ctx;
  const current = await reload(db, set);
  assertEditable(current, expectedRevision);
  const rows = await loadOps(db, current.id);
  const row = rows.find((r) => r.id === opId);
  if (!row) throw notFound("Staged change");
  if (row.status !== "conflicted")
    throw new ApiError(409, "conflict", "That change has no conflict");
  authorizeStaging(ctx.caller, row.op);
  if (keep === "theirs") {
    const bumped = await bumpRevision(db, current);
    await db.delete(stagedChanges).where(eq(stagedChanges.id, row.id));
    return bumped;
  }
  if (row.conflict?.deleted) {
    throw new ApiError(409, "conflict", "What this change targets no longer exists; take theirs");
  }
  const rebased = await rebaseRow(ctx, row);
  const bumped = await bumpRevision(db, current);
  await db
    .update(stagedChanges)
    .set({ ...rebased, status: "pending", conflict: null, updatedAt: new Date() })
    .where(eq(stagedChanges.id, row.id));
  return bumped;
}

/**
 * An op's base and diff recomputed against the current state, keeping its values.
 *
 * @param ctx - Database, keys, project and environment.
 * @param row - The staged change.
 * @returns The new `base` and `diff`.
 */
export async function rebaseRow(
  ctx: Pick<StagingContext, "db" | "keys" | "project" | "environment">,
  row: StagedRow,
): Promise<{ base: StagedBase; diff: DiffEntry[] }> {
  const { db, project, environment } = ctx;
  const op = row.op;
  switch (op.type) {
    case "config.patch": {
      const latest = await configAt(db, op.service, environment.id);
      if (!latest) throw notFound("Service config");
      const before = specOf(latest);
      return {
        base: { config_version: latest.version },
        diff: configDiff(before, mergeConfig(before, op.patch)),
      };
    }
    case "variable.set":
    case "variable.delete": {
      const target = variableTargetOf(project, environment, op.scope, op.service);
      const prior = target ? await currentVariable(db, target, op.key) : undefined;
      const before =
        prior && target ? variableSide(prior.tier, await storedFingerprint(ctx, prior)) : null;
      return {
        base: { variable_version: prior?.version ?? null },
        diff: [
          {
            path: `/variables/${op.key}`,
            before,
            after: op.type === "variable.set" ? variableSide(op.staged_tier, op.fingerprint) : null,
          },
        ],
      };
    }
    case "service.update": {
      const svc = await liveService(db, project.id, op.service_id);
      const service: Record<string, unknown> = {};
      const diff: DiffEntry[] = [];
      for (const field of ["name", "slug", "icon"] as const) {
        if (op[field] === undefined) continue;
        service[field] = svc[field];
        diff.push({ path: `/${field}`, before: svc[field], after: op[field] });
      }
      return { base: { service }, diff };
    }
    case "volume.set": {
      const current = await currentVolume(db, op.service, environment.id);
      return {
        base: { volume: volumeBase(current) },
        diff: volumeDiff(current, {
          mount_path: current?.mountPath ?? op.mount_path ?? "",
          size_mb: op.size_mb,
        }),
      };
    }
    default:
      return { base: row.base, diff: row.diff };
  }
}

/**
 * Marks ops conflicted (or clears conflicts) after a review or a refused apply.
 *
 * @param db - Database client.
 * @param conflicts - Conflict per op ID.
 */
export async function recordConflicts(
  db: Db,
  conflicts: ReadonlyMap<string, StagedConflict>,
): Promise<void> {
  if (!conflicts.size) return;
  const now = new Date();
  const writes = [...conflicts].map(([id, conflict]) =>
    db
      .update(stagedChanges)
      .set({ status: "conflicted", conflict, updatedAt: now })
      .where(eq(stagedChanges.id, id)),
  );
  await db.batch(writes as [(typeof writes)[number], ...typeof writes]);
}

/**
 * Discards an open set and erases its sealed values.
 *
 * @param db - Database client.
 * @param input - The set, who discards it, and the audit actor.
 * @returns The discarded set.
 * @throws {ApiError} 409 when it isn't open or moved on.
 */
export async function discardSet(
  db: Db,
  input: {
    set: ChangeSetRow;
    project: ProjectRow;
    caller: Caller;
    expectedRevision?: number;
    ip: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<ChangeSetRow> {
  const current = await reload(db, input.set);
  assertEditable(current, input.expectedRevision);
  const rows = await loadOps(db, current.id);
  const nameOf = await serviceNamer(db, current.projectId, rows);
  const now = new Date();
  const [row] = await db
    .update(changeSets)
    .set({ status: "discarded", revision: current.revision + 1, updatedAt: now })
    .where(
      and(
        eq(changeSets.id, current.id),
        eq(changeSets.status, "open"),
        eq(changeSets.revision, current.revision),
      ),
    )
    .returning();
  if (!row) throw changeSetChanged((await reload(db, current)).revision);
  await db.batch([
    db
      .update(stagedChanges)
      .set({ valueSealed: null, updatedAt: now })
      .where(eq(stagedChanges.changeSetId, current.id)),
    auditInsert(db, {
      workspaceId: input.project.workspaceId,
      ...input.caller.actor,
      action: "change_set.discarded",
      targetType: "change_set",
      targetId: current.id,
      metadata: {
        project_id: current.projectId,
        environment_id: current.environmentId,
        ops: rows.filter((r) => r.status !== "applied").map((r) => describeOp(r.op, nameOf)),
        ...input.metadata,
      },
      ip: input.ip,
    }),
  ]);
  return row;
}

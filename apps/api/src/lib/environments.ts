/**
 * Environment lifecycle (ADR 0007, "Environment lifecycle"), shared by the
 * environment routes and PR previews:
 * - {@link planEnvironmentCopy}: the configs, variables and empty volumes a
 *   new environment gets from another one, database credentials always
 *   fresh;
 * - {@link finishEnvironment}: generated domains and paused cron schedules;
 * - {@link seedDatabasesFromBackups}: restores of the source's latest dumps;
 * - {@link retireEnvironment} / {@link reapRetiredEnvironments}: deletion;
 * - {@link environmentDiff}: what differs between two environments, secrets
 *   compared by fingerprint only;
 * - {@link promotionSource}: the deployment a `deployment.promote` op runs.
 *
 * @module
 */
import {
  backups,
  cronStates,
  type Db,
  deployments,
  domains,
  type environments,
  environments as environmentsTable,
  restores,
  type services,
  variables,
  volumes,
} from "@roundhouse/db";
import {
  CANCELLABLE_DEPLOYMENT_STATUSES,
  classifyVariable,
  configDiff,
  DEFAULT_DATABASE_VOLUME_MB,
  type DeploymentStatus,
  type DiffEntry,
  databaseVersion,
  decideVariableTier,
  defaultServiceConfig,
  LIVE_VOLUME_STATUSES,
  newId,
  type ServiceConfigSpec,
  VOLUME_DELETE_GRACE_MS,
} from "@roundhouse/shared";
import { and, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import type { Env } from "../env";
import { auditInsert } from "./audit";
import { startRestoreWorkflow } from "./backups/restores";
import { isBackupStorageConfigured } from "./backups/storage";
import type { KeyEnv } from "./crypto";
import { databaseVariables } from "./databases";
import {
  cancelDeployment,
  IllegalTransitionError,
  type LifecycleContext,
  retireDeployments,
  transitionDeployment,
} from "./deployments";
import { nodesOfDeployments, refreshNodes } from "./desired-state";
import { ApiError, conflict } from "./errors";
import { type FreshCredentials, planPreviewVariables } from "./previews/variables";
import { latestConfig, liveServices, specOf, syncGeneratedDomain } from "./projects";
import { getIngressSettings } from "./settings";
import { openVariable, projectKey, type StoredVariable, sealVariable } from "./variables";
import { clampVolumeMb, GONE_VOLUME_STATUSES, volumeOf } from "./volumes";

type EnvironmentRow = typeof environments.$inferSelect;
type ServiceRow = typeof services.$inferSelect;

// -----------------------------------------------------------------------------
// Copy
// -----------------------------------------------------------------------------

/**
 * Which of the source's variables a copy takes: `all`, `non_secret` (plain
 * tier only), `none`, or `withhold` (every one, with secrets, credential-
 * looking values and values resolving through them replaced by empty
 * placeholders; see `planPreviewVariables`).
 */
export type VariableCopy = "all" | "non_secret" | "none" | "withhold";

/** What {@link planEnvironmentCopy} produces, ready for one batch. */
export interface EnvironmentCopy {
  configs: { service: ServiceRow; spec: ServiceConfigSpec }[];
  variableRows: (typeof variables.$inferInsert)[];
  volumeRows: (typeof volumes.$inferInsert)[];
}

/**
 * Fresh credentials for each database service: a new environment's database
 * starts with an empty volume, and the image applies credentials only when it
 * initialises, so copied ones would neither work nor be needed (ADR 0007).
 */
function freshCredentials(services: readonly ServiceRow[]): FreshCredentials[] {
  const out: FreshCredentials[] = [];
  for (const service of services) {
    if (!service.databaseEngine) continue;
    const version = databaseVersion(service.databaseEngine, service.databaseVersion);
    if (!version) continue;
    out.push({
      serviceId: service.id,
      entries: databaseVariables(service.databaseEngine, version.version).map((e) => {
        const decision = decideVariableTier({
          classification: classifyVariable(e.key, e.value!),
          ...(e.tier ? { requested: e.tier } : {}),
          valueProvided: true,
        });
        if (!decision.ok) throw new Error(`${e.key}: ${decision.code}`);
        return { key: e.key, value: e.value!, tier: decision.tier, locked: decision.locked };
      }),
    });
  }
  return out;
}

/**
 * Plans what a new environment `environmentId` gets from `source`.
 *
 * 1. Configs: each copied service's latest config in the source, through
 *    `transform`; other live services start from the defaults of their
 *    source config in `fallback` (blank services, as before cloning existed).
 * 2. Variables per `variables`, of copied services and the shared ones;
 *    database credentials are always fresh, whatever the mode.
 * 3. Volumes: empty, the source volume's mount path and size, at most
 *    `volumeCapMb`.
 *
 * @param db - Database client.
 * @param keys - Master keyring bindings (the project DEK opens and seals values).
 * @param input - Project, new environment ID, source, scope and modes.
 * @returns Rows to insert in the environment's batch.
 */
export async function planEnvironmentCopy(
  db: Db,
  keys: KeyEnv,
  input: {
    projectId: string;
    environmentId: string;
    source: EnvironmentRow | null;
    /** Services to copy; every live service when `null`. */
    services: readonly string[] | null;
    variables: VariableCopy;
    transform?: (spec: ServiceConfigSpec) => ServiceConfigSpec;
    volumeCapMb?: number;
    /** Where services the copy skips take their source from; production by default. */
    fallback: EnvironmentRow | null;
  },
): Promise<EnvironmentCopy> {
  const live = await liveServices(db, input.projectId);
  const copied = new Set(
    input.source
      ? live.filter((s) => !input.services || input.services.includes(s.id)).map((s) => s.id)
      : [],
  );
  const configs: EnvironmentCopy["configs"] = [];
  for (const s of live) {
    const fromSource =
      input.source && copied.has(s.id) ? await latestConfig(db, s.id, input.source.id) : undefined;
    if (fromSource) {
      const spec = specOf(fromSource);
      configs.push({ service: s, spec: input.transform ? input.transform(spec) : spec });
      continue;
    }
    copied.delete(s.id);
    const fallback = input.fallback ? await latestConfig(db, s.id, input.fallback.id) : undefined;
    if (fallback) configs.push({ service: s, spec: defaultServiceConfig(fallback.source) });
  }

  const key = await projectKey(db, keys, input.projectId);
  const baseRows =
    input.source && input.variables !== "none"
      ? await db
          .select()
          .from(variables)
          .where(
            and(
              eq(variables.projectId, input.projectId),
              eq(variables.environmentId, input.source.id),
            ),
          )
      : [];
  const planned = planPreviewVariables({
    base: await Promise.all(
      baseRows
        .filter((r) => r.scope === "shared" || (r.serviceId !== null && copied.has(r.serviceId)))
        .filter((r) => input.variables !== "non_secret" || r.tier !== "secret")
        .map(async (r) => ({
          scope: r.scope,
          serviceId: r.serviceId,
          key: r.key,
          value: await openVariable(key, r),
          tier: r.tier,
          locked: r.locked,
          availableAtBuild: r.availableAtBuild,
          mountAsFile: r.mountAsFile,
        })),
    ),
    slugs: new Map(live.map((s) => [s.id, s.slug])),
    fresh: freshCredentials(configs.map((c) => c.service)),
    withhold: input.variables === "withhold",
  });
  const variableRows = await Promise.all(
    planned.map(async (v) => {
      const coordinates: StoredVariable = {
        id: newId("variable"),
        projectId: input.projectId,
        environmentId: input.environmentId,
        scope: v.scope,
        serviceId: v.serviceId,
        key: v.key,
        version: 1,
      };
      return {
        ...coordinates,
        ...(await sealVariable(key, coordinates, v.value)),
        tier: v.tier,
        locked: v.locked,
        availableAtBuild: v.availableAtBuild,
        mountAsFile: v.mountAsFile,
        withheld: v.withheld,
        updatedBy: null,
      } satisfies typeof variables.$inferInsert;
    }),
  );

  const volumeRows: EnvironmentCopy["volumeRows"] = [];
  for (const { service } of configs) {
    const sourceVolume = input.source ? await volumeOf(db, service.id, input.source.id) : undefined;
    let mountPath = sourceVolume?.mountPath;
    let sizeMb = sourceVolume?.sizeMb ?? DEFAULT_DATABASE_VOLUME_MB;
    if (!mountPath && service.databaseEngine) {
      mountPath = databaseVersion(service.databaseEngine, service.databaseVersion)?.mountPath;
      sizeMb = DEFAULT_DATABASE_VOLUME_MB;
    }
    if (!mountPath) continue;
    volumeRows.push({
      id: newId("volume"),
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: service.id,
      mountPath,
      sizeMb: clampVolumeMb(input.volumeCapMb ? Math.min(sizeMb, input.volumeCapMb) : sizeMb),
      status: "pending",
    });
  }
  return { configs, variableRows, volumeRows };
}

/**
 * Generated domains and paused cron schedules of a new environment;
 * idempotent. Custom domains, TCP proxies and backup policies are never
 * copied (ADR 0007).
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @param environmentId - The new environment.
 * @throws {ApiError} 404 when the environment is gone.
 */
export async function finishEnvironment(
  db: Db,
  projectId: string,
  environmentId: string,
): Promise<void> {
  const [env] = await db
    .select()
    .from(environmentsTable)
    .where(eq(environmentsTable.id, environmentId))
    .limit(1);
  if (!env) throw new ApiError(404, "not_found", "The environment was deleted");
  const ingress = await getIngressSettings(db);
  for (const s of await liveServices(db, projectId)) {
    const row = await latestConfig(db, s.id, environmentId);
    if (!row) continue;
    await syncGeneratedDomain(
      db,
      {
        serviceId: s.id,
        serviceSlug: s.slug,
        environmentId,
        environmentSlug: env.slug,
        spec: specOf(row),
      },
      ingress,
    );
    if (s.kind === "cron") {
      // ADR 0007: a new environment never runs its source's schedules on its own.
      await db
        .insert(cronStates)
        .values({ serviceId: s.id, environmentId, paused: true })
        .onConflictDoNothing();
    }
  }
}

// -----------------------------------------------------------------------------
// Seed
// -----------------------------------------------------------------------------

/**
 * Restores each database of a new environment from `fromEnvironmentId`'s
 * latest successful dump, through the restore workflow's new-database path:
 * it waits for the database to run healthy, and the agent keeps the new
 * environment's fresh credentials over the dump's. Snapshots don't qualify:
 * they carry the source's passwords. Nothing happens without backup storage.
 *
 * @param ctx - Database and bindings.
 * @param input - Project, workspace, source, target and audit context.
 * @returns IDs of the restores started; idempotent per database.
 */
export async function seedDatabasesFromBackups(
  ctx: LifecycleContext,
  input: {
    projectId: string;
    workspaceId: string;
    fromEnvironmentId: string;
    environmentId: string;
    actor: { actorType: "user" | "token" | "system"; actorId: string | null };
    requestedBy: string | null;
    auditMetadata: Record<string, unknown>;
  },
): Promise<string[]> {
  const { db } = ctx;
  if (!(await isBackupStorageConfigured(db))) return [];
  const started: string[] = [];
  for (const s of await liveServices(db, input.projectId)) {
    if (!s.databaseEngine || !(await latestConfig(db, s.id, input.environmentId))) continue;
    const [backup] = await db
      .select()
      .from(backups)
      .where(
        and(
          eq(backups.serviceId, s.id),
          eq(backups.environmentId, input.fromEnvironmentId),
          eq(backups.status, "succeeded"),
          eq(backups.method, "dump"),
        ),
      )
      .orderBy(desc(backups.finishedAt), desc(backups.id))
      .limit(1);
    if (!backup) continue;
    const [already] = await db
      .select({ id: restores.id })
      .from(restores)
      .where(
        and(
          eq(restores.targetServiceId, s.id),
          eq(restores.targetEnvironmentId, input.environmentId),
        ),
      )
      .limit(1);
    if (already) continue;
    const id = newId("restore");
    const at = new Date();
    await db.batch([
      db.insert(restores).values({
        id,
        backupId: backup.id,
        mode: "new_service",
        targetServiceId: s.id,
        targetEnvironmentId: input.environmentId,
        safetyBackupId: null,
        status: "queued",
        requestedBy: input.requestedBy,
        createdAt: at,
        updatedAt: at,
      }),
      auditInsert(db, {
        workspaceId: input.workspaceId,
        ...input.actor,
        action: "restore.started",
        targetType: "restore",
        targetId: id,
        metadata: {
          project_id: input.projectId,
          backup_id: backup.id,
          service_id: s.id,
          environment_id: input.environmentId,
          ...input.auditMetadata,
        },
      }),
    ]);
    await startRestoreWorkflow(ctx.env, id);
    started.push(id);
  }
  return started;
}

// -----------------------------------------------------------------------------
// Delete
// -----------------------------------------------------------------------------

/**
 * Retires an environment (ADR 0007, "Delete"): stops its deployments and
 * pulls their replicas, schedules its volumes for deletion after the grace
 * period (ADR 0004), deletes its domains, pauses its cron schedules, and
 * hides it with its slug freed. The row itself goes once its volumes are
 * gone; see {@link reapRetiredEnvironments}. Safe to retry.
 *
 * SECURITY: a production environment is never retired, whatever the caller
 * passes.
 *
 * @param ctx - Database and bindings.
 * @param projectId - The owning project.
 * @param environmentId - The environment.
 * @param reason - Shown on the stopped deployments.
 * @param now - Unix ms.
 * @returns Whether it retired something.
 */
export async function retireEnvironment(
  ctx: LifecycleContext,
  projectId: string,
  environmentId: string,
  reason: string,
  now = Date.now(),
): Promise<boolean> {
  const { db } = ctx;
  const [env] = await db
    .select()
    .from(environmentsTable)
    .where(and(eq(environmentsTable.id, environmentId), eq(environmentsTable.projectId, projectId)))
    .limit(1);
  if (!env || env.kind === "production") return false;

  const live = await db
    .select({ id: deployments.id, status: deployments.status })
    .from(deployments)
    .where(
      and(
        eq(deployments.environmentId, environmentId),
        inArray(deployments.status, [...CANCELLABLE_DEPLOYMENT_STATUSES, "active", "crashed"]),
      ),
    );
  for (const d of live) await stopDeployment(ctx, projectId, d.id, d.status, reason);
  const holders = await db
    .update(volumes)
    .set({
      status: "pending_deletion",
      deleteAfter: new Date(now + VOLUME_DELETE_GRACE_MS),
      deleteSentAt: null,
      updatedAt: new Date(now),
    })
    .where(
      and(
        eq(volumes.environmentId, environmentId),
        inArray(volumes.status, [...LIVE_VOLUME_STATUSES]),
      ),
    )
    .returning({ nodeId: volumes.nodeId });
  const replicaNodes = await nodesOfDeployments(
    db,
    live.map((d) => d.id),
  );
  await db.batch([
    db.delete(domains).where(eq(domains.environmentId, environmentId)),
    db
      .update(cronStates)
      .set({ paused: true, nextRunAt: null, updatedAt: new Date(now) })
      .where(eq(cronStates.environmentId, environmentId)),
    db
      .update(environmentsTable)
      .set({
        retiredAt: env.retiredAt ?? new Date(now),
        // Frees the slug (`pr-<n>` for a PR's next preview); IDs are unique, so this is too.
        slug: env.retiredAt ? env.slug : `retired-${environmentId.slice(-16).toLowerCase()}`,
        updatedAt: new Date(now),
      })
      .where(eq(environmentsTable.id, environmentId)),
  ]);
  await retireDeployments(
    ctx,
    live.map((d) => d.id),
  );
  const nodes = new Set([...replicaNodes, ...holders.flatMap((h) => (h.nodeId ? [h.nodeId] : []))]);
  if (nodes.size) await refreshNodes(ctx.env, db, [...nodes]);
  return true;
}

/**
 * Stops one deployment of a retiring environment: cancels it while in
 * flight, removes it once live. A rollout can finish between reading its
 * status and acting on it, so an illegal transition re-reads and tries again.
 */
async function stopDeployment(
  ctx: LifecycleContext,
  projectId: string,
  deploymentId: string,
  status: DeploymentStatus,
  reason: string,
): Promise<void> {
  let current: DeploymentStatus | undefined = status;
  for (let attempt = 0; attempt < 3 && current; attempt++) {
    try {
      if (CANCELLABLE_DEPLOYMENT_STATUSES.includes(current)) {
        await cancelDeployment(ctx, projectId, deploymentId, reason);
      } else if (current === "active" || current === "crashed") {
        await transitionDeployment(ctx, projectId, deploymentId, "removed", { reason });
      }
      return;
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) throw err;
      const [row] = await ctx.db
        .select({ status: deployments.status })
        .from(deployments)
        .where(eq(deployments.id, deploymentId))
        .limit(1);
      current = row?.status;
    }
  }
}

/** Environments one tick reaps at most. */
const REAP_BATCH = 20;

/**
 * Deletes retired environments whose volumes are all gone and whose
 * deployments all ended, which cascades to their configs, variables and
 * deployment history.
 *
 * @param _env - Worker bindings.
 * @param db - Database client.
 * @returns How many were deleted.
 */
export async function reapRetiredEnvironments(_env: Env, db: Db): Promise<number> {
  const retired = await db
    .select({ id: environmentsTable.id })
    .from(environmentsTable)
    .where(isNotNull(environmentsTable.retiredAt))
    .limit(REAP_BATCH);
  let reaped = 0;
  for (const { id } of retired) {
    const [volume] = await db
      .select({ id: volumes.id })
      .from(volumes)
      .where(
        and(eq(volumes.environmentId, id), notInArray(volumes.status, [...GONE_VOLUME_STATUSES])),
      )
      .limit(1);
    if (volume) continue;
    const [running] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.environmentId, id),
          inArray(deployments.status, [...CANCELLABLE_DEPLOYMENT_STATUSES, "active", "crashed"]),
        ),
      )
      .limit(1);
    if (running) continue;
    const deleted = await db
      .delete(environmentsTable)
      .where(and(eq(environmentsTable.id, id), isNotNull(environmentsTable.retiredAt)))
      .returning({ id: environmentsTable.id });
    reaped += deleted.length;
  }
  return reaped;
}

// -----------------------------------------------------------------------------
// Diff
// -----------------------------------------------------------------------------

/** Config paths that differ between environments by design, left out of a diff. */
const DIFF_IGNORED_PATHS = ["/networking/generated_domain", "/placement/node_selector"];

/** How a variable compares between two environments. */
export interface VariableComparison {
  key: string;
  change: "added" | "removed" | "changed" | "same";
  /** Secret on either side; its value is never shown. */
  secret: boolean;
}

/** One service in an environment diff. */
export interface ServiceComparison {
  service_id: string;
  slug: string;
  presence: "both" | "only_base" | "only_target";
  config: DiffEntry[];
  variables: VariableComparison[];
  image: { base: string | null; target: string | null };
}

type VariableRow = typeof variables.$inferSelect;

/**
 * Compares variables by fingerprint (HMAC under the project's key), never by
 * value. A row written before fingerprints existed compares as `changed`
 * unless both sides lack one.
 */
function compareVariables(
  base: readonly VariableRow[],
  target: readonly VariableRow[],
  credentialKeys: ReadonlySet<string>,
): VariableComparison[] {
  const b = new Map(base.map((r) => [r.key, r]));
  const t = new Map(target.map((r) => [r.key, r]));
  const out: VariableComparison[] = [];
  for (const key of [...new Set([...b.keys(), ...t.keys()])].sort()) {
    // Database credentials differ per environment by design (ADR 0007).
    if (credentialKeys.has(key)) continue;
    const x = b.get(key);
    const y = t.get(key);
    const secret = x?.tier === "secret" || y?.tier === "secret";
    const change = !x
      ? "added"
      : !y
        ? "removed"
        : x.fingerprint !== null &&
            x.fingerprint === y.fingerprint &&
            x.tier === y.tier &&
            x.availableAtBuild === y.availableAtBuild &&
            x.mountAsFile === y.mountAsFile
          ? "same"
          : "changed";
    out.push({ key, change, secret });
  }
  return out;
}

/** Keys of a database service's generated credentials. */
function credentialKeysOf(service: ServiceRow): Set<string> {
  if (!service.databaseEngine) return new Set();
  const version = databaseVersion(service.databaseEngine, service.databaseVersion);
  if (!version) return new Set();
  return new Set(databaseVariables(service.databaseEngine, version.version).map((e) => e.key));
}

/** The image of a service's active deployment in an environment, by digest. */
async function activeImage(db: Db, serviceId: string, environmentId: string) {
  const [row] = await db
    .select({ image: deployments.image })
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, serviceId),
        eq(deployments.environmentId, environmentId),
        eq(deployments.status, "active"),
      ),
    )
    .orderBy(desc(deployments.id))
    .limit(1);
  return row?.image ?? null;
}

/**
 * What differs between two environments of a project (ADR 0007, "Diff"):
 * per service its presence, config differences (JSON pointers, ignoring
 * paths that differ by design), variables by fingerprint, and the images of
 * the active deployments; and the shared variables. Changed services come
 * first.
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @param base - The base environment.
 * @param target - The target environment.
 * @returns The diff.
 */
export async function environmentDiff(
  db: Db,
  projectId: string,
  base: EnvironmentRow,
  target: EnvironmentRow,
) {
  const live = await liveServices(db, projectId);
  const [baseVars, targetVars] = await Promise.all(
    [base.id, target.id].map((environmentId) =>
      db
        .select()
        .from(variables)
        .where(and(eq(variables.projectId, projectId), eq(variables.environmentId, environmentId))),
    ),
  );
  const servicesOut: ServiceComparison[] = [];
  for (const s of live) {
    const [b, t] = await Promise.all([
      latestConfig(db, s.id, base.id),
      latestConfig(db, s.id, target.id),
    ]);
    if (!b && !t) continue;
    const config = configDiff(b ? specOf(b) : null, t ? specOf(t) : null).filter(
      (e) => !DIFF_IGNORED_PATHS.some((p) => e.path === p || e.path.startsWith(`${p}/`)),
    );
    const ofService = (rows: VariableRow[]) =>
      rows.filter((r) => r.scope === "service" && r.serviceId === s.id);
    servicesOut.push({
      service_id: s.id,
      slug: s.slug,
      presence: b && t ? "both" : b ? "only_base" : "only_target",
      config,
      variables: compareVariables(
        ofService(baseVars!),
        ofService(targetVars!),
        credentialKeysOf(s),
      ),
      image: {
        base: await activeImage(db, s.id, base.id),
        target: await activeImage(db, s.id, target.id),
      },
    });
  }
  const changed = (s: ServiceComparison) =>
    s.presence !== "both" ||
    s.config.length > 0 ||
    s.variables.some((v) => v.change !== "same") ||
    s.image.base !== s.image.target;
  servicesOut.sort(
    (x, y) => Number(changed(y)) - Number(changed(x)) || x.slug.localeCompare(y.slug),
  );
  const shared = (rows: VariableRow[]) => rows.filter((r) => r.scope === "shared");
  return {
    base_environment_id: base.id,
    target_environment_id: target.id,
    services: servicesOut,
    shared_variables: compareVariables(shared(baseVars!), shared(targetVars!), new Set()),
  };
}

// -----------------------------------------------------------------------------
// Promote
// -----------------------------------------------------------------------------

/**
 * The deployment a `deployment.promote` op runs: an active deployment of the
 * same service in another environment of the project, with an image.
 *
 * @param db - Database client.
 * @param input - Project, service, target environment and the source deployment.
 * @returns The source deployment.
 * @throws {ApiError} 409 when it isn't (or is no longer) promotable.
 */
export async function promotionSource(
  db: Db,
  input: {
    projectId: string;
    serviceId: string;
    targetEnvironmentId: string;
    fromDeploymentId: string;
  },
) {
  const [row] = await db
    .select({ deployment: deployments, environment: environmentsTable })
    .from(deployments)
    .innerJoin(environmentsTable, eq(environmentsTable.id, deployments.environmentId))
    .where(eq(deployments.id, input.fromDeploymentId))
    .limit(1);
  if (
    !row ||
    row.environment.projectId !== input.projectId ||
    row.deployment.serviceId !== input.serviceId ||
    row.environment.id === input.targetEnvironmentId ||
    row.environment.retiredAt
  ) {
    throw conflict("The deployment to promote is not one of this service's in another environment");
  }
  if (row.deployment.status !== "active" || !row.deployment.image) {
    throw conflict("Only an active deployment with an image can be promoted");
  }
  return row.deployment;
}

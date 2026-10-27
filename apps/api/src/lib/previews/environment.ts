/**
 * A preview's environment (ADR 0007, "Create" and "Delete"): creating it as
 * a capped copy of the base environment, deploying it, tearing it down, and
 * reaping torn-down environments once their volumes are gone.
 *
 * Creating writes, in one batch, the environment, every live service's
 * latest base config (clamped by the caps, merged with the preview node
 * selector), the variables {@link planPreviewVariables} decides, empty
 * volumes no larger than `caps.volume_mb`, and links the preview to it.
 * Then, idempotently: generated domains (never custom ones, TCP proxies or
 * backup policies) and paused cron schedules. A concurrent create of the
 * same preview loses on the `pr-<n>` slug and adopts the winner's.
 *
 * @module
 */
import {
  cronStates,
  type Db,
  deployments,
  domains,
  environments,
  previewEnvironments,
  type projects,
  variables,
  volumes,
} from "@roundhouse/db";
import {
  CANCELLABLE_DEPLOYMENT_STATUSES,
  clampPreviewConfig,
  classifyVariable,
  DEFAULT_DATABASE_VOLUME_MB,
  type DeploymentStatus,
  databaseVersion,
  decideVariableTier,
  LIVE_VOLUME_STATUSES,
  newId,
  previewEnvironmentSlug,
  previewWithholdsSecrets,
  type ServiceConfigSpec,
  VOLUME_DELETE_GRACE_MS,
} from "@roundhouse/shared";
import { and, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import type { Env } from "../../env";
import type { KeyEnv } from "../crypto";
import { databaseVariables } from "../databases";
import {
  cancelDeployment,
  createDeployment,
  IllegalTransitionError,
  type LifecycleContext,
  retireDeployments,
  transitionDeployment,
} from "../deployments";
import { nodesOfDeployments, refreshNodes } from "../desired-state";
import { ApiError, isUniqueViolation } from "../errors";
import { configInsert, latestConfig, liveServices, specOf, syncGeneratedDomain } from "../projects";
import { getIngressSettings } from "../settings";
import { openVariable, projectKey, type StoredVariable, sealVariable } from "../variables";
import { clampVolumeMb, GONE_VOLUME_STATUSES, volumeOf } from "../volumes";
import { previewGitServices } from "./events";
import type { PreviewSettingsRow } from "./settings";
import { type FreshCredentials, planPreviewVariables } from "./variables";

/** A preview row. */
export type PreviewRow = typeof previewEnvironments.$inferSelect;

/** A thrown failure whose message is safe to store and show. */
export class PreviewError extends Error {
  /** @param message - Why, without values or build output. */
  constructor(message: string) {
    super(message);
    this.name = "PreviewError";
  }
}

// -----------------------------------------------------------------------------
// Create
// -----------------------------------------------------------------------------

/**
 * Creates the preview's environment unless it has one, and finishes its
 * setup (domains, paused cron schedules). Safe to retry.
 *
 * @param ctx - Database and bindings.
 * @param input - The preview, its project and settings, and the master keys.
 * @returns The environment ID.
 * @throws {PreviewError} When the base environment is gone, or another
 *   environment already uses the slug.
 */
export async function ensurePreviewEnvironment(
  ctx: LifecycleContext,
  input: {
    preview: PreviewRow;
    project: typeof projects.$inferSelect;
    settings: PreviewSettingsRow;
    keys: KeyEnv;
  },
): Promise<string> {
  const { db } = ctx;
  const { preview, project } = input;
  const current = await reload(db, preview.id);
  let environmentId = current.environmentId;
  if (!environmentId) environmentId = await insertEnvironment(ctx, input);
  await finishEnvironment(db, project.id, environmentId);
  return environmentId;
}

async function reload(db: Db, previewId: string): Promise<PreviewRow> {
  const [row] = await db
    .select()
    .from(previewEnvironments)
    .where(eq(previewEnvironments.id, previewId))
    .limit(1);
  if (!row) throw new PreviewError("The preview was deleted");
  return row;
}

async function insertEnvironment(
  ctx: LifecycleContext,
  input: {
    preview: PreviewRow;
    project: typeof projects.$inferSelect;
    settings: PreviewSettingsRow;
    keys: KeyEnv;
  },
): Promise<string> {
  const { db } = ctx;
  const { preview, project, settings } = input;
  const [base] = await db
    .select()
    .from(environments)
    .where(
      and(
        eq(environments.id, settings.baseEnvironmentId),
        eq(environments.projectId, project.id),
        isNull(environments.retiredAt),
      ),
    )
    .limit(1);
  if (!base) throw new PreviewError("The preview base environment no longer exists");

  const envId = newId("environment");
  const live = await liveServices(db, project.id);
  const configs: { service: (typeof live)[number]; spec: ServiceConfigSpec }[] = [];
  for (const s of live) {
    const row = await latestConfig(db, s.id, base.id);
    if (row)
      configs.push({
        service: s,
        spec: clampPreviewConfig(specOf(row), settings.caps, settings.nodeSelector),
      });
  }

  const key = await projectKey(db, input.keys, project.id);
  const baseRows = await db
    .select()
    .from(variables)
    .where(and(eq(variables.projectId, project.id), eq(variables.environmentId, base.id)));
  const inPreview = new Set(configs.map((c) => c.service.id));
  const fresh: FreshCredentials[] = [];
  for (const { service } of configs) {
    if (!service.databaseEngine) continue;
    const version = databaseVersion(service.databaseEngine, service.databaseVersion);
    if (!version) continue;
    fresh.push({
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
  const withhold = previewWithholdsSecrets(preview.isFork, settings.sameRepoSecrets);
  const planned = planPreviewVariables({
    base: await Promise.all(
      baseRows
        .filter((r) => r.scope === "shared" || (r.serviceId !== null && inPreview.has(r.serviceId)))
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
    fresh,
    withhold,
  });
  const variableRows = await Promise.all(
    planned.map(async (v) => {
      const coordinates: StoredVariable = {
        id: newId("variable"),
        projectId: project.id,
        environmentId: envId,
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

  const volumeRows: (typeof volumes.$inferInsert)[] = [];
  for (const { service } of configs) {
    const baseVolume = await volumeOf(db, service.id, base.id);
    let mountPath = baseVolume?.mountPath;
    let sizeMb = baseVolume?.sizeMb ?? DEFAULT_DATABASE_VOLUME_MB;
    if (!mountPath && service.databaseEngine) {
      mountPath = databaseVersion(service.databaseEngine, service.databaseVersion)?.mountPath;
      sizeMb = DEFAULT_DATABASE_VOLUME_MB;
    }
    if (!mountPath) continue;
    volumeRows.push({
      id: newId("volume"),
      projectId: project.id,
      environmentId: envId,
      serviceId: service.id,
      mountPath,
      sizeMb: clampVolumeMb(Math.min(sizeMb, settings.caps.volume_mb)),
      status: "pending",
    });
  }

  const now = new Date();
  try {
    await db.batch([
      db.insert(environments).values({
        id: envId,
        projectId: project.id,
        name: `PR #${preview.prNumber}`,
        slug: previewEnvironmentSlug(preview.prNumber),
        kind: "preview",
        prNumber: preview.prNumber,
        sourceBranch: preview.headRef,
        previewId: preview.id,
      }),
      ...configs.map((cfg) =>
        configInsert(db, {
          serviceId: cfg.service.id,
          environmentId: envId,
          version: 1,
          createdBy: null,
          spec: cfg.spec,
        }),
      ),
      ...variableRows.map((row) => db.insert(variables).values(row)),
      ...volumeRows.map((row) => db.insert(volumes).values(row)),
      db
        .update(previewEnvironments)
        .set({ environmentId: envId, withheld: withhold, updatedAt: now })
        .where(eq(previewEnvironments.id, preview.id)),
    ]);
  } catch (err) {
    if (!isUniqueViolation(err, "environments.")) throw err;
    // Lost a race with another run creating this preview, whose batch linked it atomically.
    const linked = (await reload(db, preview.id)).environmentId;
    if (linked) return linked;
    throw new PreviewError(
      `Another environment of the project already uses the slug ${previewEnvironmentSlug(preview.prNumber)}`,
    );
  }
  return envId;
}

/** Generated domains and paused cron schedules of a new preview environment; idempotent. */
async function finishEnvironment(db: Db, projectId: string, environmentId: string) {
  const [env] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!env) throw new PreviewError("The preview environment was deleted");
  const ingress = await getIngressSettings(db);
  for (const s of await liveServices(db, projectId)) {
    const row = await latestConfig(db, s.id, environmentId);
    if (!row) continue;
    const spec = specOf(row);
    await syncGeneratedDomain(
      db,
      {
        serviceId: s.id,
        serviceSlug: s.slug,
        environmentId,
        environmentSlug: env.slug,
        spec,
      },
      ingress,
    );
    if (s.kind === "cron") {
      // ADR 0007: a preview never runs its base environment's schedules on its own.
      await db
        .insert(cronStates)
        .values({ serviceId: s.id, environmentId, paused: true })
        .onConflictDoNothing();
    }
  }
}

// -----------------------------------------------------------------------------
// Deploy
// -----------------------------------------------------------------------------

/**
 * Deploys a preview environment. Git services in scope build the PR's head
 * commit; with `scope: "all"` (a new environment) every other service
 * deploys too, git services out of scope at their base branch.
 *
 * SECURITY: a fork's head is deployed only while its approval names exactly
 * that commit; the deploy workflow checks the same again.
 *
 * @param ctx - Database and bindings.
 * @param input - The preview, its settings, environment, scope and origin.
 * @returns IDs of the deployments started.
 * @throws {PreviewError} When a fork's head is not approved.
 */
export async function deployPreview(
  ctx: LifecycleContext,
  input: {
    preview: PreviewRow;
    settings: PreviewSettingsRow;
    environmentId: string;
    scope: "all" | "git";
    origin: string;
  },
): Promise<string[]> {
  const { db } = ctx;
  const { preview, settings, environmentId } = input;
  if (preview.isFork && preview.approvedSha !== preview.headSha) {
    throw new PreviewError("The pull request's head commit is not approved");
  }
  const inScope = new Set(
    (
      await previewGitServices(
        db,
        preview.projectId,
        settings.baseEnvironmentId,
        settings.services ?? null,
      )
    ).map((t) => t.serviceId),
  );
  const started: string[] = [];
  for (const s of await liveServices(db, preview.projectId)) {
    const config = await latestConfig(db, s.id, environmentId);
    if (!config) continue;
    const git = config.source.type === "git";
    const atHead = git && inScope.has(s.id);
    if (input.scope === "git" && !atHead) continue;
    try {
      const deployment = await createDeployment(ctx, {
        projectId: preview.projectId,
        serviceId: s.id,
        environmentId,
        trigger: "push",
        triggeredBy: null,
        origin: input.origin,
        ...(atHead
          ? {
              commit: {
                sha: preview.headSha,
                message: preview.title.slice(0, 1000) || null,
                author: preview.authorLogin,
              },
            }
          : {}),
      });
      started.push(deployment.id);
    } catch (err) {
      // 0 replicas, or a cron service without a schedule: nothing to deploy.
      if (err instanceof ApiError && (err.status === 409 || err.status === 422)) continue;
      throw err;
    }
  }
  return started;
}

// -----------------------------------------------------------------------------
// Teardown
// -----------------------------------------------------------------------------

/**
 * Tears a preview environment down: stops its deployments and pulls their
 * replicas, schedules its volumes for deletion after the grace period
 * (ADR 0004), deletes its domains, pauses its cron schedules, and retires
 * it (hidden, slug freed). The row itself goes once its volumes are gone;
 * see {@link reapRetiredEnvironments}. Safe to retry.
 *
 * @param ctx - Database and bindings.
 * @param projectId - The owning project.
 * @param environmentId - The preview environment.
 */
export async function teardownPreviewEnvironment(
  ctx: LifecycleContext,
  projectId: string,
  environmentId: string,
  now = Date.now(),
): Promise<void> {
  const { db } = ctx;
  const [env] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)))
    .limit(1);
  // NOTE: only preview environments are ever torn down here; production
  // and staging never reach this, whatever the caller passes.
  if (env?.kind !== "preview") return;

  const live = await db
    .select({ id: deployments.id, status: deployments.status })
    .from(deployments)
    .where(
      and(
        eq(deployments.environmentId, environmentId),
        inArray(deployments.status, [...CANCELLABLE_DEPLOYMENT_STATUSES, "active", "crashed"]),
      ),
    );
  for (const d of live) await stopDeployment(ctx, projectId, d.id, d.status);
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
      .update(environments)
      .set({
        retiredAt: env.retiredAt ?? new Date(now),
        // Frees `pr-<n>` for the PR's next preview; IDs are unique, so this is too.
        slug: env.retiredAt ? env.slug : `retired-${environmentId.slice(-16).toLowerCase()}`,
        updatedAt: new Date(now),
      })
      .where(eq(environments.id, environmentId)),
  ]);
  await retireDeployments(
    ctx,
    live.map((d) => d.id),
  );
  const nodes = new Set([...replicaNodes, ...holders.flatMap((h) => (h.nodeId ? [h.nodeId] : []))]);
  if (nodes.size) await refreshNodes(ctx.env, db, [...nodes]);
}

/**
 * Stops one deployment of a torn-down preview: cancels it while in flight,
 * removes it once live. A rollout can finish between reading its status and
 * acting on it, so an illegal transition re-reads and tries again.
 */
async function stopDeployment(
  ctx: LifecycleContext,
  projectId: string,
  deploymentId: string,
  status: DeploymentStatus,
): Promise<void> {
  let current: DeploymentStatus | undefined = status;
  for (let attempt = 0; attempt < 3 && current; attempt++) {
    try {
      if (CANCELLABLE_DEPLOYMENT_STATUSES.includes(current)) {
        await cancelDeployment(ctx, projectId, deploymentId, "The preview was torn down");
      } else if (current === "active" || current === "crashed") {
        await transitionDeployment(ctx, projectId, deploymentId, "removed", {
          reason: "The preview was torn down",
        });
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
 * Deletes retired preview environments whose volumes are all gone and
 * whose deployments all ended, which cascades to their configs, variables
 * and deployment history.
 *
 * @param env - Worker bindings.
 * @param db - Database client.
 * @returns How many were deleted.
 */
export async function reapRetiredEnvironments(_env: Env, db: Db): Promise<number> {
  const retired = await db
    .select({ id: environments.id })
    .from(environments)
    .where(isNotNull(environments.retiredAt))
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
      .delete(environments)
      .where(and(eq(environments.id, id), isNotNull(environments.retiredAt)))
      .returning({ id: environments.id });
    reaped += deleted.length;
  }
  return reaped;
}

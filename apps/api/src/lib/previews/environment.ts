/**
 * A preview's environment (ADR 0007, "Create" and "Delete"): creating it as
 * a capped copy of the base environment (see `../environments`), deploying
 * it, and tearing it down.
 *
 * Creating writes, in one batch, the environment, every live service's
 * latest base config (clamped by the caps, merged with the preview node
 * selector), the variables `planPreviewVariables` decides, empty
 * volumes no larger than `caps.volume_mb`, and links the preview to it.
 * Then, idempotently: generated domains (never custom ones, TCP proxies or
 * backup policies) and paused cron schedules. A concurrent create of the
 * same preview loses on the `pr-<n>` slug and adopts the winner's.
 *
 * @module
 */
import {
  type Db,
  environments,
  previewEnvironments,
  type projects,
  variables,
  volumes,
} from "@roundhouse/db";
import {
  clampPreviewConfig,
  newId,
  previewEnvironmentSlug,
  previewWithholdsSecrets,
} from "@roundhouse/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { KeyEnv } from "../crypto";
import { createDeployment, type LifecycleContext } from "../deployments";
import {
  finishEnvironment,
  planEnvironmentCopy,
  retireEnvironment,
  seedDatabasesFromBackups,
} from "../environments";
import { ApiError, isUniqueViolation } from "../errors";
import { configInsert, latestConfig, liveServices } from "../projects";
import { previewGitServices } from "./events";
import type { PreviewSettingsRow } from "./settings";

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
  const withhold = previewWithholdsSecrets(preview.isFork, settings.sameRepoSecrets);
  const copy = await planEnvironmentCopy(db, input.keys, {
    projectId: project.id,
    environmentId: envId,
    source: base,
    services: null,
    variables: withhold ? "withhold" : "all",
    transform: (spec) => clampPreviewConfig(spec, settings.caps, settings.nodeSelector),
    volumeCapMb: settings.caps.volume_mb,
    fallback: null,
  });
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
      ...copy.configs.map((cfg) =>
        configInsert(db, {
          serviceId: cfg.service.id,
          environmentId: envId,
          version: 1,
          createdBy: null,
          spec: cfg.spec,
        }),
      ),
      ...copy.variableRows.map((row) => db.insert(variables).values(row)),
      ...copy.volumeRows.map((row) => db.insert(volumes).values(row)),
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
// Seed
// -----------------------------------------------------------------------------

/**
 * Restores each database of a new preview from the base environment's latest
 * successful dump, when the project asks for `database_seed: latest_backup`
 * (ADR 0007). The restore waits for the preview's database to run healthy,
 * and the agent keeps the preview's own fresh credentials over the dump's.
 * Snapshots don't qualify: they carry the source's passwords.
 *
 * SECURITY: a preview that withholds secrets (every fork) gets no data
 * either: a database can be as sensitive as the secrets withheld from it.
 *
 * @param ctx - Database and bindings.
 * @param input - The preview, its project's workspace and settings, and its environment.
 * @returns IDs of the restores started; idempotent per database.
 */
export async function seedPreviewDatabases(
  ctx: LifecycleContext,
  input: {
    preview: PreviewRow;
    workspaceId: string;
    settings: PreviewSettingsRow;
    environmentId: string;
  },
): Promise<string[]> {
  const { preview, settings, environmentId } = input;
  if (settings.databaseSeed !== "latest_backup") return [];
  if (preview.withheld || previewWithholdsSecrets(preview.isFork, settings.sameRepoSecrets)) {
    return [];
  }
  return seedDatabasesFromBackups(ctx, {
    projectId: preview.projectId,
    workspaceId: input.workspaceId,
    fromEnvironmentId: settings.baseEnvironmentId,
    environmentId,
    actor: { actorType: "system", actorId: null },
    requestedBy: null,
    auditMetadata: { mode: "preview_seed", preview_id: preview.id },
  });
}

// -----------------------------------------------------------------------------
// Teardown
// -----------------------------------------------------------------------------

/**
 * Tears a preview environment down: stops its deployments and pulls their
 * replicas, schedules its volumes for deletion after the grace period
 * (ADR 0004), deletes its domains, pauses its cron schedules, and retires
 * it (hidden, slug freed). The row itself goes once its volumes are gone;
 * see `reapRetiredEnvironments` in `../environments`. Safe to retry.
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
  const [env] = await ctx.db
    .select({ kind: environments.kind })
    .from(environments)
    .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)))
    .limit(1);
  // NOTE: only preview environments are ever torn down here, whatever the caller passes.
  if (env?.kind !== "preview") return;
  await retireEnvironment(ctx, projectId, environmentId, "The preview was torn down", now);
}

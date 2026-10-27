/**
 * Adding a database service through a change set (ADR 0004, ADR 0006):
 * shared by `POST /v1/projects/{projectId}/databases` and restores into a
 * new service.
 *
 * The set is opened, a `service.create` op with `database` staged, and the
 * set applied in one call, so the service, its configs, its volume in every
 * environment and its generated write-only credentials land through the
 * same authorization, validation and audit as any reviewed change. The
 * staged op is the canvas's own `service.create` with `database`
 * (`databaseCreateOp`), so there is one way a database is built; applied
 * as a direct request, it needs no review.
 *
 * @module
 */
import { changeSets, services, stagedChanges } from "@roundhouse/db";
import type { ServiceDatabaseEngine } from "@roundhouse/shared";
import { asc, eq } from "drizzle-orm";
import { type AppContext, clientIp, requireKeys } from "../../context";
import { recordAudit } from "../audit";
import { ApiError } from "../errors";
import type { Caller } from "../scope";
import { type ApplyResult, applySet } from "./apply";
import { type StagingContext, stageIntoSet } from "./staging";
import { type EnvironmentRow, openChangeSet, type ProjectRow } from "./store";

/** What {@link addDatabaseService} creates. */
export interface AddDatabaseInput {
  engine: ServiceDatabaseEngine;
  /** A registry version; the engine's default when omitted. */
  version?: string;
  /** Volume quota in MiB; the template's default when omitted. */
  sizeMb?: number;
  name: string;
  /** Suffixed with -2, -3, … when taken. */
  slug?: string;
  /** Start the first deployment in the set's environment. */
  deploy: boolean;
  /** The change set's title. */
  title: string;
  /** Extra `change_set.created` audit metadata. */
  auditMetadata?: Record<string, unknown>;
}

/** What {@link addDatabaseService} created. */
export interface AddedDatabase {
  service: typeof services.$inferSelect;
  applied: ApplyResult;
}

/**
 * Opens, stages and applies a change set that adds one database service.
 * The caller has checked the RBAC actions the route needs; apply checks
 * them again per op.
 *
 * @param c - Request context.
 * @param scope - Project, environment the set applies in, and the caller resolved against the project.
 * @param input - Engine, names and deploy choice.
 * @returns The new service and the apply result.
 * @throws {ApiError} From staging or apply; a set that fails to stage is deleted.
 */
export async function addDatabaseService(
  c: AppContext,
  scope: { project: ProjectRow; environment: EnvironmentRow; caller: Caller },
  input: AddDatabaseInput,
): Promise<AddedDatabase> {
  const db = c.get("db");
  const { project, environment, caller } = scope;
  const ctx: StagingContext = { c, db, keys: requireKeys(c), project, environment, caller };
  let set = await openChangeSet(db, {
    projectId: project.id,
    environmentId: environment.id,
    source: "api",
    isDraft: false,
    caller,
    title: input.title,
  });
  try {
    set = await stageIntoSet(ctx, set, {
      type: "service.create",
      ref: "new:1",
      kind: "database",
      name: input.name,
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      database: {
        engine: input.engine,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.sizeMb !== undefined ? { size_mb: input.sizeMb } : {}),
      },
    });
  } catch (err) {
    await db.delete(changeSets).where(eq(changeSets.id, set.id));
    throw err;
  }
  await recordAudit(db, {
    workspaceId: project.workspaceId,
    ...caller.actor,
    action: "change_set.created",
    targetType: "change_set",
    targetId: set.id,
    metadata: {
      project_id: project.id,
      environment_id: environment.id,
      source: "api",
      ops: 1,
      engine: input.engine,
      ...input.auditMetadata,
    },
    ip: clientIp(c),
  });

  const applied = await applySet({ c, db, env: c.env, project, environment }, set, {
    expectedRevision: set.revision,
    deploy: input.deploy ? "affected" : "none",
    direct: true,
  });
  const [op] = await db
    .select({ result: stagedChanges.result })
    .from(stagedChanges)
    .where(eq(stagedChanges.changeSetId, set.id))
    .orderBy(asc(stagedChanges.id))
    .limit(1);
  const serviceId = String(op?.result?.service_id ?? "");
  const service = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
  if (!service) throw new ApiError(500, "internal", "The database was not created");
  return { service, applied };
}

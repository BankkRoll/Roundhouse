/**
 * Change set persistence shared by the routes and the MCP tools: loading a
 * set or environment with the caller's access, the shared draft, the
 * optimistic revision bump, serialisation, and realtime fan-out.
 *
 * @module
 */
import {
  changeSets,
  type Db,
  environments,
  projects,
  services,
  stagedChanges,
  workspaces,
} from "@roundhouse/db";
import {
  type ChangeSetReviewStatus,
  type ChangeSetSource,
  describeOp,
  isNewServiceRef,
  newId,
  type StagedOp,
} from "@roundhouse/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../../context";
import type { Env } from "../../env";
import { ApiError, isUniqueViolation, notFound } from "../errors";
import { publish } from "../realtime";
import { type Caller, projectScope } from "../scope";

/** A `change_sets` row. */
export type ChangeSetRow = typeof changeSets.$inferSelect;
/** A `staged_changes` row. */
export type StagedRow = typeof stagedChanges.$inferSelect;
/** An `environments` row. */
export type EnvironmentRow = typeof environments.$inferSelect;
/** A `projects` row. */
export type ProjectRow = typeof projects.$inferSelect;

/**
 * 409 `change_set_changed`: the set moved on since the caller looked at it.
 *
 * @param current - The set's revision now.
 * @returns The error to throw.
 */
export const changeSetChanged = (current: number) =>
  new ApiError(
    409,
    "change_set_changed",
    `The change set changed since you reviewed it; it is at revision ${current}. Reload and review again`,
  );

/**
 * Loads an environment of a live project and authorizes the caller.
 *
 * @param c - Request context.
 * @param environmentId - From the route.
 * @param action - Checked against the project, or the environment when `inEnvironment`.
 * @param inEnvironment - Name the environment in the check, so its protection applies.
 * @returns The environment, its project and the caller.
 */
export async function environmentScope(
  c: AppContext,
  environmentId: string,
  action: Parameters<typeof projectScope>[2],
  inEnvironment = false,
) {
  const [row] = await c
    .get("db")
    .select({ environment: environments })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!row) throw notFound("Environment");
  const { project, caller } = await projectScope(
    c,
    row.environment.projectId,
    action,
    inEnvironment ? environmentId : undefined,
  );
  return { environment: row.environment, project, caller };
}

/**
 * Loads a change set of a live project and authorizes the caller.
 *
 * @param c - Request context.
 * @param changeSetId - From the route.
 * @param action - Checked against the project, or the environment when `inEnvironment`.
 * @param inEnvironment - Name the set's environment in the check.
 * @returns The set, its environment and project, and the caller.
 */
export async function changeSetScope(
  c: AppContext,
  changeSetId: string,
  action: Parameters<typeof projectScope>[2],
  inEnvironment = false,
) {
  const [row] = await c
    .get("db")
    .select({ set: changeSets, environment: environments })
    .from(changeSets)
    .innerJoin(environments, eq(environments.id, changeSets.environmentId))
    .innerJoin(projects, eq(projects.id, changeSets.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(
      and(eq(changeSets.id, changeSetId), isNull(projects.deletedAt), isNull(workspaces.deletedAt)),
    )
    .limit(1);
  if (!row) throw notFound("Change set");
  const { project, caller } = await projectScope(
    c,
    row.set.projectId,
    action,
    inEnvironment ? row.set.environmentId : undefined,
  );
  return { set: row.set, environment: row.environment, project, caller };
}

/**
 * The ops of a set in apply order.
 *
 * @param db - Database client.
 * @param changeSetId - The set.
 * @returns Its staged changes.
 */
export function loadOps(db: Db, changeSetId: string): Promise<StagedRow[]> {
  return db
    .select()
    .from(stagedChanges)
    .where(eq(stagedChanges.changeSetId, changeSetId))
    .orderBy(asc(stagedChanges.seq), asc(stagedChanges.id));
}

/**
 * The environment's open draft, if any.
 *
 * @param db - Database client.
 * @param environmentId - The environment.
 * @returns The draft row, or `undefined`.
 */
export async function findDraft(db: Db, environmentId: string) {
  const [row] = await db
    .select()
    .from(changeSets)
    .where(
      and(
        eq(changeSets.environmentId, environmentId),
        eq(changeSets.isDraft, true),
        eq(changeSets.status, "open"),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Opens a change set.
 *
 * @param db - Database client.
 * @param input - Where, who and why.
 * @returns The new row.
 */
export async function openChangeSet(
  db: Db,
  input: {
    projectId: string;
    environmentId: string;
    source: ChangeSetSource;
    isDraft: boolean;
    caller: Caller;
    title?: string | null;
  },
): Promise<ChangeSetRow> {
  const token = input.caller.principal.token;
  const [row] = await db
    .insert(changeSets)
    .values({
      id: newId("changeSet"),
      projectId: input.projectId,
      environmentId: input.environmentId,
      status: "open",
      isDraft: input.isDraft,
      source: input.source,
      sourceRef: token?.id ?? null,
      title: input.title ?? null,
      createdBy: input.caller.user.id,
      createdByToken: token?.id ?? null,
    })
    .returning();
  return row!;
}

/**
 * The environment's draft, opened on first use. Two callers racing to open
 * it both end up with the same row (the partial unique index decides).
 *
 * @param db - Database client.
 * @param environment - The environment.
 * @param caller - Who is staging.
 * @returns The open draft.
 */
export async function draftFor(
  db: Db,
  environment: EnvironmentRow,
  caller: Caller,
): Promise<ChangeSetRow> {
  const existing = await findDraft(db, environment.id);
  if (existing) return existing;
  try {
    return await openChangeSet(db, {
      projectId: environment.projectId,
      environmentId: environment.id,
      source: "dashboard",
      isDraft: true,
      caller,
    });
  } catch (err) {
    if (!isUniqueViolation(err, "change_sets")) throw err;
    const raced = await findDraft(db, environment.id);
    if (!raced) throw err;
    return raced;
  }
}

/**
 * Moves an open set to its next revision, but only from `revision`; the
 * guard is what makes concurrent edits of one set safe.
 *
 * An edit voids any review decision: an approved or rejected set goes back to
 * `submitted`, so an approval always covers exactly the ops that apply.
 *
 * @param db - Database client.
 * @param set - The set as the caller loaded it.
 * @returns The updated row.
 * @throws {ApiError} 409 `change_set_changed` when someone else got there first.
 */
export async function bumpRevision(db: Db, set: ChangeSetRow): Promise<ChangeSetRow> {
  const [row] = await db
    .update(changeSets)
    .set({
      revision: sql`${changeSets.revision} + 1`,
      error: null,
      reviewStatus: sql`CASE WHEN ${changeSets.reviewStatus} = 'none' THEN 'none' ELSE 'submitted' END`,
      approvedBy: null,
      approvedAt: null,
      approvedRevision: null,
      rejectedBy: null,
      rejectedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(changeSets.id, set.id),
        eq(changeSets.status, "open"),
        eq(changeSets.revision, set.revision),
      ),
    )
    .returning();
  if (row) return row;
  const current = await db.query.changeSets.findFirst({ where: eq(changeSets.id, set.id) });
  if (current && current.status !== "open") throw notOpen(current);
  throw changeSetChanged(current?.revision ?? set.revision);
}

/**
 * 409 for a set that can no longer be edited.
 *
 * @param set - The set.
 * @returns The error to throw.
 */
export function notOpen(set: Pick<ChangeSetRow, "status">): ApiError {
  return new ApiError(
    409,
    "conflict",
    set.status === "applying"
      ? "The change set is being applied right now"
      : `The change set is ${set.status} and can't be changed`,
  );
}

/**
 * Display names of a project's services and of the services a set
 * creates, for op summaries.
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @param ops - The set's ops.
 * @returns A lookup from service ID or `new:<n>` to a name.
 */
export async function serviceNamer(
  db: Db,
  projectId: string,
  ops: readonly { op: StagedOp }[],
): Promise<(ref: string) => string> {
  const rows = await db
    .select({ id: services.id, slug: services.slug })
    .from(services)
    .where(eq(services.projectId, projectId));
  const names = new Map(rows.map((r) => [r.id, r.slug]));
  for (const { op } of ops) {
    if (op.type === "service.create") names.set(op.ref, op.slug ?? op.name);
  }
  return (ref) => names.get(ref) ?? (isNewServiceRef(ref) ? ref : "unknown service");
}

/**
 * Whether the set carries an approval of exactly its current revision.
 *
 * @param set - Change set row.
 * @returns `true` when approved and nothing changed since.
 */
export function hasValidApproval(
  set: Pick<ChangeSetRow, "reviewStatus" | "approvedBy" | "approvedRevision" | "revision">,
): boolean {
  return (
    set.reviewStatus === "approved" &&
    set.approvedBy !== null &&
    set.approvedRevision === set.revision
  );
}

/**
 * The review state a client sees. An approval stored for another revision
 * reads as `submitted`: only edits change the revision, and they void it.
 *
 * @param set - Change set row.
 * @returns The effective review status.
 */
export function reviewStatusOf(set: ChangeSetRow): ChangeSetReviewStatus {
  if (set.reviewStatus === "approved" && !hasValidApproval(set)) return "submitted";
  return set.reviewStatus;
}

/**
 * @param set - Change set row.
 * @param ops - Its staged changes.
 * @returns The `ChangeSetSummary` wire shape.
 */
export function toApiChangeSetSummary(set: ChangeSetRow, ops: readonly StagedRow[]) {
  const live = ops.filter((o) => o.status !== "applied");
  return {
    id: set.id,
    project_id: set.projectId,
    environment_id: set.environmentId,
    status: set.status,
    is_draft: set.isDraft,
    source: set.source,
    title: set.title,
    revision: set.revision,
    op_count: set.status === "applied" ? ops.length : live.length,
    conflicted_count: live.filter((o) => o.status === "conflicted").length,
    created_by: set.createdBy,
    created_by_token: set.createdByToken,
    review_status: reviewStatusOf(set),
    submitted_by: set.submittedBy,
    submitted_at: set.submittedAt ? +set.submittedAt : null,
    approved_by: reviewStatusOf(set) === "approved" ? set.approvedBy : null,
    approved_at: reviewStatusOf(set) === "approved" && set.approvedAt ? +set.approvedAt : null,
    rejected_by: set.rejectedBy,
    rejected_at: set.rejectedAt ? +set.rejectedAt : null,
    review_note: set.reviewNote,
    applied_by: set.appliedBy,
    applied_at: set.appliedAt ? +set.appliedAt : null,
    error: set.error ? { code: set.error.code, message: set.error.message } : null,
    created_at: +set.createdAt,
    updated_at: +set.updatedAt,
  };
}

/**
 * Serialises a set with its ops. Staged rows never expose `value_sealed`.
 *
 * @param set - Change set row.
 * @param ops - Its staged changes, in apply order.
 * @param nameOf - From {@link serviceNamer}.
 * @returns The `ChangeSet` wire shape.
 */
export function toApiChangeSet(
  set: ChangeSetRow,
  ops: readonly StagedRow[],
  nameOf: (ref: string) => string,
) {
  return {
    ...toApiChangeSetSummary(set, ops),
    changes: ops.map((o) => ({
      id: o.id,
      seq: o.seq,
      target_key: o.targetKey,
      op: o.op,
      summary: describeOp(o.op, nameOf),
      diff: o.diff,
      status: o.status,
      conflict: o.conflict ?? null,
      created_by: o.createdBy,
      created_at: +o.createdAt,
      updated_at: +o.updatedAt,
    })),
  };
}

/**
 * Loads a set's ops and serialises it.
 *
 * @param db - Database client.
 * @param set - Change set row.
 * @returns The `ChangeSet` wire shape.
 */
export async function presentChangeSet(db: Db, set: ChangeSetRow) {
  const ops = await loadOps(db, set.id);
  return toApiChangeSet(set, ops, await serviceNamer(db, set.projectId, ops));
}

/**
 * Tells the project's browsers that a set changed. Best effort, like every publish.
 *
 * @param env - Bindings.
 * @param db - Database client.
 * @param set - The set as it is now.
 */
export async function publishChangeSet(env: Env, db: Db, set: ChangeSetRow): Promise<void> {
  const ops = await loadOps(db, set.id);
  await publish(env, set.projectId, {
    type: "change_set.updated",
    change_set: toApiChangeSetSummary(set, ops),
  });
}

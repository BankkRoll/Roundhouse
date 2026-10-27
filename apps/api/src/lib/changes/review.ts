/**
 * Review of change sets (ADR 0006 "Apply", step 2, and "Security"):
 *
 * - {@link submitSet}: someone who can propose changes asks for a review.
 * - {@link decideSet}: someone with `changes:approve` approves or rejects
 *   the revision they looked at. Whoever opened the set or staged an op in
 *   it can't review it.
 * - {@link assertMayApply}: what review requires before an apply, checked
 *   with the applier's identity: an approval on environments whose
 *   protection requires one (and the approver can't also apply), and for an
 *   API token either `changes:auto_apply` or a person's approval.
 * - {@link rebaseSet}: moves a stale set onto the current state.
 *
 * Approvals bind a revision. Every edit bumps the revision and voids the
 * decision (`bumpRevision`), so an approval covers exactly what applies.
 *
 * @module
 */
import { changeSets, type Db, stagedChanges } from "@roundhouse/db";
import { describeOp } from "@roundhouse/shared";
import { and, eq } from "drizzle-orm";
import { auditInsert } from "../audit";
import type { KeyEnv } from "../crypto";
import { ApiError } from "../errors";
import type { Caller } from "../scope";
import { checkDrift } from "./apply";
import { recordConflicts } from "./staging";
import {
  bumpRevision,
  type ChangeSetRow,
  changeSetChanged,
  type EnvironmentRow,
  hasValidApproval,
  loadOps,
  notOpen,
  type ProjectRow,
  type StagedRow,
  serviceNamer,
} from "./store";

/**
 * Whether applying in an environment needs an approval.
 *
 * @param environment - The set's environment.
 * @returns `true` when it is protected and its protection requires approval.
 */
export function requiresApproval(
  environment: Pick<EnvironmentRow, "protected" | "requireApproval">,
): boolean {
  return environment.protected && environment.requireApproval;
}

/**
 * Users who may not review a set: whoever opened it and whoever staged one
 * of its pending ops.
 *
 * @param set - The set.
 * @param rows - Its ops.
 * @returns User IDs, sorted.
 */
export function authorsOf(set: ChangeSetRow, rows: readonly StagedRow[]): string[] {
  const ids = new Set<string>();
  if (set.createdBy) ids.add(set.createdBy);
  for (const r of rows) if (r.status !== "applied" && r.createdBy) ids.add(r.createdBy);
  return [...ids].sort();
}

/** Anyone who can propose some change may submit or rebase a set. */
export function assertCanEdit(caller: Caller): void {
  if (!caller.allows("services:manage") && !caller.allows("variables:manage")) {
    throw new ApiError(
      403,
      "forbidden",
      "Editing staged changes needs services:manage or variables:manage",
    );
  }
}

/** What review and rebase mutations need. */
interface ReviewInput {
  set: ChangeSetRow;
  project: ProjectRow;
  caller: Caller;
  ip: string | null;
}

async function reload(db: Db, id: string): Promise<ChangeSetRow> {
  const row = await db.query.changeSets.findFirst({ where: eq(changeSets.id, id) });
  if (!row) throw new ApiError(404, "not_found", "Change set not found");
  return row;
}

/**
 * Asks for a review of an open set. A set already waiting for (or holding)
 * a decision at its revision is left as it is, so submitting twice is
 * harmless; a rejected set is submitted again.
 *
 * @param db - Database client.
 * @param input - The set, who submits, and an optional note.
 * @returns The set after the change.
 * @throws {ApiError} 403 without an edit action, 409 when closed, moved on or empty.
 */
export async function submitSet(
  db: Db,
  input: ReviewInput & { expectedRevision?: number; note?: string },
): Promise<ChangeSetRow> {
  assertCanEdit(input.caller);
  const set = await reload(db, input.set.id);
  if (set.status !== "open") throw notOpen(set);
  if (input.expectedRevision !== undefined && input.expectedRevision !== set.revision) {
    throw changeSetChanged(set.revision);
  }
  const rows = await loadOps(db, set.id);
  if (!rows.some((r) => r.status !== "applied")) {
    throw new ApiError(409, "conflict", "Nothing is staged in this change set");
  }
  if (set.reviewStatus === "submitted" || hasValidApproval(set)) return set;
  const now = new Date();
  const [row] = await db
    .update(changeSets)
    .set({
      reviewStatus: "submitted",
      submittedBy: input.caller.user.id,
      submittedAt: now,
      rejectedBy: null,
      rejectedAt: null,
      reviewNote: input.note ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(changeSets.id, set.id),
        eq(changeSets.status, "open"),
        eq(changeSets.revision, set.revision),
      ),
    )
    .returning();
  if (!row) throw changeSetChanged((await reload(db, set.id)).revision);
  const nameOf = await serviceNamer(db, set.projectId, rows);
  await db.batch([
    auditInsert(db, {
      workspaceId: input.project.workspaceId,
      ...input.caller.actor,
      action: "change_set.submitted",
      targetType: "change_set",
      targetId: set.id,
      metadata: {
        project_id: set.projectId,
        environment_id: set.environmentId,
        revision: set.revision,
        ops: rows.filter((r) => r.status !== "applied").map((r) => describeOp(r.op, nameOf)),
      },
      ip: input.ip,
    }),
  ]);
  return row;
}

/**
 * Approves or rejects the revision a reviewer looked at.
 *
 * SECURITY: Reviewing is a second pair of eyes, so the set's opener and
 * every author of a pending op are refused (`self_review`), whatever their
 * role. The route already checked `changes:approve` for the caller.
 *
 * @param db - Database client.
 * @param input - The set, the reviewer, the decision and the revision reviewed.
 * @returns The set after the decision.
 * @throws {ApiError} 403 `self_review`, 409 when closed, empty or moved on.
 */
export async function decideSet(
  db: Db,
  input: ReviewInput & {
    decision: "approve" | "reject";
    expectedRevision: number;
    note?: string;
  },
): Promise<ChangeSetRow> {
  const set = await reload(db, input.set.id);
  if (set.status !== "open") throw notOpen(set);
  if (input.expectedRevision !== set.revision) throw changeSetChanged(set.revision);
  const rows = await loadOps(db, set.id);
  const pending = rows.filter((r) => r.status !== "applied");
  if (!pending.length) throw new ApiError(409, "conflict", "Nothing is staged in this change set");
  if (authorsOf(set, rows).includes(input.caller.user.id)) {
    throw new ApiError(
      403,
      "self_review",
      "You opened this change set or staged changes in it, so someone else must review it",
    );
  }
  const now = new Date();
  const approve = input.decision === "approve";
  const [row] = await db
    .update(changeSets)
    .set({
      reviewStatus: approve ? "approved" : "rejected",
      approvedBy: approve ? input.caller.user.id : null,
      approvedAt: approve ? now : null,
      approvedRevision: approve ? set.revision : null,
      rejectedBy: approve ? null : input.caller.user.id,
      rejectedAt: approve ? null : now,
      reviewNote: input.note ?? null,
      submittedAt: set.submittedAt ?? now,
      updatedAt: now,
    })
    .where(
      and(
        eq(changeSets.id, set.id),
        eq(changeSets.status, "open"),
        eq(changeSets.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) throw changeSetChanged((await reload(db, set.id)).revision);
  const nameOf = await serviceNamer(db, set.projectId, rows);
  await db.batch([
    auditInsert(db, {
      workspaceId: input.project.workspaceId,
      ...input.caller.actor,
      action: approve ? "change_set.approved" : "change_set.rejected",
      targetType: "change_set",
      targetId: set.id,
      metadata: {
        project_id: set.projectId,
        environment_id: set.environmentId,
        revision: set.revision,
        ops: pending.map((r) => describeOp(r.op, nameOf)),
        has_note: input.note !== undefined,
      },
      ip: input.ip,
    }),
  ]);
  return row;
}

/** Why an apply is waiting on review, if it is; see {@link applyBlocker}. */
export type ApplyBlocker =
  | { code: "change_set_rejected"; message: string }
  | { code: "approval_required"; message: string }
  | { code: "forbidden"; message: string };

/**
 * What review still requires before `caller` may apply `set`, or `null`.
 *
 * - A set rejected at its revision never applies until it is edited.
 * - In an environment whose protection requires approval, the set needs an
 *   approval at its revision, and the approver can't also be the applier.
 * - An API token needs `changes:auto_apply`, unless a person approved the
 *   set at its revision (ADR 0006: auto-apply is "without a human").
 *
 * @param set - The set as the caller loaded it.
 * @param environment - Its environment.
 * @param caller - The applier, resolved in that environment.
 * @returns The blocker, or `null` when review allows the apply.
 */
export function applyBlocker(
  set: ChangeSetRow,
  environment: EnvironmentRow,
  caller: Caller,
): ApplyBlocker | null {
  const approved = hasValidApproval(set);
  if (set.reviewStatus === "rejected") {
    return {
      code: "change_set_rejected",
      message: "This change set was rejected; change it, or ask for another review, first",
    };
  }
  if (requiresApproval(environment)) {
    if (!approved) {
      return {
        code: "approval_required",
        message: `${environment.name} requires an approval before changes apply; submit the change set for review`,
      };
    }
    if (set.approvedBy === caller.user.id) {
      return {
        code: "forbidden",
        message: "You approved this change set, so someone else must apply it",
      };
    }
  }
  const token = caller.principal.token;
  if (token && !approved && !caller.allows("changes:auto_apply")) {
    return {
      code: "approval_required",
      message: token.scopes.includes("changes:auto_apply")
        ? "Your role can't apply changes without an approval; ask for a review"
        : "This API token lacks the changes:auto_apply scope; ask for a review, or apply it in the dashboard",
    };
  }
  return null;
}

/**
 * Throws {@link applyBlocker}'s answer as a 403 (or 409 for a rejected set).
 *
 * @param set - The set.
 * @param environment - Its environment.
 * @param caller - The applier.
 * @throws {ApiError} When review doesn't allow the apply yet.
 */
export function assertMayApply(
  set: ChangeSetRow,
  environment: EnvironmentRow,
  caller: Caller,
): void {
  const blocker = applyBlocker(set, environment, caller);
  if (!blocker) return;
  throw new ApiError(
    blocker.code === "change_set_rejected" ? 409 : 403,
    blocker.code,
    blocker.message,
  );
}

/**
 * Moves a set onto the current state (ADR 0006 "Conflicts"): clean rebases
 * get their new base and diff, conflicts are marked, conflicts that went
 * away are cleared. The revision is bumped when anything changed, which
 * also voids a review decision: the diffs a reviewer saw moved.
 *
 * @param ctx - Database, keys, project and environment.
 * @param input - The set, the caller and the revision they looked at.
 * @returns The set and what moved.
 * @throws {ApiError} 403 without an edit action, 409 when closed or moved on.
 */
export async function rebaseSet(
  ctx: { db: Db; keys: KeyEnv; project: ProjectRow; environment: EnvironmentRow },
  input: { set: ChangeSetRow; caller: Caller; expectedRevision: number },
) {
  assertCanEdit(input.caller);
  const { db } = ctx;
  const set = await reload(db, input.set.id);
  if (set.status !== "open") throw notOpen(set);
  if (set.revision !== input.expectedRevision) throw changeSetChanged(set.revision);
  const rows = await loadOps(db, set.id);
  const drift = await checkDrift(ctx, rows);
  const newConflicts = [...drift.conflicts].filter(([id, c]) => {
    const row = rows.find((r) => r.id === id);
    return row?.status !== "conflicted" || JSON.stringify(row.conflict) !== JSON.stringify(c);
  });
  const changed = drift.rebases.size > 0 || drift.cleared.length > 0 || newConflicts.length > 0;
  let current = set;
  if (changed) {
    current = await bumpRevision(db, set);
    const now = new Date();
    const writes = [
      ...[...drift.rebases].map(([id, r]) =>
        db
          .update(stagedChanges)
          .set({ ...r, status: "pending", conflict: null, updatedAt: now })
          .where(eq(stagedChanges.id, id)),
      ),
      ...drift.cleared.map((id) =>
        db
          .update(stagedChanges)
          .set({ status: "pending", conflict: null, updatedAt: now })
          .where(eq(stagedChanges.id, id)),
      ),
    ];
    if (writes.length) await db.batch(writes as [(typeof writes)[number], ...typeof writes]);
    await recordConflicts(db, new Map(newConflicts));
  }
  return {
    set: current,
    rebased: [...drift.rebases.keys()],
    conflicts: [...drift.conflicts].map(([id, conflict]) => ({ id, conflict })),
  };
}

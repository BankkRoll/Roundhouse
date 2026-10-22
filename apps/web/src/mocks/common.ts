/**
 * Building blocks shared by every MSW handler module: the API's error responses, the
 * session and RBAC gate (mirroring `apps/api/src/context.ts`), and audit records.
 *
 * @module
 */
import { type Action, type AuditAction, can } from "@openrail/shared";
import { HttpResponse } from "msw";
import { type DbMembership, type DbUser, db } from "./db";

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

/**
 * Builds a contract-shaped error response.
 *
 * @param status - HTTP status.
 * @param code - Machine-readable code.
 * @param message - Human-readable message.
 * @param details - Optional per-field problems, as the API reports them.
 * @returns An MSW JSON response.
 */
export function apiError(
  status: number,
  code: string,
  message: string,
  details?: { field: string; code: string; message: string; start?: number; end?: number }[],
) {
  return HttpResponse.json(
    { error: details ? { code, message, details } : { code, message } },
    { status },
  );
}

/** 401 for a missing or expired session. */
export const unauthorized = () => apiError(401, "unauthorized", "Sign in to continue");
/** 404 in the API wording. */
export const notFound = (what = "Resource") => apiError(404, "not_found", `${what} not found`);
/** 400 `invalid_request` with the given message. */
export const invalid = (message: string) => apiError(400, "invalid_request", message);

// -----------------------------------------------------------------------------
// Session and RBAC (mirrors apps/api/src/context.ts)
// -----------------------------------------------------------------------------

/** The session user, or `null`. Without MASTER_KEY the API cannot read sessions at all. */
export function currentUser(): DbUser | null {
  if (!db.setup.master_key_configured) return null;
  return db.users.find((user) => user.id === db.sessionUserId) ?? null;
}

/** Result of {@link requireWorkspace}. */
export type Guard =
  | { ok: true; user: DbUser; membership: DbMembership }
  | { ok: false; response: Response };

/**
 * Mirrors the API's RBAC gate: 401 without a session, 404 for non-members, 403 when the
 * role lacks `action`.
 *
 * @param workspaceId - Owning workspace.
 * @param action - Required action.
 * @returns The user and membership, or the error response.
 */
export function requireWorkspace(workspaceId: string, action: Action): Guard {
  const user = currentUser();
  if (!user) return { ok: false, response: unauthorized() };
  const membership = db.memberships.find(
    (row) => row.workspace_id === workspaceId && row.user_id === user.id,
  );
  if (!membership) return { ok: false, response: notFound("Workspace") };
  if (!can(membership.role, action)) {
    return {
      ok: false,
      response: apiError(
        403,
        "forbidden",
        `Your role (${membership.role}) cannot perform ${action}`,
      ),
    };
  }
  return { ok: true, user, membership };
}

let auditSequence = 0;

/** Fields of an audit record written by a handler. */
export interface AuditInput {
  workspaceId: string;
  actorType: "user" | "node" | "system";
  actorId: string | null;
  action: AuditAction;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Appends an audit entry the way the API does.
 *
 * @param input - Actor, action and target.
 */
export function recordAudit(input: AuditInput): void {
  auditSequence += 1;
  const actor = db.users.find((user) => user.id === input.actorId);
  db.audit.push({
    // NOTE: Real audit ids are ULIDs and the log is ordered by id. "z" sorts after the
    // seeded ids and the padding keeps later records sorting later.
    id: `aud_z${String(auditSequence).padStart(8, "0")}`,
    workspace_id: input.workspaceId,
    actor_type: input.actorType,
    actor_id: input.actorId,
    actor_name: actor?.name ?? null,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    metadata: input.metadata ?? null,
    ip: null,
    created_at: Date.now(),
  });
}

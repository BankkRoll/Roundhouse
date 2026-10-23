/**
 * Audit-log vocabulary shared by the API (which writes entries) and the
 * dashboard (which labels them).
 *
 * - {@link AUDIT_ACTIONS}: every action the control plane records.
 * - {@link AUDIT_ACTOR_TYPES}: every kind of principal that can perform one.
 *
 * @module
 */

/**
 * Every action the control plane writes to the audit log. Shared so the API
 * can only record known actions and the dashboard must label every one of
 * them (a `Record<AuditAction, …>` fails to compile when one is missing).
 */
export const AUDIT_ACTIONS = [
  "instance.setup_completed",
  "workspace.created",
  "workspace.renamed",
  "member.role_changed",
  "member.removed",
  "member.left",
  "invite.created",
  "invite.revoked",
  "invite.accepted",
  "node.join_token_created",
  "node.joined",
  "node.removed",
  "node.went_offline",
  "project.created",
  "project.updated",
  "project.deleted",
  "service.created",
  "service.updated",
  "service.deleted",
  "variables.updated",
  "variables.revealed",
  "variables.resolved",
  "deployment.created",
  "deployment.rolled_back",
  "deployment.cancelled",
  "deployment.succeeded",
  "deployment.failed",
  "github.app_created",
  "github.installation_added",
  "github.installation_rejected",
  "instance.settings_updated",
  "token.created",
  "token.revoked",
] as const;

/** An audited action name. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Kinds of principal that can perform an audited action. */
export const AUDIT_ACTOR_TYPES = ["user", "token", "node", "system"] as const;

/** Who performed an audited action. */
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

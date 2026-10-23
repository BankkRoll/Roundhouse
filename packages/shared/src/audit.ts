/**
 * Audit-log vocabulary shared by the API (which writes entries) and the
 * dashboard (which labels them).
 *
 * - {@link AUDIT_ACTIONS}: every action the control plane records.
 * - {@link AUDIT_ACTOR_TYPES}: every kind of principal that can perform one.
 * - {@link INSTANCE_AUDIT_ACTIONS}: actions recorded without a workspace,
 *   visible to instance admins only.
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
  /** @deprecated Secrets are write-only since ADR 0014; kept so older entries still have a label. */
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
  "github.installation_released",
  "instance.settings_updated",
  "instance.admin_granted",
  "instance.admin_revoked",
  "instance.key_rotation_started",
  "instance.key_rotation_completed",
  "instance.key_rotation_failed",
  "token.created",
  "token.revoked",
  "workspace.access_settings_updated",
  "team.created",
  "team.updated",
  "team.deleted",
  "team.member_added",
  "team.member_removed",
  "access.granted",
  "access.changed",
  "access.revoked",
  "environment.protection_updated",
  "node.encryption_key_registered",
  "auth.sign_in_succeeded",
  "auth.sign_in_failed",
  "auth.account_locked",
  "auth.reauthenticated",
  "auth.two_factor_enabled",
  "auth.two_factor_disabled",
  "auth.backup_codes_regenerated",
  "auth.two_factor_failed",
  "auth.backup_code_used",
  "auth.two_factor_reset",
  "auth.account_unlocked",
  "auth.signed_out",
  "auth.session_revoked",
  "provider.connected",
  "provider.disconnected",
  "node.provision_requested",
  "node.provisioned",
  "node.provision_failed",
  "node.deprovisioned",
  "node.provision_cancelled",
  "invite.rejected_token",
  "domain.added",
  "domain.verified",
  "domain.failed",
  "domain.removed",
  "mcp_client.authorized",
  "mcp_client.revoked",
  "template.deployed",
  "change_set.created",
  "change_set.applied",
  "change_set.discarded",
] as const;

/** An audited action name. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Kinds of principal that can perform an audited action. */
export const AUDIT_ACTOR_TYPES = ["user", "token", "node", "system"] as const;

/** Who performed an audited action. */
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * Actions recorded with `workspace_id = NULL`: they concern the install or a
 * user account rather than one workspace, so only instance admins see them
 * (through `GET /v1/instance/audit`).
 */
export const INSTANCE_AUDIT_ACTIONS = [
  "instance.setup_completed",
  "instance.settings_updated",
  "instance.admin_granted",
  "instance.admin_revoked",
  "instance.key_rotation_started",
  "instance.key_rotation_completed",
  "instance.key_rotation_failed",
  "github.app_created",
  "auth.sign_in_succeeded",
  "auth.sign_in_failed",
  "auth.account_locked",
  "auth.reauthenticated",
  "auth.two_factor_enabled",
  "auth.two_factor_disabled",
  "auth.backup_codes_regenerated",
  "auth.two_factor_failed",
  "auth.backup_code_used",
  "auth.two_factor_reset",
  "auth.account_unlocked",
  "auth.signed_out",
  "auth.session_revoked",
  /** Recorded in the invite's workspace instead when the token matches an expired or used invite. */
  "invite.rejected_token",
] as const satisfies readonly AuditAction[];

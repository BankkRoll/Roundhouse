/**
 * Instance administration schemas (ADR 0014, finding F3): instance admins,
 * workspace creation, and the instance-level audit log. Owned by the
 * api-authz-rbac-github stream; re-exported from `../schemas`.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { AUDIT_ACTIONS, AUDIT_ACTOR_TYPES } from "@roundhouse/shared";

const Millis = z.number().int().openapi({ description: "Unix time in milliseconds" });

/** A user holding the instance-admin flag. */
export const InstanceAdminSchema = z
  .object({
    user_id: z.string(),
    name: z.string(),
    email: z.string(),
    two_factor_enabled: z.boolean(),
    created_at: Millis,
  })
  .openapi("InstanceAdmin");

/** Body of `PUT /v1/instance/admins/{userId}`: grant (`true`) or revoke (`false`). */
export const PutInstanceAdminBody = z
  .object({ instance_admin: z.boolean() })
  .openapi("PutInstanceAdmin");

/** One audit entry with its chain fields. */
export const ChainedAuditLogSchema = z
  .object({
    id: z.string(),
    seq: z.number().int().positive(),
    workspace_id: z.string().nullable(),
    actor_type: z.enum(AUDIT_ACTOR_TYPES),
    actor_id: z.string().nullable(),
    actor_name: z.string().nullable(),
    action: z.enum(AUDIT_ACTIONS),
    target_type: z.string().nullable(),
    target_id: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    ip: z.string().nullable(),
    created_at: Millis,
    /** `null` for entries before the chain, or not sealed yet. */
    prev_hash: z.string().nullable(),
    hash: z.string().nullable(),
  })
  .openapi("ChainedAuditLog");

/** Filters of `GET /v1/instance/audit-logs`. */
export const InstanceAuditQuery = z.object({
  /** `id` of the last entry of the previous page. */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Only this action. */
  action: z.enum(AUDIT_ACTIONS).optional(),
  /** Only entries by this actor (user, token, node). */
  actor_id: z.string().min(1).max(200).optional(),
  /** Only entries at or after this time (Unix ms). */
  since: z.coerce.number().int().nonnegative().optional(),
  /** Only entries before this time (Unix ms). */
  until: z.coerce.number().int().nonnegative().optional(),
});

/** A page of the instance audit log, newest first. */
export const InstanceAuditPageSchema = z
  .object({ entries: z.array(ChainedAuditLogSchema), next_cursor: z.string().nullable() })
  .openapi("InstanceAuditPage");

/** Result of verifying the audit chain. */
export const AuditChainVerificationSchema = z
  .object({
    ok: z.boolean(),
    /** Entries checked, from the first chained one to the head. */
    checked: z.number().int().nonnegative(),
    head_seq: z.number().int().nonnegative(),
    head_hash: z.string().nullable(),
    /** First entry whose hash or link doesn't match, when not `ok`. */
    broken_at_seq: z.number().int().positive().nullable(),
    /** Entries not sealed yet (sealed every minute). */
    unsealed: z.number().int().nonnegative(),
    /**
     * Head and checkpoints recorded outside the database (by the AuditChain
     * Durable Object) that were compared with the log; a rewrite that
     * recomputes every later hash still disagrees with them.
     */
    checkpoints: z.number().int().nonnegative(),
  })
  .openapi("AuditChainVerification");

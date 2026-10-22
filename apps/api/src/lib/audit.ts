/**
 * Writes to the append-only audit log, either on its own or as one statement
 * of a larger `db.batch` so an action and its audit record commit together.
 *
 * @module
 */
import { auditLogs, type Db } from "@openrail/db";
import { type AuditAction, type AuditActorType, newId } from "@openrail/shared";

/** One audited action. */
export interface AuditEntry {
  workspaceId: string | null;
  actorType: AuditActorType;
  actorId: string | null;
  /** Dotted verb, e.g. `node.joined`, `member.role_changed`. */
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Builds the insert for an audit record without running it, for use inside
 * `db.batch`. Never put secrets in `metadata`.
 *
 * @param db - Database client.
 * @param entry - What happened.
 * @returns An insert query to execute or batch.
 */
export function auditInsert(db: Db, entry: AuditEntry) {
  return db.insert(auditLogs).values({
    id: newId("auditLog"),
    workspaceId: entry.workspaceId,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? null,
    ip: entry.ip ?? null,
  });
}

/**
 * Appends an audit record. Never put secrets in `metadata`.
 *
 * @param db - Database client.
 * @param entry - What happened.
 */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await auditInsert(db, entry);
}

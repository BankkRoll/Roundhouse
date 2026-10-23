-- Hand-written (ADR 0014, product-owner decision 1 of 2026-10-23, and
-- "Audit log"). No schema change drizzle can express: a backfill and three
-- triggers, so there is no snapshot for this migration.

-- Existing production environments become protected on upgrade with the
-- default rules (`protection_rules` NULL = DEFAULT_PROTECTION_RULES). Rows
-- whose protection someone already configured (protected, or rules stored)
-- are left as they are.
UPDATE `environments`
SET `protected` = 1, `updated_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE lower(`name`) IN ('production', 'prod')
  AND `protected` = 0
  AND `protection_rules` IS NULL;--> statement-breakpoint

-- The audit log is append-only. These triggers guard against bugs; the hash
-- chain (sealed by the AuditChain Durable Object) is what detects tampering
-- by someone who can drop them.
CREATE TRIGGER `audit_logs_no_delete`
BEFORE DELETE ON `audit_logs`
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;--> statement-breakpoint

CREATE TRIGGER `audit_logs_sealed_immutable`
BEFORE UPDATE ON `audit_logs`
WHEN OLD.`hash` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'sealed audit entries are immutable');
END;--> statement-breakpoint

-- Sealing fills `prev_hash` and `hash` (and Drizzle may touch `updated_at`);
-- nothing else of an entry may change before it is sealed either.
CREATE TRIGGER `audit_logs_unsealed_content_fixed`
BEFORE UPDATE ON `audit_logs`
WHEN OLD.`hash` IS NULL AND (
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`seq` IS NOT OLD.`seq`
  OR NEW.`workspace_id` IS NOT OLD.`workspace_id`
  OR NEW.`actor_type` IS NOT OLD.`actor_type`
  OR NEW.`actor_id` IS NOT OLD.`actor_id`
  OR NEW.`action` IS NOT OLD.`action`
  OR NEW.`target_type` IS NOT OLD.`target_type`
  OR NEW.`target_id` IS NOT OLD.`target_id`
  OR NEW.`metadata` IS NOT OLD.`metadata`
  OR NEW.`ip` IS NOT OLD.`ip`
  OR NEW.`created_at` IS NOT OLD.`created_at`
)
BEGIN
  SELECT RAISE(ABORT, 'audit entries are immutable');
END;

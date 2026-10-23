CREATE TABLE `project_access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`user_id` text,
	`team_id` text,
	`role` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "project_access_grants_principal_ck" CHECK((principal_type = 'user' AND user_id IS NOT NULL AND team_id IS NULL) OR (principal_type = 'team' AND team_id IS NOT NULL AND user_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_access_grants_user_uq` ON `project_access_grants` (`project_id`,`user_id`) WHERE principal_type = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX `project_access_grants_team_uq` ON `project_access_grants` (`project_id`,`team_id`) WHERE principal_type = 'team';--> statement-breakpoint
CREATE INDEX `project_access_grants_user_idx` ON `project_access_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `project_access_grants_team_idx` ON `project_access_grants` (`team_id`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_failure_at` integer NOT NULL,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempts_last_failure_idx` ON `login_attempts` (`last_failure_at`);--> statement-breakpoint
CREATE TABLE `two_factors` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` text NOT NULL,
	`verified` integer DEFAULT true NOT NULL,
	`failed_verification_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `two_factors_user_id_idx` ON `two_factors` (`user_id`);--> statement-breakpoint
CREATE INDEX `two_factors_secret_idx` ON `two_factors` (`secret`);--> statement-breakpoint
CREATE TABLE `github_claim_states` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `github_claim_states_expires_idx` ON `github_claim_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_members_team_user_uq` ON `team_members` (`team_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `team_members_user_idx` ON `team_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_ws_slug_uq` ON `teams` (`workspace_id`,`slug`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`seq` integer NOT NULL,
	`prev_hash` text,
	`hash` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`metadata` text,
	`ip` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
-- Entries before the chain keep their order as seq and have no hash; the
-- AuditChain Durable Object starts the chain after the highest seq.
INSERT INTO `__new_audit_logs`("id", "workspace_id", "seq", "prev_hash", "hash", "actor_type", "actor_id", "action", "target_type", "target_id", "metadata", "ip", "created_at", "updated_at") SELECT "id", "workspace_id", ROW_NUMBER() OVER (ORDER BY "id"), NULL, NULL, "actor_type", "actor_id", "action", "target_type", "target_id", "metadata", "ip", "created_at", "updated_at" FROM `audit_logs`;--> statement-breakpoint
DROP TABLE `audit_logs`;--> statement-breakpoint
ALTER TABLE `__new_audit_logs` RENAME TO `audit_logs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_logs_seq_unique` ON `audit_logs` (`seq`);--> statement-breakpoint
CREATE INDEX `audit_logs_workspace_id_idx` ON `audit_logs` (`workspace_id`,`id`);--> statement-breakpoint
CREATE INDEX `audit_logs_action_idx` ON `audit_logs` (`action`,`id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `reauthenticated_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `instance_admin` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `two_factor_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `deployments` ADD `secret_keys` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `build_env_sealed` text;--> statement-breakpoint
ALTER TABLE `github_deliveries` ADD `body_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `github_deliveries_body_hash_unique` ON `github_deliveries` (`body_hash`);--> statement-breakpoint
ALTER TABLE `github_installations` ADD `account_id` integer;--> statement-breakpoint
ALTER TABLE `github_installations` ADD `claimed_by` text REFERENCES users(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `github_installations` ADD `claimed_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `encryption_public_key` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `encryption_key_id` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `encryption_key_registered_at` integer;--> statement-breakpoint
ALTER TABLE `environments` ADD `protected` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `environments` ADD `protection_rules` text;--> statement-breakpoint
ALTER TABLE `project_keys` ADD `kek_kid` text;--> statement-breakpoint
ALTER TABLE `project_keys` ADD `dek_id` text;--> statement-breakpoint
CREATE INDEX `project_keys_kek_kid_idx` ON `project_keys` (`kek_kid`);--> statement-breakpoint
ALTER TABLE `variables` ADD `tier` text DEFAULT 'plain' NOT NULL;--> statement-breakpoint
ALTER TABLE `variables` ADD `locked` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `variables` ADD `fingerprint` text;--> statement-breakpoint
ALTER TABLE `variables` ADD `updated_by` text REFERENCES users(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `variables` ADD `available_at_build` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `variables` ADD `mount_as_file` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `member_default_project_role` text DEFAULT 'developer' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `viewer_default_project_role` text DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
-- Backfill: secret flag becomes the tier, then the flag goes.
UPDATE `variables` SET `tier` = CASE WHEN `is_secret` THEN 'secret' ELSE 'plain' END;--> statement-breakpoint
ALTER TABLE `variables` DROP COLUMN `is_secret`;--> statement-breakpoint
-- Backfill: the instance admin is the user who completed setup, or else the
-- earliest owner of a live workspace (F3: owning any workspace no longer
-- grants instance:manage).
UPDATE `users` SET `instance_admin` = 1 WHERE `id` = COALESCE(
	(SELECT u.`id` FROM `audit_logs` a JOIN `users` u ON u.`id` = a.`actor_id` WHERE a.`action` = 'instance.setup_completed' AND a.`actor_type` = 'user' ORDER BY a.`seq` LIMIT 1),
	(SELECT m.`user_id` FROM `workspace_members` m JOIN `workspaces` w ON w.`id` = m.`workspace_id` WHERE m.`role` = 'owner' AND w.`deleted_at` IS NULL ORDER BY m.`created_at`, m.`id` LIMIT 1)
);--> statement-breakpoint
-- Backfill: existing claims predate the ownership check; record when they
-- were made so the dashboard can flag them (claimed_by stays NULL = legacy).
UPDATE `github_installations` SET `claimed_at` = `updated_at` WHERE `workspace_id` IS NOT NULL;

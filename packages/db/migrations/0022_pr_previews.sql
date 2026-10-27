-- Hand-written (ADR 0007, ADR 0014 section 14): pull request previews. Each
-- project's preview settings, one row per pull request and project, the
-- link from a preview environment to its preview, the retirement marker a
-- torn-down preview environment keeps until its volumes are gone, withheld
-- variable placeholders, and untrusted (fork) builds. Additive. No
-- snapshot: the next generated migration diffs against the schema source,
-- not this file.
CREATE TABLE `preview_settings` (
	`project_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`base_environment_id` text NOT NULL,
	`services` text,
	`ttl_hours` integer DEFAULT 72 NOT NULL,
	`max_active` integer DEFAULT 5 NOT NULL,
	`caps` text NOT NULL,
	`skip_drafts` integer DEFAULT true NOT NULL,
	`same_repo_secrets` text DEFAULT 'copy' NOT NULL,
	`fork_policy` text DEFAULT 'disabled' NOT NULL,
	`approval_label` text DEFAULT 'roundhouse:preview' NOT NULL,
	`database_seed` text DEFAULT 'empty' NOT NULL,
	`node_selector` text DEFAULT '{}' NOT NULL,
	`build_node_selector` text DEFAULT '{}' NOT NULL,
	`comment` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`base_environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `preview_environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text,
	`repo_full_name` text NOT NULL,
	`pr_number` integer NOT NULL,
	`installation_ref` text NOT NULL,
	`head_ref` text NOT NULL,
	`head_sha` text NOT NULL,
	`head_repo_full_name` text,
	`is_fork` integer NOT NULL,
	`withheld` integer DEFAULT false NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`author_login` text NOT NULL,
	`author_association` text NOT NULL,
	`draft` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`approved_sha` text,
	`approved_by_login` text,
	`github_comment_id` integer,
	`last_event_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`expires_at` integer,
	`closed_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preview_environments_pr_uq` ON `preview_environments` (`project_id`,`repo_full_name`,`pr_number`);--> statement-breakpoint
CREATE INDEX `preview_environments_expiry_idx` ON `preview_environments` (`expires_at`) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX `preview_environments_status_idx` ON `preview_environments` (`project_id`,`status`);--> statement-breakpoint
ALTER TABLE `environments` ADD `preview_id` text REFERENCES `preview_environments`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `environments` ADD `retired_at` integer;--> statement-breakpoint
ALTER TABLE `variables` ADD `withheld` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `builds` ADD `untrusted` integer DEFAULT false NOT NULL;

CREATE TABLE `change_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`is_draft` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`title` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_by_token` text,
	`approved_by` text,
	`approved_at` integer,
	`applied_by` text,
	`applied_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_token`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`applied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `change_sets_draft_uq` ON `change_sets` (`environment_id`) WHERE status IN ('open', 'applying') AND is_draft = 1;--> statement-breakpoint
CREATE INDEX `change_sets_env_status_idx` ON `change_sets` (`environment_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `change_sets_project_idx` ON `change_sets` (`project_id`,`id`);--> statement-breakpoint
CREATE TABLE `staged_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`change_set_id` text NOT NULL,
	`seq` integer NOT NULL,
	`target_key` text NOT NULL,
	`op` text NOT NULL,
	`value_sealed` text,
	`base` text NOT NULL,
	`diff` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`conflict` text,
	`result` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`change_set_id`) REFERENCES `change_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staged_changes_target_uq` ON `staged_changes` (`change_set_id`,`target_key`);--> statement-breakpoint
CREATE INDEX `staged_changes_set_seq_idx` ON `staged_changes` (`change_set_id`,`seq`);--> statement-breakpoint
CREATE TABLE `canvas_layouts` (
	`project_id` text PRIMARY KEY NOT NULL,
	`positions` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `deployments` ADD `change_set_id` text REFERENCES change_sets(id) ON DELETE set null;

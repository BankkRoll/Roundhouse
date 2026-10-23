CREATE TABLE `backup_parts` (
	`backup_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`etag` text NOT NULL,
	`size` integer NOT NULL,
	PRIMARY KEY(`backup_id`, `part_number`),
	FOREIGN KEY (`backup_id`) REFERENCES `backups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `backup_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`method` text NOT NULL,
	`schedule` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`keep_last` integer DEFAULT 7 NOT NULL,
	`max_age_days` integer,
	`quiesce` text DEFAULT 'none' NOT NULL,
	`databases` text,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_policies_svc_env_uq` ON `backup_policies` (`service_id`,`environment_id`);--> statement-breakpoint
CREATE INDEX `backup_policies_next_run_idx` ON `backup_policies` (`next_run_at`);--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`volume_id` text,
	`policy_id` text,
	`trigger` text NOT NULL,
	`scheduled_for` integer,
	`method` text NOT NULL,
	`engine` text,
	`engine_version` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`node_id` text,
	`object_key` text NOT NULL,
	`upload_id` text,
	`part_size_bytes` integer,
	`part_count` integer,
	`bytes_raw` integer,
	`bytes_stored` integer,
	`sha256` text,
	`pinned` integer DEFAULT false NOT NULL,
	`error` text,
	`requested_by` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`policy_id`) REFERENCES `backup_policies`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backups_policy_slot_uq` ON `backups` (`policy_id`,`scheduled_for`) WHERE policy_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `backups_svc_env_id_idx` ON `backups` (`service_id`,`environment_id`,`id`);--> statement-breakpoint
CREATE INDEX `backups_status_idx` ON `backups` (`status`);--> statement-breakpoint
CREATE TABLE `restores` (
	`id` text PRIMARY KEY NOT NULL,
	`backup_id` text NOT NULL,
	`mode` text NOT NULL,
	`target_service_id` text,
	`target_environment_id` text,
	`safety_backup_id` text,
	`node_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`requested_by` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`backup_id`) REFERENCES `backups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`safety_backup_id`) REFERENCES `backups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `restores_backup_idx` ON `restores` (`backup_id`);--> statement-breakpoint
CREATE INDEX `restores_target_idx` ON `restores` (`target_service_id`);--> statement-breakpoint
CREATE TABLE `volume_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`volume_id` text NOT NULL,
	`source_node_id` text,
	`target_node_id` text,
	`backup_id` text,
	`target_volume_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`requested_by` text,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`backup_id`) REFERENCES `backups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `volume_migrations_volume_idx` ON `volume_migrations` (`volume_id`);--> statement-breakpoint
CREATE TABLE `volumes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`service_id` text NOT NULL,
	`mount_path` text NOT NULL,
	`size_mb` integer NOT NULL,
	`node_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`quota_mode` text,
	`used_bytes` integer,
	`message` text,
	`reported_at` integer,
	`readonly_provisioned_at` integer,
	`delete_after` integer,
	`delete_sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `volumes_service_env_live_uq` ON `volumes` (`service_id`,`environment_id`) WHERE status NOT IN ('deleted', 'abandoned');--> statement-breakpoint
CREATE INDEX `volumes_node_idx` ON `volumes` (`node_id`,`status`);--> statement-breakpoint
CREATE INDEX `volumes_delete_after_idx` ON `volumes` (`status`,`delete_after`);--> statement-breakpoint
ALTER TABLE `project_keys` ADD `backup_recipient` text;--> statement-breakpoint
ALTER TABLE `project_keys` ADD `backup_identity_sealed` text;--> statement-breakpoint
ALTER TABLE `services` ADD `database_engine` text;--> statement-breakpoint
ALTER TABLE `services` ADD `database_version` text;